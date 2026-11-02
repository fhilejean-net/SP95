import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { parkingAccessGeometry, parkingPadGeometry } from '../src/world/parkingSurface.ts';
import type { ParkingPoint } from '../src/world/colParking.ts';

const ground = (x: number, z: number) => 0.35 * Math.sin(x * 0.35) + 0.22 * Math.cos(z * 0.5) + 0.012 * x;
const outline: ParkingPoint[] = [[0, 0], [24, 0], [24, 12], [8, 8], [0, 12]];

function checkGeometry(geometry: THREE.BufferGeometry, lift: number, maxEdge: number) {
  const position = geometry.getAttribute('position');
  const index = geometry.getIndex();
  assert.ok(index, 'la géométrie est indexée');
  assert.ok(geometry.getAttribute('uv'), 'la géométrie garde sa texture d’asphalte');
  assert.ok(position.count > 30, 'la dalle a des sommets intérieurs');
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i), z = position.getZ(i);
    assert.ok(Math.abs(position.getY(i) - (ground(x, z) + lift)) < 1e-4, 'un sommet quitte le terrain');
  }
  let maxLength = 0;
  for (let i = 0; i < index.count; i += 3) {
    const a = index.getX(i), b = index.getX(i + 1), c = index.getX(i + 2);
    const ux = position.getX(b) - position.getX(a), uz = position.getZ(b) - position.getZ(a);
    const vx = position.getX(c) - position.getX(a), vz = position.getZ(c) - position.getZ(a);
    const normalY = uz * vx - ux * vz;
    assert.ok(normalY >= 0, 'un triangle regarde sous la dalle');
    for (const [x0, z0, x1, z1] of [
      [position.getX(a), position.getZ(a), position.getX(b), position.getZ(b)],
      [position.getX(b), position.getZ(b), position.getX(c), position.getZ(c)],
      [position.getX(c), position.getZ(c), position.getX(a), position.getZ(a)],
    ]) maxLength = Math.max(maxLength, Math.hypot(x1 - x0, z1 - z0));
  }
  assert.ok(maxLength < maxEdge, `triangle trop grand : ${maxLength.toFixed(2)} m`);
}

test('la dalle du parking suit les bosses du terrain entre ses bords', () => {
  const geometry = parkingPadGeometry(outline, ground, { lift: 0.05, subdivisions: 4 });
  checkGeometry(geometry, 0.05, 2.5);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
  mesh.updateMatrixWorld(true);
  const ray = new THREE.Raycaster(new THREE.Vector3(12, 50, 4), new THREE.Vector3(0, -1, 0));
  const hit = ray.intersectObject(mesh, false)[0];
  assert.ok(hit, 'la dalle est visible depuis le ciel');
  assert.ok(Math.abs(hit.point.y - (ground(12, 4) + 0.05)) < 0.06, 'la dalle flotte au-dessus du pré');
});

test('une bande d’accès suit le terrain sur toute sa largeur', () => {
  const line: ParkingPoint[] = [[0, 0], [0, 8], [5, 12]];
  const geometry = parkingAccessGeometry(line, ground, 5.5, 0.05);
  checkGeometry(geometry, 0.05, 3.0);
  const position = geometry.getAttribute('position');
  assert.ok(Math.min(...Array.from({ length: position.count }, (_, i) => position.getZ(i))) < 0.1);
  assert.ok(Math.max(...Array.from({ length: position.count }, (_, i) => position.getZ(i))) > 11.9);
});
