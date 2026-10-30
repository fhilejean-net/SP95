import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/**
 * Le cerf du col : « The Human Deer » (ceeleste, CC BY 4.0). Le fichier est
 * dessiné à une échelle arbitraire — le corps mesure près de 13 800 unités de
 * long — et son museau regarde déjà vers −Z, le cap du jeu.
 *
 * On le ramène à 3,4 m de long — un grand cerf, pas un chevreuil —, centré sur
 * son axe et les pattes sur le sol : la pose cinématique, elle, reste au groupe
 * qui l'entoure.
 */
export interface DeerRestBone {
  bone: THREE.Bone;
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  scale: THREE.Vector3;
}

export interface DeerModel {
  object: THREE.Group;
  /** La scène GLB mise à l'échelle, celle que pilotent les os. */
  scene: THREE.Object3D;
  mixer: THREE.AnimationMixer | null;
  action: THREE.AnimationAction | null;
  /** Pose de repos des os, pour effacer les restes d'un ragdoll. */
  rest: DeerRestBone[];
}

/**
 * Le ragdoll écrit directement dans les os ; sans cette remise à zéro, la bête
 * réapparaît avec la pose disloquée de sa dernière mort (souvent à l'envers et
 * au-dessus de la route).
 */
export function resetDeerPose(scene: THREE.Object3D, rest: DeerRestBone[]): void {
  for (const entry of rest) {
    entry.bone.position.copy(entry.position);
    entry.bone.quaternion.copy(entry.quaternion);
    entry.bone.scale.copy(entry.scale);
  }
  scene.updateMatrixWorld(true);
}

/** Longueur museau-queue visée, en mètres. */
const BODY_LENGTH = 3.4;
const MODEL_URL = `${import.meta.env.BASE_URL}models/animals/the_human_deer.glb`;
const loader = new GLTFLoader();

export async function loadDeerModel(): Promise<DeerModel> {
  const gltf = await loader.loadAsync(MODEL_URL);
  const scene = gltf.scene;
  scene.updateMatrixWorld(true);
  const raw = new THREE.Box3().setFromObject(scene);
  const size = raw.getSize(new THREE.Vector3());
  // Le grand axe du fichier est le Z : c'est la longueur du corps.
  scene.scale.multiplyScalar(BODY_LENGTH / Math.max(size.z, 1e-3));
  scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(scene);
  scene.position.x -= (box.min.x + box.max.x) / 2;
  scene.position.y -= box.min.y;
  scene.position.z -= (box.min.z + box.max.z) / 2;
  scene.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    child.castShadow = true;
    // Un maillage squeletté sort de sa boîte au repos : trois le couperait en plein saut.
    child.frustumCulled = false;
  });

  // La pose par défaut du GLB, avant toute animation : c'est elle qu'on
  // restaure après un ragdoll.
  const rest: DeerRestBone[] = [];
  scene.traverse((child) => {
    if (!(child instanceof THREE.Bone)) return;
    rest.push({
      bone: child,
      position: child.position.clone(),
      quaternion: child.quaternion.clone(),
      scale: child.scale.clone(),
    });
  });

  const object = new THREE.Group();
  object.add(scene);
  let mixer: THREE.AnimationMixer | null = null;
  let action: THREE.AnimationAction | null = null;
  if (gltf.animations.length > 0) {
    mixer = new THREE.AnimationMixer(scene);
    action = mixer.clipAction(gltf.animations[0]).setLoop(THREE.LoopRepeat, Infinity);
    action.play();
  }
  return { object, scene, mixer, action, rest };
}
