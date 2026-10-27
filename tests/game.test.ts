import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { DriftScore } from '../src/game/drift.ts';
import { StuntScore } from '../src/game/stunt.ts';
import { Race } from '../src/game/race.ts';
import { BIKE_DEFAULT_SETUP, bikePresetLabel } from '../src/game/bikeTuning.ts';
import { SURFACES, WET_GRIP, isWetRoad, setWetRoad, sprayActive, surfaceAt } from '../src/world/layout.ts';

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

test('the HUD names the preset only while the setup matches it', () => {
  assert.equal(bikePresetLabel(BIKE_DEFAULT_SETUP), 'Série');
  // Un seul choix qui s'écarte et le nom du preset devient faux : « perso ».
  assert.equal(bikePresetLabel({ ...BIKE_DEFAULT_SETUP, tires: 1 }), 'Réglage perso');
  assert.equal(
    bikePresetLabel({ engine: 1, gearing: 1, tires: 0, suspension: 1 }),
    'Stunt',
  );
});
