import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { createAmbientMotes } from '../src/render/ambientMotes.ts';

test('la neige naît au centre du champ, tombe et se recycle', () => {
  const motes = createAmbientMotes(60);
  const camera = new THREE.PerspectiveCamera(60, 1.6, 0.1, 500);
  camera.position.set(0, 2, 0);
  camera.lookAt(0, 2, -10);
  camera.updateMatrixWorld(true);
  const motion = new THREE.Vector3(0, 0, -30);
  motes.update(1 / 60, camera, motion);

  const group = motes.object;
  const points = group.getObjectByName('ambient-mote-points') as THREE.Points;
  const positions = points.geometry.getAttribute('position').array as Float32Array;
  assert.equal(points.geometry.getAttribute('position').count, 60);
  assert.equal(group.getObjectByName('ambient-mote-streaks'), undefined, 'plus de traînées');

  // Tous les flocons sont devant la caméra, dans un disque étroit : ils
  // apparaissent près du centre du champ, pas sur les bords.
  let maxSide = 0;
  for (let i = 0; i < 60; i++) {
    const ahead = -positions[i * 3 + 2];
    const side = Math.abs(positions[i * 3]);
    assert.ok(ahead > 5 && ahead < 46, `flocon ${i} hors du champ : ${ahead.toFixed(1)} m`);
    assert.ok(Math.abs(positions[i * 3 + 1] - 2) < 5, `flocon ${i} hors du cadre vertical`);
    maxSide = Math.max(maxSide, side);
  }
  assert.ok(maxSide <= 4.5, `naissance trop large : ${maxSide.toFixed(2)} m`);

  // Gravité : en une seconde et sans recyclage, chaque flocon est descendu.
  const before = positions.slice();
  for (let step = 0; step < 60; step++) motes.update(1 / 60, camera, motion);
  let fallen = 0;
  for (let i = 0; i < 60; i++) {
    if (positions[i * 3 + 1] < before[i * 3 + 1] - 0.3) fallen++;
  }
  assert.ok(fallen >= 58, `seulement ${fallen} flocons sur 60 sont tombés`);

  // Un grand saut de caméra recycle tout le champ devant la nouvelle position.
  camera.position.z -= 200;
  camera.updateMatrixWorld(true);
  motes.update(1 / 60, camera, motion);
  for (let i = 0; i < 60; i++) {
    const ahead = camera.position.z - positions[i * 3 + 2];
    assert.ok(Number.isFinite(positions[i * 3 + 2]));
    assert.ok(ahead > 5 && ahead < 46, `flocon ${i} non recyclé : ${ahead.toFixed(1)} m`);
  }
});
