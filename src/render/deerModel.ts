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
export interface DeerModel {
  object: THREE.Group;
  mixer: THREE.AnimationMixer | null;
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

  const object = new THREE.Group();
  object.add(scene);
  let mixer: THREE.AnimationMixer | null = null;
  if (gltf.animations.length > 0) {
    mixer = new THREE.AnimationMixer(scene);
    mixer.clipAction(gltf.animations[0]).setLoop(THREE.LoopRepeat, Infinity).play();
  }
  return { object, mixer };
}
