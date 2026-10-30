import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { EnvironmentMaterials } from '../src/render/materials.ts';
import { Vehicle, NEUTRAL_INPUT } from '../src/physics/vehicle.ts';

// Le choix de carte est lu au chargement du module ; ce fichier tourne isolément.
Object.assign(globalThis, { window: { location: { search: '?map=col' } } });
const { MOUNTAIN_ROADS, SUMMIT, COL_START, heightAt, surfaceAt, colLaybyWidth } = await import('../src/world/layout.ts');
const { buildGradedRoads, buildGuardrails } = await import('../src/world/terrain.ts');
// Rapier détecte la fenêtre : ne pas lui laisser une fenêtre Node factice.
Reflect.deleteProperty(globalThis, 'window');
const road = MOUNTAIN_ROADS[0];

test('le tracé suit le parking et la grande épingle de la référence', () => {
  const points = road.points;
  const first = points[0], last = points[points.length - 1];
  assert.ok(Math.hypot(first.x - SUMMIT.cx, first.z - SUMMIT.cz) < 0.1);
  assert.ok(Math.hypot(COL_START.x - SUMMIT.cx, COL_START.z - SUMMIT.cz) < SUMMIT.radius);
  assert.ok(road.length > 3000 && road.length < 3500);
  assert.ok(first.y - last.y > 100);
  // L'épingle est le point le plus à droite ; la route repart vers la gauche.
  const eastern = Math.max(...points.map((p) => p.x));
  assert.ok(eastern > 850 && last.x < eastern - 250);
  let maxGrade = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    maxGrade = Math.max(maxGrade, Math.abs(b.y - a.y) / Math.hypot(b.x - a.x, b.z - a.z));
  }
  assert.ok(maxGrade < 0.13);
});

test('la corniche est bordée de roche en amont et de vide en aval', () => {
  // Sur une portion éloignée de l'épingle, la gauche est toujours plus haute.
  for (let i = 90; i < 480; i += 30) {
    const a = road.points[i - 1], p = road.points[i], b = road.points[i + 1];
    const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz);
    const left = heightAt(p.x + dz / len * 24, p.z - dx / len * 24);
    const right = heightAt(p.x - dz / len * 24, p.z + dx / len * 24);
    assert.ok(left > p.y + 5, `amont ${i}`);
    assert.ok(right < p.y - 5, `aval ${i}`);
  }
});

test('les évitements et la route sont des surfaces asphaltées avec collision', async () => {
  await RAPIER.init();
  const scene = new THREE.Scene();
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  const material = new THREE.MeshStandardMaterial();
  const mats = { asphalt: material, asphaltPad: material, lines: material } as unknown as EnvironmentMaterials;
  buildGradedRoads(scene, mats, world);
  buildGuardrails(scene, world);
  const i = Math.round((road.points.length - 1) * 0.34);
  const p = road.points[i], a = road.points[i - 1], b = road.points[i + 1];
  const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz);
  assert.ok(colLaybyWidth(road.samples[i].s, road.length) > 3);
  const x = p.x - dz / len * 5, z = p.z + dx / len * 5;
  assert.equal(surfaceAt(x, z).kind, 'asphalte');
  world.step();
  const hit = world.castRay(new RAPIER.Ray({ x, y: p.y + 5, z }, { x: 0, y: -1, z: 0 }), 10, true);
  assert.ok(hit, 'le sol de l’évitement doit arrêter le rayon');
  assert.ok(Math.abs(p.y + 5 - hit.timeOfImpact - (p.y + 0.09)) < 0.2);
  assert.ok(scene.getObjectByName('col-laybys'));
  assert.ok(scene.getObjectByName('guardrails'));
  const car = new Vehicle(world, { x: p.x, y: p.y + 0.9, z: p.z, heading: Math.atan2(-dx, -dz), surfaceAt });
  world.timestep = 1 / 120;
  for (let step = 0; step < 240; step++) {
    car.step(1 / 120, NEUTRAL_INPUT, world);
    world.step();
  }
  assert.ok(Number.isFinite(car.position.y) && car.position.y > p.y - 1, 'la voiture reste au-dessus de la route');
  assert.ok(car.telemetryState.wheels.filter((wheel) => wheel.contact).length >= 3, 'les roues portent la voiture');
  world.free();
});
