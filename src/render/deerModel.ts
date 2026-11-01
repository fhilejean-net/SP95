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

/**
 * Yeux de la bête : deux braises rouges dans la nuit. Le GLB n'a pas de
 * maillage d'yeux séparé — le nœud `Eyes_low` est une ancre vide posée devant
 * le crâne —, donc on accroche deux petites sphères et leurs halos à l'os de la
 * tête : ils suivent l'animation, la charge et le ragdoll.
 */
const EYE_RED = 0xff2a1a;
/** Écart entre les deux yeux et rayon de l'iris, en mètres. */
const EYE_SPREAD = 0.095;
const EYE_RADIUS = 0.032;

function eyeGlowTexture(): THREE.Texture | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, 'rgba(255,92,62,0.95)');
  gradient.addColorStop(0.35, 'rgba(255,42,26,0.5)');
  gradient.addColorStop(1, 'rgba(255,20,10,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 64, 64);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function addGlowingEyes(scene: THREE.Object3D): void {
  const head = scene.getObjectByName('C_Head_J_023') as THREE.Bone | undefined;
  if (!head) return;
  const anchor = scene.getObjectByName('Eyes_low');
  scene.updateMatrixWorld(true);

  const headPosition = new THREE.Vector3().setFromMatrixPosition(head.matrixWorld);
  const eyesPosition = anchor
    ? new THREE.Vector3().setFromMatrixPosition(anchor.matrixWorld)
    : headPosition.clone().add(new THREE.Vector3(0, 0.15, -0.3));
  // L'ancre est légèrement décalée : on garde sa hauteur et son avance, mais on
  // recentre l'écartement sur l'axe de la tête.
  const glow = eyeGlowTexture();

  for (const sign of [-1, 1]) {
    const point = new THREE.Vector3(
      headPosition.x + sign * EYE_SPREAD,
      eyesPosition.y,
      eyesPosition.z,
    );
    const iris = new THREE.Mesh(
      new THREE.SphereGeometry(EYE_RADIUS, 12, 8),
      new THREE.MeshBasicMaterial({ color: EYE_RED, toneMapped: false }),
    );
    iris.position.copy(point);
    iris.updateMatrixWorld(true);
    head.attach(iris);
    if (glow) {
      const halo = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: glow,
          transparent: true,
          opacity: 0.9,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          toneMapped: false,
        }),
      );
      halo.scale.setScalar(EYE_RADIUS * 8);
      halo.position.copy(point);
      halo.updateMatrixWorld(true);
      head.attach(halo);
    }
  }
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

  addGlowingEyes(scene);

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
