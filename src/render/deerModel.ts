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
  /** Os des jambes, pour la démarche pilotée par la distance. */
  gait: DeerGait;
}

export interface DeerGaitBone {
  bone: THREE.Bone;
  rest: THREE.Quaternion;
  /** Axe latéral du modèle, exprimé dans le repère du parent au repos. */
  axis: THREE.Vector3;
}

export interface DeerGait {
  upper: DeerGaitBone[];
  knee: DeerGaitBone[];
  ankle: DeerGaitBone[];
  foot: DeerGaitBone[];
  toe: DeerGaitBone[];
  spine: DeerGaitBone | null;
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
 * Yeux de la bête : une prunelle rouge sombre dans une orbite noire, avec un
 * petit reflet. Le GLB n'a pas de maillage d'yeux séparé — le nœud `Eyes_low`
 * est une ancre vide devant le crâne —, donc on accroche l'ensemble à l'os de
 * la tête : il suit l'animation, la charge et le ragdoll.
 *
 * Les premiers yeux étaient deux grosses braises et un halo large : de loin,
 * la bête ressemblait à un renne au nez rouge. Ici l'iris reste petit, le halo
 * est à peine plus large que l'œil et très peu opaque : on doit deviner deux
 * points rouges dans le noir, pas éclairer la forêt.
 */
const EYE_RED = 0xd0140a;
/** Écart entre les deux yeux et rayon de l'iris, en mètres. */
const EYE_SPREAD = 0.085;
const EYE_RADIUS = 0.023;
const SOCKET_RADIUS = 0.036;

function eyeGlowTexture(): THREE.Texture | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, 'rgba(214,36,22,0.55)');
  gradient.addColorStop(0.4, 'rgba(160,20,12,0.22)');
  gradient.addColorStop(1, 'rgba(120,12,8,0)');
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
  // Le museau regarde −Z : les yeux se posent un peu en avant de l'ancre, pas
  // collés au crâne, sinon l'orbite noire disparaît dans la fourrure.
  const forward = new THREE.Vector3(0, 0, -1)
    .applyQuaternion(head.getWorldQuaternion(new THREE.Quaternion()));
  const glow = eyeGlowTexture();
  const socketGeometry = new THREE.SphereGeometry(SOCKET_RADIUS, 14, 10);
  const irisGeometry = new THREE.SphereGeometry(EYE_RADIUS, 14, 10);
  const pupilGeometry = new THREE.SphereGeometry(EYE_RADIUS * 0.42, 10, 8);
  const glintGeometry = new THREE.SphereGeometry(EYE_RADIUS * 0.16, 8, 6);
  const socketMaterial = new THREE.MeshStandardMaterial({ color: 0x080504, roughness: 0.85 });
  const irisMaterial = new THREE.MeshStandardMaterial({
    color: 0x200402,
    emissive: EYE_RED,
    emissiveIntensity: 1.35,
    roughness: 0.3,
    metalness: 0.05,
  });
  const pupilMaterial = new THREE.MeshBasicMaterial({ color: 0x050202 });
  const glintMaterial = new THREE.MeshBasicMaterial({ color: 0xffd9c4, toneMapped: false });

  for (const sign of [-1, 1]) {
    const point = new THREE.Vector3(
      headPosition.x + sign * EYE_SPREAD,
      eyesPosition.y,
      eyesPosition.z,
    );
    const socket = new THREE.Mesh(socketGeometry, socketMaterial);
    socket.position.copy(point);
    socket.updateMatrixWorld(true);
    head.attach(socket);

    const iris = new THREE.Mesh(irisGeometry, irisMaterial);
    iris.position.copy(point).addScaledVector(forward, SOCKET_RADIUS * 0.55);
    iris.updateMatrixWorld(true);
    head.attach(iris);

    const pupil = new THREE.Mesh(pupilGeometry, pupilMaterial);
    pupil.position.copy(point).addScaledVector(forward, SOCKET_RADIUS * 0.55 + EYE_RADIUS * 0.72);
    pupil.updateMatrixWorld(true);
    head.attach(pupil);

    // Un seul reflet, en haut et vers l'extérieur : c'est lui qui fait lire
    // un globe oculaire plutôt qu'une diode.
    const glint = new THREE.Mesh(glintGeometry, glintMaterial);
    glint.position
      .copy(point)
      .addScaledVector(forward, SOCKET_RADIUS * 0.55 + EYE_RADIUS * 0.8)
      .add(new THREE.Vector3(sign * EYE_RADIUS * 0.35, EYE_RADIUS * 0.4, 0));
    glint.updateMatrixWorld(true);
    head.attach(glint);

    if (glow) {
      const halo = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: glow,
          transparent: true,
          opacity: 0.3,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          toneMapped: false,
        }),
      );
      halo.scale.setScalar(EYE_RADIUS * 3.2);
      halo.position.copy(point).addScaledVector(forward, SOCKET_RADIUS * 0.55);
      halo.updateMatrixWorld(true);
      head.attach(halo);
    }
  }
}

/** Axe de rotation d'un os de jambe, ramené dans le repère de son parent. */
function gaitBone(scene: THREE.Object3D, name: string): DeerGaitBone | null {
  const bone = scene.getObjectByName(name) as THREE.Bone | undefined;
  if (!bone) return null;
  const parent = bone.parent ?? scene;
  const axis = new THREE.Vector3(1, 0, 0)
    .applyQuaternion(scene.getWorldQuaternion(new THREE.Quaternion()))
    .applyQuaternion(parent.getWorldQuaternion(new THREE.Quaternion()).invert())
    .normalize();
  return { bone, rest: bone.quaternion.clone(), axis };
}

function buildGait(scene: THREE.Object3D): DeerGait {
  const pair = (left: string, right: string): DeerGaitBone[] =>
    [left, right]
      .map((name) => gaitBone(scene, name))
      .filter((entry): entry is DeerGaitBone => entry !== null);
  return {
    upper: pair('L_upper_leg_J_072', 'R_upper_leg_J_078'),
    knee: pair('L_knee_J_073', 'R_knee_J_079'),
    ankle: pair('L_ankle_J_074', 'R_ankle_J_080'),
    foot: pair('L_feet_J_076', 'R_feet_J_082'),
    toe: pair('L_toe_J_077', 'R_toe_J_083'),
    spine: gaitBone(scene, 'C_spine_01_J_018'),
  };
}

const gaitQuat = new THREE.Quaternion();

function poseGaitBone(entry: DeerGaitBone | null | undefined, angle: number): void {
  if (!entry) return;
  entry.bone.quaternion.copy(entry.rest);
  if (Math.abs(angle) < 1e-4) return;
  gaitQuat.setFromAxisAngle(entry.axis, angle);
  entry.bone.quaternion.premultiply(gaitQuat);
}

/**
 * Démarche procédurale : le clip du GLB est un lent balancement de 6,25 s, pas
 * un pas calé sur la vitesse. On pilote donc les jambes à partir de la distance
 * parcourue — les sabots se posent au lieu de glisser — et on incline le buste
 * sur les longues foulées.
 */
export function animateDeerGait(gait: DeerGait, phase: number, swing: number, bend: number, lean = 0): void {
  const count = Math.min(gait.upper.length, gait.knee.length, gait.ankle.length);
  for (let i = 0; i < count; i++) {
    const p = phase + i * Math.PI;
    // La jambe est en l'air sur la seconde moitié du cycle, quand elle revient
    // vers l'avant : c'est là que le genou se replie.
    const lift = Math.max(0, -Math.sin(p));
    poseGaitBone(gait.upper[i], swing * Math.cos(p));
    // Un bend positif replie le genou vers l'arrière : le sabot monte au lieu
    // de labourer le sol.
    poseGaitBone(gait.knee[i], -bend * lift);
    poseGaitBone(gait.ankle[i], bend * 0.55 * lift - swing * 0.25 * Math.cos(p));
    // Le pied reste rigide sous la cheville : le clip le pliait dans son propre
    // rythme et la bête semblait marcher sur des palmes.
    poseGaitBone(gait.foot[i], 0);
    poseGaitBone(gait.toe[i], 0);
  }
  poseGaitBone(gait.spine, lean);
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
  const gait = buildGait(scene);

  const object = new THREE.Group();
  object.add(scene);
  let mixer: THREE.AnimationMixer | null = null;
  let action: THREE.AnimationAction | null = null;
  if (gltf.animations.length > 0) {
    mixer = new THREE.AnimationMixer(scene);
    action = mixer.clipAction(gltf.animations[0]).setLoop(THREE.LoopRepeat, Infinity);
    action.play();
  }
  return { object, scene, mixer, action, rest, gait };
}
