import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { DriftScore } from '../src/game/drift.ts';
import { StuntScore } from '../src/game/stunt.ts';
import { Race } from '../src/game/race.ts';
import { BIKE_DEFAULT_SETUP, bikePresetLabel } from '../src/game/bikeTuning.ts';
import { fadeGround } from '../src/world/circuit.ts';
// Le circuit est posé par world/circuit.ts au chargement : ces tests vérifient
// le contrat du layout (emprise, sol, revêtement), pas le chargement du GLB.
import {
  CIRCUIT,
  CIRCUIT_FADE,
  DIRT_TRACKS,
  MOUNTAIN_ROADS,
  SAMPLED_ROADS,
  SPAWN,
  SURFACES,
  WET_GRIP,
  WORLD_SIZE,
  circuitEdgeDistance,
  heightAt,
  isWetRoad,
  setWetRoad,
  terrainBaseHeight,
  sprayActive,
  surfaceAt,
} from '../src/world/layout.ts';
import { ReplayBuffer, samplePoses } from '../src/game/replay.ts';
import { planPuddles } from '../src/world/puddles.ts';

const pose = (x: number) => ({ x, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 });

test('the replay memory keeps only the most recent poses', () => {
  const buffer = new ReplayBuffer(10, 1);
  for (let i = 0; i < 40; i++) buffer.record(pose(i), i);
  assert.equal(buffer.frames, 10);
  assert.equal(buffer.full, true);
  const poses = buffer.snapshot();
  assert.equal(poses[0].x, 30);
  assert.equal(poses[poses.length - 1].x, 39);
  // A long session costs what the capacity says, not what was driven.
  assert.ok(buffer.duration <= 9, `duration=${buffer.duration}`);
});

test('the replay records at its own cadence and hands out copies', () => {
  const buffer = new ReplayBuffer(100, 0.1);
  assert.equal(buffer.record(pose(0), 0), true);
  assert.equal(buffer.record(pose(1), 0.05), false);
  assert.equal(buffer.record(pose(2), 0.1), true);
  assert.equal(buffer.frames, 2);
  const poses = buffer.snapshot();
  poses[0].x = 999;
  assert.equal(buffer.snapshot()[0].x, 0);
  buffer.reset();
  assert.equal(buffer.frames, 0);
  assert.equal(buffer.duration, 0);
});

test('playback carries the recorded velocity, so a rewind resumes at speed', () => {
  const buffer = new ReplayBuffer(10, 0.1);
  buffer.record({ ...pose(0), vx: 20, vy: 0, vz: 2 }, 0);
  buffer.record({ ...pose(10), vx: 20, vy: 0, vz: 2 }, 1);
  const mid = samplePoses(buffer.snapshot(), 0.5);
  assert.ok(mid);
  assert.ok(Math.abs((mid.vx ?? 0) - 20) < 1e-9, `vx=${mid.vx}`);
  assert.ok(Math.abs((mid.vz ?? 0) - 2) < 1e-9, `vz=${mid.vz}`);
  assert.equal(mid.x, 5);
});

test('puddles are planned on the tarmac, deterministically', () => {
  const spots = planPuddles(40);
  assert.ok(spots.length > 0 && spots.length <= 40, `count=${spots.length}`);
  for (const spot of spots) {
    assert.equal(surfaceAt(spot.x, spot.z).kind, 'asphalte', `${spot.x},${spot.z}`);
    assert.ok(spot.sx > 0.4 && spot.sz > 0.3);
  }
  // Same seed, same puddles: screenshots stay comparable between runs.
  assert.deepEqual(planPuddles(40), spots);
});

test('a rewind truncates the memory and recording continues from there', () => {
  const buffer = new ReplayBuffer(50, 0.1);
  for (let i = 0; i < 10; i++) buffer.record(pose(i), i * 0.5);
  const cut = buffer.snapshot()[3].t;
  buffer.truncate(cut, 100);
  assert.equal(buffer.frames, 4);
  // The next frame must not be dropped just because time stood still.
  assert.equal(buffer.record(pose(99), 100.05), true);
  const after = buffer.snapshot();
  assert.equal(after[4].x, 99);
  assert.ok(Math.abs(after[4].t - (cut + 0.05)) < 1e-9, `t=${after[4].t}`);
});

test('playback interpolates between poses and clamps the ends', () => {
  assert.equal(samplePoses([], 1), null);
  const poses = [
    { ...pose(0), t: 0 },
    { ...pose(10), t: 2, qy: 1, qw: 0 },
  ];
  const mid = samplePoses(poses, 1);
  assert.ok(mid);
  assert.equal(mid.x, 5);
  // Half of a 180° yaw is 90°, on a unit quaternion.
  assert.ok(Math.abs(mid.qy - Math.SQRT1_2) < 1e-6, `qy=${mid.qy}`);
  assert.ok(Math.abs(Math.hypot(mid.qx, mid.qy, mid.qz, mid.qw) - 1) < 1e-9);
  assert.equal(samplePoses(poses, -3)?.x, 0);
  assert.equal(samplePoses(poses, 99)?.x, 10);
});

test('wet road lowers grip on every surface, stays dry by default', () => {
  assert.equal(isWetRoad(), false);
  const dry = surfaceAt(0, 0);
  setWetRoad(true);
  try {
    assert.equal(isWetRoad(), true);
    const wetAsphalt = SURFACES.asphalte.grip * WET_GRIP;
    const wetLoose = SURFACES.terre.grip * WET_GRIP;
    assert.ok(wetAsphalt < SURFACES.asphalte.grip);
    assert.ok(wetLoose < SURFACES.terre.grip);
    assert.ok(surfaceAt(0, 0).grip <= dry.grip);
  } finally {
    setWetRoad(false);
  }
});

test('wet surface lookups reuse one object instead of allocating', () => {
  setWetRoad(true);
  try {
    const first = surfaceAt(0, 0);
    const second = surfaceAt(0, 0);
    // The physics asks for this per wheel contact at 120 Hz: same reference.
    assert.equal(first, second);
    assert.equal(first.grip, SURFACES[first.kind].grip * WET_GRIP);
  } finally {
    setWetRoad(false);
  }
  // Dry lookups keep pointing at the shared table too.
  assert.equal(surfaceAt(0, 0), surfaceAt(0, 0));
});

test('rear spray only on a moving wheel in contact on a wet road', () => {
  setWetRoad(false);
  assert.equal(sprayActive(10, true), false);
  setWetRoad(true);
  try {
    assert.equal(sprayActive(10, true), true);
    assert.equal(sprayActive(10, false), false);
    assert.equal(sprayActive(0.5, true), false);
  } finally {
    setWetRoad(false);
  }
});

test('drift score grows with speed and slip, then banks', () => {
  const drift = new DriftScore();
  let banked = 0;
  for (let i = 0; i < 180; i++) {
    const event = drift.update(1 / 60, 25, 0.35, true, false);
    banked += event.banked;
  }
  assert.ok(drift.pending > 200, `pending ${drift.pending.toFixed(0)}`);
  assert.ok(drift.multiplier > 1, `multiplier ${drift.multiplier}`);
  assert.ok(drift.active);

  // Straighten up: the score banks after the grace period.
  for (let i = 0; i < 90; i++) {
    const event = drift.update(1 / 60, 25, 0.02, true, false);
    banked += event.banked;
  }
  assert.ok(banked > 200, `banked ${banked}`);
  assert.equal(drift.pending, 0);
  assert.equal(drift.total, banked);
  assert.equal(drift.multiplier, 1);
});

test('drift score ignores slow driving and loses the combo on a crash', () => {
  const drift = new DriftScore();
  drift.update(1 / 60, 3, 0.5, true, false);
  assert.equal(drift.pending, 0, 'slow car should not score');

  for (let i = 0; i < 240; i++) drift.update(1 / 60, 30, 0.4, true, false);
  assert.ok(drift.pending > 150, `pending ${drift.pending.toFixed(0)}`);
  const crash = drift.update(1 / 60, 2, 0.4, true, true);
  assert.ok(crash.lost);
  assert.equal(drift.pending, 0);
  assert.equal(drift.total, 0);
});

test('wheelies bank points, and a bavette pays a bonus', () => {
  const stunt = new StuntScore();
  let banked = 0;
  for (let i = 0; i < 180; i++) {
    const event = stunt.update(1 / 60, 1.05, 22, true, false);
    banked += event.banked;
  }
  assert.ok(stunt.pending > 250, `pending ${stunt.pending.toFixed(0)}`);
  assert.ok(stunt.deep, '57° should count as a bavette');
  assert.ok(stunt.multiplier > 1, `multiplier ${stunt.multiplier}`);
  assert.ok(stunt.active);

  for (let i = 0; i < 60; i++) {
    const event = stunt.update(1 / 60, 0.02, 22, true, false);
    banked += event.banked;
  }
  assert.ok(banked > 250, `banked ${banked}`);
  assert.equal(stunt.pending, 0);
  assert.equal(stunt.total, banked);
  assert.equal(stunt.multiplier, 1);
});

test('a crash loses the wheelie, and slow riding scores nothing', () => {
  const stunt = new StuntScore();
  for (let i = 0; i < 150; i++) stunt.update(1 / 60, 0.8, 18, true, false);
  assert.ok(stunt.pending > 100, `pending ${stunt.pending.toFixed(0)}`);
  const crash = stunt.update(1 / 60, 0.8, 18, true, true);
  assert.ok(crash.lost);
  assert.equal(stunt.pending, 0);
  assert.equal(stunt.total, 0);

  stunt.reset();
  for (let i = 0; i < 120; i++) stunt.update(1 / 60, 0.5, 1.5, true, false);
  assert.equal(stunt.pending, 0, 'a walking-pace wheelie should not score');
});

function makeCheckpoints(): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2;
    out.push(new THREE.Vector3(Math.cos(angle) * 100, 0, Math.sin(angle) * 100));
  }
  return out;
}

test('race counts down, then requires checkpoints in order', () => {
  const race = new Race(makeCheckpoints(), 12);
  const car = new THREE.Vector3(100, 0, 0);
  assert.ok(race.locked, 'car must be locked during the countdown');

  let go = false;
  for (let i = 0; i < 300; i++) {
    const event = race.update(1 / 60, car);
    if (event === 'go') go = true;
  }
  assert.ok(go, 'countdown should end with a go');
  assert.equal(race.phase, 'running');
  assert.ok(!race.locked);

  // Teleporting on top of the start line must not count a lap.
  race.update(1 / 60, car);
  assert.equal(race.lap, 1);
  assert.equal(race.next, 1);

  // Drive through every checkpoint in order.
  const checkpoints = makeCheckpoints();
  for (let lap = 0; lap < 2; lap++) {
    for (let i = 1; i < checkpoints.length; i++) {
      race.update(1 / 60, checkpoints[i]);
      assert.equal(race.next, (i + 1) % checkpoints.length, `after checkpoint ${i}`);
    }
    race.update(1 / 60, checkpoints[0]);
  }

  assert.equal(race.phase, 'finished');
  assert.ok(race.lastLap > 0);
  assert.ok(race.bestLap !== null);
});

test('race formatTime prints minute:second.hundredths', () => {
  assert.equal(Race.formatTime(0), '0:00.00');
  assert.equal(Race.formatTime(61.239), '1:01.23');
  assert.equal(Race.formatTime(null), '—');
});

test('the circuit fits in the world, clear of every road', () => {
  const halfX = CIRCUIT.plateHalfX * CIRCUIT.scale;
  const halfZ = CIRCUIT.plateHalfZ * CIRCUIT.scale;
  // L'emprise tient dans le monde, avec la pente qui la raccorde au terrain.
  assert.ok(Math.abs(CIRCUIT.cx) + halfX + CIRCUIT_FADE < WORLD_SIZE / 2, 'emprise trop à l\u2019est');
  assert.ok(Math.abs(CIRCUIT.cz) + halfZ + CIRCUIT_FADE < WORLD_SIZE / 2, 'emprise trop au nord ou au sud');
  // Aucune route du jeu ne traverse la piste : une rue qui passe sous la dalle
  // ressortirait à travers l'asphalte du circuit.
  for (const road of [...SAMPLED_ROADS, ...MOUNTAIN_ROADS, ...DIRT_TRACKS]) {
    for (const sample of road.samples) {
      const edge = circuitEdgeDistance(sample.x, sample.z);
      assert.ok(edge > 12, `${road.def.id} passe à ${edge.toFixed(1)} m de l'emprise`);
    }
  }
  // Le centre de l'emprise est bien à l'intérieur, et loin du bord.
  assert.ok(circuitEdgeDistance(CIRCUIT.cx, CIRCUIT.cz) < -100);
});

test('the circuit ground wins inside its footprint, the map is untouched outside', () => {
  const saved = CIRCUIT.ground;
  const inside = CIRCUIT.cx + (CIRCUIT.plateHalfX - 80) * CIRCUIT.scale;
  try {
    CIRCUIT.ground = (x, z) => (circuitEdgeDistance(x, z) < 0 ? 120 : null);
    assert.equal(heightAt(CIRCUIT.cx, CIRCUIT.cz), 120);
    assert.equal(heightAt(inside, CIRCUIT.cz), 120);

    // Hors de la dalle, la hauteur de jeu n'est pas touchée du tout.
    const edgeX = CIRCUIT.cx + CIRCUIT.plateHalfX * CIRCUIT.scale;
    for (const x of [edgeX + 1, edgeX + 200, edgeX + 600]) {
      assert.equal(heightAt(x, CIRCUIT.cz), terrainBaseHeight(x, CIRCUIT.cz));
    }
  } finally {
    CIRCUIT.ground = saved;
  }
});

test('the circuit slab fades into the ground instead of ending on a cliff', () => {
  // Le bord de la dalle, puis le terrain à CIRCUIT_FADE mètres : entre les deux
  // le talus descend sans se casser, et au-delà c'est le terrain qui gagne.
  const plate = 40;
  const base = 5;
  assert.equal(fadeGround(plate, base, 0), plate);
  assert.equal(fadeGround(plate, base, CIRCUIT_FADE), base);
  assert.equal(fadeGround(plate, base, CIRCUIT_FADE * 4), base);
  assert.ok(Math.abs(fadeGround(plate, base, CIRCUIT_FADE / 2) - (plate + base) / 2) < 1e-9);
  let previous = plate;
  for (let d = 0; d <= CIRCUIT_FADE; d += CIRCUIT_FADE / 12) {
    const value = fadeGround(plate, base, d);
    assert.ok(value <= previous + 1e-9, `le talus remonte à ${d} m`);
    previous = value;
  }
});

test('the wheels read the circuit surface where the model covers the ground', () => {
  const saved = CIRCUIT.surface;
  try {
    CIRCUIT.surface = (x, z) => (circuitEdgeDistance(x, z) < 0 ? 'asphalte' : null);
    assert.equal(surfaceAt(CIRCUIT.cx, CIRCUIT.cz).kind, 'asphalte');
    // Hors emprise le circuit ne dit rien : la ville reste sur son bitume.
    assert.equal(surfaceAt(SPAWN.x, SPAWN.z).kind, 'asphalte');
  } finally {
    CIRCUIT.surface = saved;
  }
});

test('the HUD names the preset only while the setup matches it', () => {
  assert.equal(bikePresetLabel(BIKE_DEFAULT_SETUP), 'Série');
  // Un seul choix qui s'écarte et le nom du preset devient faux : « perso ».
  assert.equal(bikePresetLabel({ ...BIKE_DEFAULT_SETUP, tires: 1 }), 'Réglage perso');
  assert.equal(
    bikePresetLabel({ engine: 1, gearing: 1, tires: 0, suspension: 1 }),
    'Stunt',
  );
});
