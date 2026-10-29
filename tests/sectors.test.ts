import test from 'node:test';
import assert from 'node:assert/strict';
import { SECTOR_COUNT, SectorTimer, formatDelta } from '../src/game/sectors.ts';
import {
  PIT_LANE_X,
  PIT_THROATS,
  PIT_WALL_OUTER,
  insidePit,
  pitWallGap,
  stallCentre,
} from '../src/world/pitLayout.ts';

/** Un tour de 3 000 m : frontières à 1 000 et 2 000 m. */
function lap(timer: SectorTimer, first: number, second: number, third: number): void {
  timer.arm();
  timer.update(first / 2, 400);
  timer.update(first / 2, 1000);
  timer.update(second / 2, 1500);
  timer.update(second / 2, 2000);
  timer.update(0, 2400);
  timer.completeLap(first + second + third);
}

test('un tour se découpe en trois secteurs dont la somme fait le tour', () => {
  const timer = new SectorTimer(3000, null);
  timer.arm();
  timer.update(15, 500);
  timer.update(15, 1000);
  timer.update(16, 1500);
  timer.update(15, 2000);
  timer.update(10, 2400);

  let snapshot = timer.snapshot();
  assert.equal(snapshot.count, SECTOR_COUNT);
  assert.equal(snapshot.running, 2);
  assert.equal(Number(snapshot.splits[0]!.time.toFixed(3)), 30);
  assert.equal(Number(snapshot.splits[1]!.time.toFixed(3)), 31);
  assert.equal(Number(snapshot.partial.toFixed(3)), 10);

  timer.completeLap(90);
  snapshot = timer.snapshot();
  const total = snapshot.splits.reduce((sum, split) => sum + (split?.time ?? 0), 0);
  assert.equal(Number(total.toFixed(6)), 90);
  assert.equal(Number(snapshot.splits[2]!.time.toFixed(3)), 29);
  assert.equal(snapshot.running, -1);
});

test('les écarts se comparent au meilleur tour, en vert ou en rouge', () => {
  const timer = new SectorTimer(3000, null);
  lap(timer, 30, 31, 29);
  let snapshot = timer.snapshot();
  assert.equal(snapshot.reference, 90);
  assert.equal(snapshot.splits[0]!.delta, 0);

  // Un tour plus rapide de 1 s par secteur devient la référence.
  lap(timer, 29, 30, 28);
  snapshot = timer.snapshot();
  assert.equal(snapshot.reference, 87);
  assert.equal(Number(snapshot.splits[0]!.delta!.toFixed(3)), 0);

  // Le tour suivant perd 2 s par secteur.
  lap(timer, 31, 32, 30);
  snapshot = timer.snapshot();
  for (const split of snapshot.splits) {
    assert.equal(Number(split!.delta!.toFixed(3)), 2);
  }
  assert.equal(formatDelta(2), '+2.000');
  assert.equal(formatDelta(-0.324), '−0.324');
});

test('la voie des stands est derrière le muret et roulable', () => {
  // La voie est entièrement du côté extérieur du muret.
  assert.ok(PIT_LANE_X + 4.3 < PIT_WALL_OUTER);
  // Le centre de chaque box est du bitume de stands.
  for (let index = 0; index < 8; index++) {
    assert.equal(insidePit(PIT_LANE_X, stallCentre(index)), true);
  }
  // La piste elle-même n'en fait pas partie.
  assert.equal(insidePit(0, stallCentre(0)), false);
});

test('les ouvertures du muret tombent sur les raccordements', () => {
  for (const throat of PIT_THROATS) {
    assert.equal(pitWallGap(0, throat.outerFrom + 2, throat.outerTo - 2), true);
    // Entre les deux raccordements, le mur est continu.
    assert.equal(pitWallGap(0, -450, -447), false);
    // Les raccordements traversent le dégagement jusqu'au bord des vibreurs,
    // en biais : le milieu du quadrilatère est du bitume.
    const middle = (throat.innerFrom + throat.innerTo + throat.outerFrom + throat.outerTo) / 4;
    assert.equal(insidePit(-15, middle), true);
    // Le biais est réel : le bord piste et le bord voie ne sont pas au même z.
    assert.notEqual(throat.innerFrom, throat.outerFrom);
  }
});
