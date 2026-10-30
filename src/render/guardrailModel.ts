import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { GuardrailRun } from '../world/terrain.ts';

/**
 * La glissière fournie par le joueur : un tronçon de 2 m, 30 cm de haut, dix-huit
 * maillages et une texture. On l'étire à la longueur d'un tronçon de route
 * (`run.segment`, 4,7 m), ce qui lui donne 71 cm de haut — la taille d'une vraie
 * glissière —, puis on l'instancie le long de la corniche.
 *
 * Le ruban procédural de `buildGuardrails` reste en place pour la collision et
 * comme solution de repli : il n'est masqué qu'une fois le GLB posé.
 */
const MODEL_URL = `${import.meta.env.BASE_URL}models/col/guard_rail.glb`;
const loader = new GLTFLoader();

export async function addGuardrailModel(scene: THREE.Scene, run: GuardrailRun): Promise<void> {
  if (run.placements.length === 0) return;
  const gltf = await loader.loadAsync(MODEL_URL);
  const model = gltf.scene;
  model.updateMatrixWorld(true);
  const raw = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3());
  // Le grand axe du fichier est X : c'est la longueur du tronçon.
  if (raw.x < 1e-4) return;
  model.scale.setScalar(run.segment / raw.x);
  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model);
  // Centré sur X et Z, posé sur le bitume : le groupe d'instances n'a plus qu'à
  // suivre la route.
  model.position.set(
    -(box.min.x + box.max.x) / 2,
    -box.min.y,
    -(box.min.z + box.max.z) / 2,
  );
  model.updateMatrixWorld(true);

  const group = new THREE.Group();
  group.name = 'guardrail-model';
  const dummy = new THREE.Object3D();
  model.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const geometry = child.geometry.clone();
    // La pose du GLB (rotations Sketchfab comprises) est cuite dans la
    // géométrie : chaque instance n'a plus qu'un cap et une position.
    geometry.applyMatrix4(child.matrixWorld);
    // Le faisceau du modèle regarde +Z ; sur le bord ravin la route est à
    // gauche : on retourne le tronçon une fois pour qu'il lui fasse face.
    geometry.rotateY(Math.PI);
    const material = Array.isArray(child.material) ? child.material[0] : child.material;
    const mesh = new THREE.InstancedMesh(geometry, material, run.placements.length);
    const yawQuat = new THREE.Quaternion();
    const pitchQuat = new THREE.Quaternion();
    const localZ = new THREE.Vector3(0, 0, 1);
    const up = new THREE.Vector3(0, 1, 0);
    run.placements.forEach((place, i) => {
      dummy.position.set(place.x, place.y, place.z);
      yawQuat.setFromAxisAngle(up, place.yaw);
      pitchQuat.setFromAxisAngle(localZ, place.pitch);
      dummy.quaternion.copy(yawQuat).multiply(pitchQuat);
      // Chaque tronçon est étiré à la longueur de sa corde : les sections se
      // touchent dans les virages au lieu de laisser des coins de vide.
      dummy.scale.set(place.stretch, 1, 1);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    group.add(mesh);
  });
  scene.add(group);
  for (const fallback of run.fallback) fallback.visible = false;
}
