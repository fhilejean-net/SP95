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
) as { parking: number[][]; parking_upper: number[][] };
const outline = features.parking as ParkingPoint[];
const upper = features.parking_upper as ParkingPoint[];

function inside(points: ParkingPoint[], [x, z]: ParkingPoint): boolean {
  let hit = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [ax, az] = points[i];
    const [bx, bz] = points[j];
    if (az > z !== bz > z && x < ((bx - ax) * (z - az)) / (bz - az) + ax) hit = !hit;
  }
  return hit;
}

function checkLot(points: ParkingPoint[], minimum: number) {
  const plan = planColParking(points);
  assert.ok(plan.bays.length >= minimum, `seulement ${plan.bays.length} places`);
  for (const bay of plan.bays) {
    assert.ok(inside(points, bay.a), `pied de place hors dalle : ${bay.a}`);
    assert.ok(inside(points, bay.b), `pointe de place hors dalle : ${bay.b}`);
    const length = Math.hypot(bay.b[0] - bay.a[0], bay.b[1] - bay.a[1]);
    assert.ok(Math.abs(length - 5) < 0.001, 'une place fait cinq mètres');
  }
  return plan;
}

test('le parking ouest du col trace les deux rangées de places de la référence', () => {
  const plan = checkLot(outline, 50);
  const border = plan.border;
  assert.equal(border.length, 8, 'le liseré suit les huit côtés du polygone');
  const xs = plan.bays.map((bay) => bay.a[0]);
  assert.ok(Math.min(...xs) < -80 && Math.max(...xs) > -20, 'les places vont d’un bout à l’autre');
});

test('le parking du haut est tracé de l’autre côté de la route', () => {
  const plan = checkLot(upper, 30);
  assert.ok(plan.border.length >= 8, 'le liseré suit le pourtour du second parking');
  const xs = plan.bays.map((bay) => bay.a[0]);
  assert.ok(Math.min(...xs) < -40 && Math.max(...xs) > 55, 'les places couvrent la longue dalle');
});

test('les traits des deux parkings sont posés sur leur dalle', () => {
  const scene = new THREE.Scene();
  const material = new THREE.MeshStandardMaterial();
  const mats = { lines: material } as unknown as EnvironmentMaterials;
  const count = buildColParking(scene, mats, outline, () => 100);
  assert.equal(count, planColParking(outline).bays.length);
  const upperCount = buildColParking(scene, mats, upper, () => 100, 'col-parking-upper');
  assert.equal(upperCount, planColParking(upper).bays.length);

  for (const [name, expected] of [
    ['col-parking-bays', count],
    ['col-parking-upper-bays', upperCount],
  ] as const) {
    const bays = scene.getObjectByName(name) as THREE.Mesh;
    assert.ok(bays && bays.geometry.getAttribute('position').count > 0, `${name} manque`);
    assert.ok(bays.geometry.getAttribute('position').count >= expected * 6);
    const positions = bays.geometry.getAttribute('position');
    for (let i = 0; i < positions.count; i++) {
      assert.ok(Math.abs(positions.getY(i) - 100.018) < 0.001, 'le trait flotte ou s’enfonce');
    }
  }
  assert.ok(scene.getObjectByName('col-parking-border'));
  assert.ok(scene.getObjectByName('col-parking-upper-border'));
});
