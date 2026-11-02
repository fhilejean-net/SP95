import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as THREE from 'three';
import type { EnvironmentMaterials } from '../src/render/materials.ts';
import {
  buildColParking,
  planColParking,
  type ParkingPoint,
} from '../src/world/colParking.ts';

const features = JSON.parse(
  readFileSync(new URL('../public/data/mollendruz/features.json', import.meta.url), 'utf8'),
) as { parking: number[][] };
const outline = features.parking as ParkingPoint[];

function inside([x, z]: ParkingPoint): boolean {
  let hit = false;
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    const [ax, az] = outline[i];
    const [bx, bz] = outline[j];
    if (az > z !== bz > z && x < ((bx - ax) * (z - az)) / (bz - az) + ax) hit = !hit;
  }
  return hit;
}

test('le parking du col trace les deux rangées de places de la référence', () => {
  const plan = planColParking(outline);
  assert.ok(plan.bays.length >= 50, `seulement ${plan.bays.length} places`);
  // Deux rangées le long des grands côtés, pas un éventail au milieu.
  for (const bay of plan.bays) {
    assert.ok(inside(bay.a), `pied de place hors dalle : ${bay.a}`);
    assert.ok(inside(bay.b), `pointe de place hors dalle : ${bay.b}`);
    const length = Math.hypot(bay.b[0] - bay.a[0], bay.b[1] - bay.a[1]);
    assert.ok(Math.abs(length - 5) < 0.001, 'une place fait cinq mètres');
  }
  const border = plan.border;
  assert.equal(border.length, 8, 'le liseré suit les huit côtés du polygone');
  const xs = plan.bays.map((bay) => bay.a[0]);
  assert.ok(Math.min(...xs) < -80 && Math.max(...xs) > -20, 'les places vont d’un bout à l’autre');
});

test('les traits du parking sont posés sur la dalle', () => {
  const scene = new THREE.Scene();
  const material = new THREE.MeshStandardMaterial();
  const mats = { lines: material } as unknown as EnvironmentMaterials;
  const count = buildColParking(scene, mats, outline, () => 100);
  assert.equal(count, planColParking(outline).bays.length);

  const bays = scene.getObjectByName('col-parking-bays') as THREE.Mesh;
  const border = scene.getObjectByName('col-parking-border') as THREE.Mesh;
  assert.ok(bays && bays.geometry.getAttribute('position').count > 0);
  assert.ok(border && border.geometry.getAttribute('position').count > 0);
  const positions = bays.geometry.getAttribute('position');
  for (let i = 0; i < positions.count; i++) {
    assert.ok(Math.abs(positions.getY(i) - 100.018) < 0.001, 'le trait flotte ou s’enfonce');
  }
});
