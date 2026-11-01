import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { createAmbientMotes } from '../src/render/ambientMotes.ts';

test('les poussières sont un champ du monde qui défile vers la caméra', () => {
  const motes = createAmbientMotes(60);
  const camera = new THREE.PerspectiveCamera(60, 1.6, 0.1, 500);
  camera.position.set(0, 2, 0);
  camera.lookAt(0, 2, -10);
  camera.updateMatrixWorld(true);
  const motion = new THREE.Vector3(0, 0, -30);
  motes.update(1 / 60, camera, motion);

  const group = motes.object;
  const points = group.getObjectByName('ambient-mote-points') as THREE.Points;
  const lines = group.getObjectByName('ambient-mote-streaks') as THREE.LineSegments;
  const positions = points.geometry.getAttribute('position').array as Float32Array;
  const streaks = lines.geometry.getAttribute('position').array as Float32Array;
  assert.equal(points.geometry.getAttribute('position').count, 60);
  assert.equal(lines.geometry.getAttribute('position').count, 120);

  // Tout le champ est devant la caméra, pas autour de l'origine.
  for (let i = 0; i < 60; i++) {
    assert.ok(positions[i * 3 + 2] < -5, `grain ${i} derrière la caméra`);
    assert.ok(positions[i * 3 + 2] > -80, `grain ${i} perdu au loin`);
  }
  const lineMaterial = lines.material as THREE.LineBasicMaterial;
  assert.ok(lineMaterial.opacity > 0.2, 'les traînées sont visibles à 108 km/h');
  const streak = Math.hypot(
    streaks[3] - streaks[0],
    streaks[4] - streaks[1],
    streaks[5] - streaks[2],
  );
  assert.ok(streak > 1, `traînée trop courte : ${streak.toFixed(2)} m`);

  // Un grain ne suit pas la caméra : il reste dans le monde quand elle avance.
  const first = [positions[0], positions[1], positions[2]];
  camera.position.z -= 5;
  camera.updateMatrixWorld(true);
  motes.update(1 / 60, camera, motion);
  assert.ok(Math.abs(positions[0] - first[0]) < 0.05);
  assert.ok(Math.abs(positions[1] - first[1]) < 0.05);
  assert.ok(Math.abs(positions[2] - first[2]) < 0.05);

  // Après un grand saut, tout le champ est recyclé devant la nouvelle caméra.
  camera.position.z -= 200;
  camera.updateMatrixWorld(true);
  motes.update(1 / 60, camera, motion);
  for (let i = 0; i < 60; i++) {
    assert.ok(Number.isFinite(positions[i * 3 + 2]));
    assert.ok(positions[i * 3 + 2] < camera.position.z - 5);
    assert.ok(positions[i * 3 + 2] > camera.position.z - 80);
  }
});
