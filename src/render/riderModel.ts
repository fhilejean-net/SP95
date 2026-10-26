import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/**
 * The modelled rider.
 *
 * The GLB is a single static mesh of a woman in leathers, standing with one
 * hand on her hip. That is not a riding pose, so the mesh is skinned here with
 * a small procedural humanoid: the legs fold onto the pegs, the torso leans
 * over the tank, and the free arm reaches for the bar. The right hand stays on
 * the hip, which reads as the stunt rider's pose rather than a broken arm.
 *
 * Weights are computed from the vertex position: distance to the limb bones
 * for the arms, and side plus height bands for the legs and torso. It is not a
 * hand-painted rig, but at the distance the chase camera sits it is stable,
 * and it costs one draw call.
 */

export interface RiderPose {
  /** Bike lean, positive to the right, radians. */
  lean: number;
  /** Wheelie pitch, positive nose-up. */
  pitch: number;
  /** Longitudinally smoothed acceleration, m/s². */
  accel: number;
  brake: number;
  steer: number;
  /** Body drop from the rear suspension, metres. */
  drop: number;
  time: number;
}

export interface RiderVisual {
  group: THREE.Group;
  update(pose: RiderPose): void;
  dispose(): void;
}

const HEIGHT = 1.68;
const loader = new GLTFLoader();
const MODEL_ROOT = import.meta.env.BASE_URL;

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function distanceToSegment(
  px: number,
  py: number,
  pz: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
): number {
  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const apx = px - ax;
  const apy = py - ay;
  const apz = pz - az;
  const lengthSq = abx * abx + aby * aby + abz * abz;
  const t = Math.max(0, Math.min(1, (apx * abx + apy * aby + apz * abz) / (lengthSq || 1)));
  const cx = ax + abx * t;
  const cy = ay + aby * t;
  const cz = az + abz * t;
  return Math.hypot(px - cx, py - cy, pz - cz);
}

interface Joint {
  name: string;
  parent: number;
  position: [number, number, number];
}

/**
 * Joint centres in mesh space: the bbox is one unit tall, centred on zero, and
 * the model faces +X before the yaw that turns it toward the game's -Z.
 */
const JOINTS: Joint[] = [
  { name: 'hips', parent: -1, position: [0, -0.02, 0] },
  { name: 'spine', parent: 0, position: [0, 0.12, 0] },
  { name: 'chest', parent: 1, position: [0, 0.1, 0] },
  { name: 'neck', parent: 2, position: [0, 0.13, 0] },
  { name: 'head', parent: 3, position: [0, 0.08, 0] },

  { name: 'upperArmL', parent: 2, position: [0.12, 0.11, 0] },
  { name: 'foreArmL', parent: 5, position: [0.03, -0.22, -0.01] },
  { name: 'handL', parent: 6, position: [0, -0.14, 0] },

  { name: 'upperArmR', parent: 2, position: [-0.12, 0.11, 0] },
  { name: 'foreArmR', parent: 8, position: [-0.05, -0.19, -0.02] },
  { name: 'handR', parent: 9, position: [0.13, -0.1, 0.02] },

  { name: 'thighL', parent: 0, position: [0.06, 0, 0] },
  { name: 'shinL', parent: 11, position: [0.01, -0.24, 0.005] },
  { name: 'footL', parent: 12, position: [0, -0.18, 0.005] },

  { name: 'thighR', parent: 0, position: [-0.06, 0, 0] },
  { name: 'shinR', parent: 14, position: [-0.01, -0.24, 0.005] },
  { name: 'footR', parent: 15, position: [0, -0.18, 0.005] },
];

/** World-space (mesh-space) joint centres, derived from the hierarchy. */
function jointCentres(): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (const joint of JOINTS) {
    const parent = joint.parent >= 0 ? out[joint.parent] : new THREE.Vector3();
    out.push(parent.clone().add(new THREE.Vector3(...joint.position)));
  }
  return out;
}

export async function loadRiderVisual(): Promise<RiderVisual | null> {
  let gltf;
  try {
    gltf = await loader.loadAsync(`${MODEL_ROOT}models/cars/biker_model.glb`);
  } catch (error) {
    console.warn('Modèle de pilote indisponible.', error);
    return null;
  }

  const source = gltf.scene;
  source.updateMatrixWorld(true);
  const meshes: THREE.Mesh[] = [];
  source.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) meshes.push(child as THREE.Mesh);
  });
  if (meshes.length === 0) return null;
  const mesh = meshes[0];

  const original = mesh.geometry;
  const position = original.getAttribute('position');
  const normal = original.getAttribute('normal');
  const uv = original.getAttribute('uv');
  const count = position.count;

  // Mesh space: Y up, one unit tall, centred on zero, nose toward +X. The yaw
  // turns that nose to -Z, the game's forward, without touching the height.
  const transform = new THREE.Matrix4().makeRotationY(Math.PI / 2);
  const vertex = new THREE.Vector3();
  const baked = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const uvs = uv ? new Float32Array(count * 2) : null;
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(source.matrixWorld);
  const world = new THREE.Matrix4().multiplyMatrices(transform, source.matrixWorld);
  for (let i = 0; i < count; i++) {
    vertex.set(position.getX(i), position.getY(i), position.getZ(i)).applyMatrix4(world);
    baked[i * 3] = vertex.x;
    baked[i * 3 + 1] = vertex.y;
    baked[i * 3 + 2] = vertex.z;
    if (normal) {
      vertex
        .set(normal.getX(i), normal.getY(i), normal.getZ(i))
        .applyMatrix3(normalMatrix)
        .applyMatrix4(new THREE.Matrix4().makeRotationY(Math.PI / 2))
        .normalize();
      normals[i * 3] = vertex.x;
      normals[i * 3 + 1] = vertex.y;
      normals[i * 3 + 2] = vertex.z;
    } else {
      normals[i * 3 + 1] = 1;
    }
    if (uvs && uv) {
      uvs[i * 2] = uv.getX(i);
      uvs[i * 2 + 1] = uv.getY(i);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(baked, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  if (uvs) geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  if (original.index) {
    const src = original.index.array;
    const index = new Uint32Array(src.length);
    index.set(src as unknown as ArrayLike<number>);
    geometry.setIndex(new THREE.BufferAttribute(index, 1));
  }

  // --- Skeleton -----------------------------------------------------------
  const centres = jointCentres();
  const bones: THREE.Bone[] = [];
  for (const joint of JOINTS) {
    const bone = new THREE.Bone();
    bone.name = joint.name;
    if (joint.parent >= 0) {
      bone.position.set(...joint.position);
      bones[joint.parent].add(bone);
    } else {
      bone.position.copy(centres[0]);
    }
    bones.push(bone);
  }

  const index = (name: string) => JOINTS.findIndex((joint) => joint.name === name);
  const hips = index('hips');
  const spine = index('spine');
  const chest = index('chest');
  const neck = index('neck');
  const head = index('head');
  const thighL = index('thighL');
  const shinL = index('shinL');
  const footL = index('footL');
  const thighR = index('thighR');
  const shinR = index('shinR');
  const footR = index('footR');
  const upperArmL = index('upperArmL');
  const foreArmL = index('foreArmL');
  const handL = index('handL');
  const upperArmR = index('upperArmR');
  const foreArmR = index('foreArmR');
  const handR = index('handR');

  const kneeY = centres[shinL].y;
  const ankleY = centres[footL].y;
  const armL = [centres[upperArmL], centres[foreArmL], centres[handL]];
  const armR = [centres[upperArmR], centres[foreArmR], centres[handR]];

  const torsoBones = [hips, spine, chest, neck, head];
  const torsoCentres = torsoBones.map((bone) => centres[bone].y);

  const skinIndices: number[] = [];
  const skinWeights: number[] = [];
  const armWeight = (p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3) =>
    distanceToSegment(p.x, p.y, p.z, a.x, a.y, a.z, b.x, b.y, b.z);

  const add = (weights: Map<number, number>, bone: number, weight: number) => {
    if (weight <= 0.0001) return;
    weights.set(bone, (weights.get(bone) ?? 0) + weight);
  };

  const point = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    point.set(baked[i * 3], baked[i * 3 + 1], baked[i * 3 + 2]);
    const weights = new Map<number, number>();

    // Torso and head: a soft partition by height around each joint.
    let torsoTotal = 0;
    const torsoRaw: number[] = [];
    for (let b = 0; b < torsoBones.length; b++) {
      const d = Math.abs(point.y - torsoCentres[b]);
      const raw = 1 / (Math.pow(d + 0.012, 2.4));
      torsoRaw.push(raw);
      torsoTotal += raw;
    }

    // Legs: side and height bands, blended at knee and ankle. The z limit
    // keeps the hair hanging behind the seat out of the thigh bones.
    if (point.y < 0 && Math.abs(point.x) > 0.008 && point.z < 0.12) {
      const side = point.x > 0 ? 1 : -1;
      const thigh = side > 0 ? thighL : thighR;
      const shin = side > 0 ? shinL : shinR;
      const foot = side > 0 ? footL : footR;
      const sideWeight = smoothstep(0.005, 0.032, Math.abs(point.x));
      const shinBlend = smoothstep(kneeY + 0.055, kneeY - 0.055, point.y);
      const footBlend = smoothstep(ankleY + 0.035, ankleY - 0.035, point.y);
      const hipBlend = smoothstep(-0.12, 0.01, point.y);
      const leg = sideWeight * (1 - hipBlend * 0.45);
      if (leg > 0) {
        add(weights, hips, sideWeight * hipBlend * 0.45);
        add(weights, thigh, leg * (1 - shinBlend));
        add(weights, shin, leg * shinBlend * (1 - footBlend));
        add(weights, foot, leg * shinBlend * footBlend);
      }
      if (leg >= 0.999) {
        // Fully a leg: no torso bleed.
        torsoTotal = 0;
      } else {
        for (let b = 0; b < torsoBones.length; b++) {
          add(weights, torsoBones[b], (torsoRaw[b] / torsoTotal) * (1 - leg));
        }
      }
    } else {
      // Arms: proximity to the two arm chains. The right arm is bent onto the
      // hip, so its hand is captured by the forearm segment, not by an x band.
      const dL = Math.min(armWeight(point, armL[0], armL[1]), armWeight(point, armL[1], armL[2]));
      const dR = Math.min(armWeight(point, armR[0], armR[1]), armWeight(point, armR[1], armR[2]));
      const sideL = Math.abs(point.x) > 0.035 || point.y > 0.14;
      const armLWeight = sideL ? smoothstep(0.125, 0.055, dL) : 0;
      const armRWeight = sideL ? smoothstep(0.125, 0.055, dR) : 0;
      const armness = Math.max(armLWeight, armRWeight) * smoothstep(-0.18, -0.12, point.y);
      if (armness > 0.001) {
        const useLeft = armLWeight >= armRWeight;
        const chain = useLeft ? [upperArmL, foreArmL, handL] : [upperArmR, foreArmR, handR];
        const distances = useLeft ? [armL[0], armL[1]] : [armR[0], armR[1]];
        const dUpper = armWeight(point, distances[0], distances[1]);
        const dFore = armWeight(point, distances[1], useLeft ? armL[2] : armR[2]);
        const wUpper = 1 / Math.pow(dUpper + 0.03, 3);
        const wFore = 1 / Math.pow(dFore + 0.03, 3);
        const sum = wUpper + wFore;
        add(weights, chain[0], armness * (wUpper / sum));
        add(weights, chain[1], armness * (wFore / sum));
        // The hand bone takes over at the very end of the chain.
        const handDistance = point.distanceTo(useLeft ? armL[2] : armR[2]);
        const handW = smoothstep(0.09, 0.045, handDistance) * armness;
        if (handW > 0) {
          add(weights, chain[2], handW * 0.7);
        }
      }
      for (let b = 0; b < torsoBones.length; b++) {
        add(weights, torsoBones[b], (torsoRaw[b] / torsoTotal) * (1 - armness));
      }
      // Hair and jacket skirts below the hips still belong to the torso.
      if (point.y < -0.1) add(weights, hips, 0.3);
    }

    // Keep the four strongest influences and normalise.
    const sorted = [...weights.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
    const total = sorted.reduce((sum, entry) => sum + entry[1], 0) || 1;
    for (let k = 0; k < 4; k++) {
      const entry = sorted[k];
      skinIndices.push(entry ? entry[0] : 0);
      skinWeights.push(entry ? entry[1] / total : 0);
    }
  }

  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4));
  geometry.computeBoundingSphere();

  const material = (mesh.material as THREE.MeshStandardMaterial).clone();
  material.roughness = Math.max(0.35, material.roughness);
  material.envMapIntensity = 1.2;
  material.needsUpdate = true;
  const skinned = new THREE.SkinnedMesh(geometry, material);
  skinned.name = 'rider';
  skinned.castShadow = true;
  skinned.receiveShadow = true;
  skinned.frustumCulled = false;

  const skeleton = new THREE.Skeleton(bones);
  skinned.add(bones[0]);
  skinned.bind(skeleton);

  const group = new THREE.Group();
  group.name = 'rider';
  group.scale.setScalar(HEIGHT);
  // Hip over the middle of the seat, not on the rear fender: on the modelled
  // CRF the seat pad runs from the tank to z ≈ 0.45, so the rider sits at 0.12.
  group.position.set(0, 0.945, 0.08);
  group.add(skinned);

  // --- Seated pose --------------------------------------------------------
  // Knees forward over the shrouds, boots back on the pegs: the hip-to-peg
  // distance is what sets these two angles, and the binding probes the rest.
  bones[thighL].rotation.set(0.62, 0, 0.3);
  bones[thighR].rotation.set(0.62, 0, -0.3);
  bones[shinL].rotation.x = -1.77;
  bones[shinR].rotation.x = -1.77;
  bones[footL].rotation.x = 0.55;
  bones[footR].rotation.x = 0.55;

  bones[upperArmL].rotation.set(1.32, 0, 0.26);
  bones[foreArmL].rotation.set(-0.42, 0, 0);
  bones[handL].rotation.x = 0.2;

  // The right arm keeps the hand on the hip: it is the pose the model came in,
  // and on a stunt bike it reads as deliberate.
  bones[upperArmR].rotation.set(0.1, 0, 0);
  bones[foreArmR].rotation.set(0, 0, 0);

  const base = {
    spine: 0.24,
    chest: 0.1,
    neck: -0.14,
    head: 0,
    armL: 1.32,
    legL: 0.3,
  };

  const set = (bone: number, x: number, y: number, z: number) => bones[bone].rotation.set(x, y, z);

  return {
    group,
    update(pose: RiderPose) {
      // The rider stays a little more upright than the bike in a corner.
      group.rotation.z = pose.lean * 0.22;
      // Under power he lies on the tank; on the brakes he braces back.
      const load = Math.max(-1, Math.min(1, pose.accel / 9));
      const brace = Math.max(0, Math.min(1, pose.brake));
      const wheelie = Math.max(0, Math.min(1, pose.pitch / 0.9));
      const breathe = Math.sin(pose.time * 2.1) * 0.008;
      set(spine, base.spine + load * 0.16 - brace * 0.12 - wheelie * 0.16 + breathe, 0, 0);
      set(chest, base.chest + load * 0.05 - brace * 0.05 - wheelie * 0.08, 0, 0);
      set(neck, base.neck + wheelie * 0.2, -pose.steer * 0.35, 0);
      set(upperArmL, base.armL - wheelie * 0.18, 0, base.legL * 0.8 + pose.steer * 0.12);
      set(foreArmL, -0.42 - wheelie * 0.1, 0, 0);
      group.position.y = 0.945 + pose.drop;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
