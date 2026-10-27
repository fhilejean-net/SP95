import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { DriftScore } from '../src/game/drift.ts';
import { StuntScore } from '../src/game/stunt.ts';
import { Race } from '../src/game/race.ts';
import { BIKE_DEFAULT_SETUP, bikePresetLabel } from '../src/game/bikeTuning.ts';
import { fadeGround, trackUv } from '../src/world/circuit.ts';
import { MAP_ID, mapFromSearch, mapUrl } from '../src/game/maps.ts';
import { CARS } from '../src/game/cars.ts';
import { pickWheels } from '../src/render/wheels.ts';
// Le circuit est posé par world/circuit.ts au chargement : ces tests vérifient
// le contrat des cartes (emprise, sol, revêtement), pas le chargement du GLB.
import {
  CIRCUIT,
  CIRCUIT_FADE,
  SPAWN,
  SURFACES,
  TERRAIN_SPAN,
  WET_GRIP,
  WORLD_SIZE,
  borderHeight,
  circuitEdgeDistance,
  circuitPlacement,
  heightAt,
  isWetRoad,
  setWetRoad,
  terrainBaseHeight,
  terrainSegmentsFor,
  sprayActive,
  surfaceAt,
  villageFeaturesOn,
  worldSizeFor,
} from '../src/world/layout.ts';
import { ReplayBuffer, samplePoses } from '../src/game/replay.ts';
import { Chrono, formatLap } from '../src/game/chrono.ts';
import { DEFAULT_SETUP, PRESETS, describeSetup, resolveSpec } from '../src/game/tuning.ts';
import { planPuddles } from '../src/world/puddles.ts';

const pose = (x: number) => ({ x, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 });

/** Coin sud-ouest de la ville, là où le col s'arrête. */
const MASSIF_CORNER = { x: -480, z: -420 };

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

test('the circuit lives on its own map, not in the city world', () => {
  // La ville ne réserve plus rien pour la piste : ni dalle, ni emprise, ni
  // revêtement, et ses rues n'ont plus rien à contourner.
  const ville = circuitPlacement('ville');
  assert.equal(ville.active, false);
  assert.equal(ville.plateHalfX, 0);
  assert.equal(villageFeaturesOn('ville'), true);
  assert.equal(villageFeaturesOn('suzuka'), false);

  // Le circuit a sa carte : sa dalle tient dans le monde, talus compris.
  const suzuka = circuitPlacement('suzuka');
  assert.ok(suzuka.active);
  const halfX = suzuka.plateHalfX * suzuka.scale;
  const halfZ = suzuka.plateHalfZ * suzuka.scale;
  const size = worldSizeFor('suzuka');
  assert.ok(Math.abs(suzuka.cx) + halfX + CIRCUIT_FADE < size / 2, 'emprise trop à l\u2019est');
  assert.ok(Math.abs(suzuka.cz) + halfZ + CIRCUIT_FADE < size / 2, 'emprise trop au nord ou au sud');
  // Sa maille de terrain reste fine (~6 m) malgré un monde aussi large, et la
  // carte laisse une marge derrière le talus.
  assert.ok(size / terrainSegmentsFor('suzuka') < 6);
  assert.ok(size > 2 * (halfZ + CIRCUIT_FADE), 'marge trop courte au nord ou au sud');
});

test('the city map ignores the circuit slab and its surface', () => {
  // Ces tests tournent sans URL : la carte par défaut est la ville.
  assert.equal(MAP_ID, 'ville');
  assert.equal(CIRCUIT.active, false);
  // Il n'y a plus d'emprise à contourner : rien n'est exclu de la ville.
  assert.equal(circuitEdgeDistance(0, 0), Infinity);
  assert.equal(circuitEdgeDistance(MASSIF_CORNER.x, MASSIF_CORNER.z), Infinity);

  const savedGround = CIRCUIT.ground;
  const savedSurface = CIRCUIT.surface;
  try {
    // Même posée de force, une dalle ne touche pas la hauteur de jeu...
    CIRCUIT.ground = () => 120;
    assert.equal(heightAt(0, 0), terrainBaseHeight(0, 0));
    // ...ni un revêtement de piste la surface sous les roues.
    CIRCUIT.surface = () => 'terre';
    assert.equal(surfaceAt(SPAWN.x, SPAWN.z).kind, 'asphalte');
  } finally {
    CIRCUIT.ground = savedGround;
    CIRCUIT.surface = savedSurface;
  }
});

test('the world ends on a rock ramp instead of a hole', () => {
  const half = WORLD_SIZE / 2;
  // Dans le monde jouable, la barrière ne touche rien.
  for (const [x, z] of [[0, 0], [half - 1, 3], [-3, -(half - 1)]]) {
    assert.equal(borderHeight(x, z), 0, `barrière en ${x},${z}`);
  }
  // Puis elle monte sans jamais redescendre, jusqu'au bord de la grille.
  let previous = 0;
  for (let r = half; r <= TERRAIN_SPAN / 2; r += 5) {
    const h = borderHeight(0, r);
    assert.ok(h >= previous, `la barrière redescend à ${r} m`);
    previous = h;
  }
  assert.ok(borderHeight(0, TERRAIN_SPAN / 2) >= 90, `${borderHeight(0, TERRAIN_SPAN / 2)} m`);
  // Et c'est le terrain de jeu lui-même qui la porte : c'est son trimesh qui
  // arrête la voiture, pas un collider à part (voir le commentaire du module).
  assert.ok(TERRAIN_SPAN > WORLD_SIZE);
  assert.ok(heightAt(0, half + 40) > heightAt(0, half - 40) + 10);
});

test('the map is chosen in the URL, and the switch keeps the rest', () => {
  assert.equal(mapFromSearch(''), 'ville');
  assert.equal(mapFromSearch('?fx=low'), 'ville');
  assert.equal(mapFromSearch('?map=inconnue'), 'ville');
  assert.equal(mapFromSearch('?map=suzuka'), 'suzuka');

  const href = 'https://sp95.test/?fx=low';
  const suzuka = mapUrl('suzuka', href);
  assert.equal(new URL(suzuka).searchParams.get('map'), 'suzuka');
  // Le reste de l'URL suit : `?fx=low` ne se perd pas en changeant de carte.
  assert.equal(new URL(suzuka).searchParams.get('fx'), 'low');
  assert.equal(new URL(mapUrl('ville', suzuka)).searchParams.has('map'), false);
});

test('les slicks de course collent plus que la monte de route', () => {
  const car = CARS.find((entry) => entry.id === 'apollo')!;
  const road = resolveSpec({ ...DEFAULT_SETUP, tires: 0 }, car.spec);
  const slicks = resolveSpec({ ...DEFAULT_SETUP, tires: 4 }, car.spec);
  assert.ok(slicks.muFront > road.muFront * 1.3, `slick ${slicks.muFront} contre ${road.muFront}`);
  assert.ok(slicks.muRear > road.muRear * 1.3, `slick ${slicks.muRear} contre ${road.muRear}`);
  // Plus de grip, mais une pente de glisse plus raide : ça prévient tard, et
  // ça décroche d'un coup.
  assert.ok(slicks.peakSlipAngle < road.peakSlipAngle);
  // Hors de l'asphalte, la gomme tendre ne sert plus à rien.
  assert.ok(slicks.looseGrip < road.looseGrip);
  assert.equal(describeSetup({ ...DEFAULT_SETUP, tires: 4 }, car.spec).grip, 'Slick de course');
});

test('le réglage Chrono monte les slicks, et chaque voiture annonce sa transmission', () => {
  const chrono = PRESETS.find((preset) => preset.label === 'Chrono');
  assert.ok(chrono, 'le preset Chrono doit exister');
  assert.equal(chrono!.setup.tires, 4, 'le preset Chrono roule en slicks');
  const drive = (id: string) =>
    describeSetup(DEFAULT_SETUP, CARS.find((entry) => entry.id === id)!.spec).drive;
  assert.equal(drive('gt40'), 'Propulsion');
  assert.equal(drive('apollo'), 'Propulsion');
  assert.equal(drive('fk8'), 'Traction');
  assert.equal(drive('rs7'), 'Intégrale');
  assert.equal(drive('yaris'), 'Intégrale');
});

test('le chrono compte un tour au franchissement de la ligne, et rien dautre', () => {
  const line = { x: 0, z: 0, heading: 0 };
  const run = (
    instance: Chrono,
    from: number,
    to: number,
    speed = 30,
    x = 0,
    dt = 0.1,
  ) => {
    const events: string[] = [];
    const step = to < from ? -4 : 4;
    for (let z = from; step < 0 ? z >= to : z <= to; z += step) {
      const event = instance.update(dt, x, z, speed);
      if (event) events.push(event);
    }
    return events;
  };

  const chrono = new Chrono(line, null);
  // Départ arrêté derrière la ligne : le premier passage lance le chrono.
  assert.deepEqual(run(chrono, 20, -8), ['start']);
  assert.equal(chrono.armed, true);
  assert.equal(chrono.lap, 1);
  // Le chrono démarre au franchissement : le tour en cours part de zéro.
  assert.ok(chrono.current <= 0.25, `tour lancé à ${chrono.current}s`);

  // Un tour : on repart loin devant, on revient derrière la ligne, on la
  // repasse dans le bon sens.
  assert.deepEqual(run(chrono, -8, -80), [], 'aucun tour tant quon ne repasse pas la ligne');
  assert.deepEqual(run(chrono, -80, 20), [], 'franchir la ligne à contresens ne compte pas');
  assert.deepEqual(run(chrono, 20, -8), ['lap']);
  assert.equal(chrono.lap, 2);
  assert.ok(chrono.last > 0, 'le tour doit avoir un temps');
  assert.equal(chrono.best, chrono.last, 'le premier tour est la référence');
  assert.ok(chrono.current < chrono.last, 'le tour suivant repart de zéro');

  // À l'arrêt, la ligne ne compte pas : ni poussée, ni remorquée.
  const stopped = new Chrono(line, null);
  assert.deepEqual(run(stopped, 20, -8, 0), []);
  assert.equal(stopped.armed, false);

  // À trente mètres sur le côté — un autre morceau de piste —, rien non plus.
  const aside = new Chrono(line, null);
  assert.deepEqual(run(aside, 20, -80, 30, 30), []);

  assert.equal(formatLap(92.34), '1:32.34');
  assert.equal(formatLap(7.5), '0:07.50');
});

test('the wheels of an unnamed model are found by shape, and named ones win', () => {
  const body = {
    min: [-0.95, 0, -2.3] as [number, number, number],
    max: [0.95, 1.3, 2.3] as [number, number, number],
  };
  const wheel = (x: number, z: number, name: string, half = 0.32) => ({
    name,
    box: {
      min: [x - 0.11, 0, z - half] as [number, number, number],
      max: [x + 0.11, half * 2, z + half] as [number, number, number],
    },
  });

  // Noms anonymes (Object_14…) : la forme et la position suffisent.
  const picks = pickWheels(
    [
      wheel(-0.78, -1.4, 'Object_14'),
      wheel(0.78, -1.4, 'Object_23'),
      wheel(-0.8, 1.35, 'Object_41'),
      wheel(1.42, 1.35, 'Object_57'),
    ],
    body,
  );
  assert.ok(picks, 'quatre roues rondes et basses doivent être trouvées');
  const corners = picks!.map((pick) => pick.corner);
  assert.deepEqual(corners, [0, 1, 2, 3]);
  assert.ok(Math.abs(picks![0].hub[0] + 0.78) < 0.01 && Math.abs(picks![0].hub[2] + 1.4) < 0.01);
  assert.ok(Math.abs(picks![0].radius - 0.32) < 0.01, `rayon ${picks![0].radius}`);

  // Trois roues sur quatre : on refuse, la voiture de secours prend le relais.
  assert.equal(
    pickWheels([wheel(-0.78, -1.4, 'a'), wheel(0.78, -1.4, 'b'), wheel(-0.8, 1.35, 'c')], body),
    null,
  );
  // Un garde-boue plus gros que le pneu ne doit pas voler la place de la roue
  // avant droite : le miroir des trois autres coins recale le quatrième.
  const withFender = pickWheels(
    [
      wheel(-0.78, -1.4, 'Object_14'),
      wheel(0.78, -1.4, 'Object_23'),
      wheel(-0.8, 1.35, 'Object_41'),
      wheel(1.42, 1.35, 'Object_57'),
      {
        name: 'Object_88',
        box: { min: [0.3, 0.05, -1.9], max: [1.0, 0.55, -1.0] },
      },
    ],
    body,
  );
  assert.ok(withFender, 'un garde-boue de plus ne doit pas empêcher la détection');
  const frontRight = withFender!.find((pick) => pick.corner === 1)!;
  assert.ok(
    Math.abs(frontRight.hub[0] - 0.78) < 0.01 && Math.abs(frontRight.hub[2] + 1.4) < 0.01,
    `moyeu avant droit à ${frontRight.hub.map((v) => v.toFixed(2)).join(',')}`,
  );
  assert.ok(Math.abs(frontRight.radius - 0.32) < 0.02, `rayon ${frontRight.radius}`);

  // Un nom qui sent la roue passe avant une forme plausible : le rétroviseur
  // rond de 25 cm ne doit pas voler la place du pneu.
  const named = pickWheels(
    [
      wheel(-0.78, -1.4, 'rim_FL'),
      wheel(0.78, -1.4, 'rim_FR'),
      wheel(-0.8, 1.35, 'rim_RL'),
      wheel(0.8, 1.35, 'rim_RR'),
      { name: 'mirror_L', box: { min: [-1.1, 0.9, -0.9], max: [-0.85, 1.15, -0.65] } },
    ],
    body,
  );
  assert.ok(named);
  assert.ok(Math.abs(named![0].radius - 0.32) < 0.01, `rayon ${named![0].radius}`);
});

test('every car in the registry loads its own model, and ids stay unique', () => {
  const ids = new Set(CARS.map((car) => car.id));
  assert.equal(ids.size, CARS.length, 'deux voitures partagent un id');
  for (const car of CARS) {
    assert.ok(car.model.endsWith('.glb'), `${car.id} : modèle manquant`);
    assert.ok(car.label.length > 2 && car.detail.length > 2, `${car.id} : libellé trop court`);
    assert.ok(car.spec.wheelbase > 1.8 && car.spec.mass > 600, `${car.id} : specs invraisemblables`);
  }
  assert.ok(CARS.length >= 10, `${CARS.length} voitures au registre`);
  // Les modèles arrivent d'ateliers différents : chaque voiture doit dire dans
  // quel sens elle roule (0 quand le nez regarde déjà le -Z du jeu).
  for (const car of CARS) assert.ok(Number.isFinite(car.yaw) && Math.abs(car.yaw) <= Math.PI + 1e-6, `${car.id} : orientation invalide`);
});

test('the track paints its asphalt from world coordinates, so its tiles join', () => {
  // Le modèle est une mosaïque de tuiles photo (ROAD01…ROAD07, ROADX, PITROAD)
  // dont les gris ne se raccordent pas. La trame est maintenant prise dans le
  // monde : deux primitives voisines tombent sur la même répétition et le
  // raccord disparaît.
  assert.deepEqual(trackUv(12, -6, 6), [2, -1]);
  // Une tuile fait 6 m : avancer d'une tuile ramène exactement sur la même image
  // (à l'arrondi flottant près).
  assert.ok(Math.abs(trackUv(6.5, 0, 6)[0] - trackUv(0.5, 0, 6)[0] - 1) < 1e-9);
  // La trame est continue : pas de saut d'un maillage à l'autre.
  assert.ok(Math.abs(trackUv(3, 0, 6)[0] - trackUv(3.001, 0, 6)[0]) < 0.001);
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

test('the wheels still read the city asphalt', () => {
  assert.equal(surfaceAt(SPAWN.x, SPAWN.z).kind, 'asphalte');
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
