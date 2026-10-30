import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEER_IMPACT_KEEP,
  deerWithinCarFootprint,
  speedAfterDeerImpact,
} from '../src/game/deerImpact.ts';

test('the deer impact takes a little less than half the speed', () => {
  assert.equal(speedAfterDeerImpact(30), 30 * DEER_IMPACT_KEEP);
  assert.ok(speedAfterDeerImpact(30) < 20);
  assert.ok(speedAfterDeerImpact(30) > 15);
  // Un choc à l'arrêt ne fait pas reculer la voiture.
  assert.equal(speedAfterDeerImpact(-4), 0);
});

test('the deer is hit only inside the car footprint', () => {
  const forwardX = 0;
  const forwardZ = -1;
  // Deux mètres devant le capot.
  assert.equal(deerWithinCarFootprint({ dx: 0, dz: -2, forwardX, forwardZ }), true);
  // Trois mètres sur le côté : la voiture est passée à côté.
  assert.equal(deerWithinCarFootprint({ dx: 3, dz: 0, forwardX, forwardZ }), false);
  // Juste devant le pare-chocs, à peine décalé.
  assert.equal(deerWithinCarFootprint({ dx: 1, dz: -3.2, forwardX, forwardZ }), true);
  // Derrière la voiture.
  assert.equal(deerWithinCarFootprint({ dx: 0, dz: 5, forwardX, forwardZ }), false);
});
