import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/**
 * Le pilote modélisé.
 *
 * Le GLB est un homme en T-pose, en une seule peau mais sept matériaux (veste,
 * jean, gants, lunettes, cheveux, chaussures). Il n'a ni squelette ni
 * animation : le déformer avec un squelette deviné étire le maillage.
 *
 * Le maillage est donc découpé en morceaux rigides, chacun pivotant autour
 * d'une vraie articulation (hanche, genou, cheville, nuque). Un morceau garde
 * sa forme, rien ne peut s'étirer, et des rotules en cuir cachent les coupes.
 *
 * Les bras sont la seule partie qui ne survit pas à la découpe : ils sont
 * tendus à l'horizontale et il en faut deux sur les poignées. Ils sont refaits
 * en manches de cuir, et une IK à deux os règle chaque bras sur le guidon.
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
  time: number;
}

/** Attachment points, in the rider's own space, refreshed by the bike. */
export interface RiderAnchors {
  gripL: THREE.Vector3;
  gripR: THREE.Vector3;
  footL: THREE.Vector3;
  footR: THREE.Vector3;
}

export interface RiderVisual {
  group: THREE.Group;
  anchors: RiderAnchors;
  update(pose: RiderPose): void;
  dispose(): void;
}

/** Standing height of the source mesh, in metres. */
const HEIGHT = 1.78;
/** Source mesh height, in model units. */
const SOURCE_HEIGHT = 181.5;
/** Source units per metre. */
const UNIT = HEIGHT / SOURCE_HEIGHT;

/**
 * Joint heights as a fraction of the standing height. Measured on this mesh:
 * the jeans end at 0.57 H and the shoulders sit at 0.80 H.
 */
const HIP = 0.55;
/** Height of the hip line above the rider group's origin, metres. */
export const RIDER_HIP_HEIGHT = HIP * HEIGHT;
const KNEE = 0.3;
const ANKLE = 0.11;
const SHOULDER = 0.8;
const NECK = 0.87;
/** Beyond this |x| the mesh is an outstretched arm, not a torso. */
const ARM_CUT = 0.15;
/** Above this height the arms start. */
const ARM_CUT_Y = 0.72;

const loader = new GLTFLoader();
const MODEL_ROOT = import.meta.env.BASE_URL;

const DOWN = new THREE.Vector3(0, -1, 0);

type Piece = 'torso' | 'head' | 'thighL' | 'thighR' | 'shinL' | 'shinR' | 'footL' | 'footR';

const PIECES: Piece[] = ['torso', 'head', 'thighL', 'thighR', 'shinL', 'shinR', 'footL', 'footR'];

function quatFromTo(from: THREE.Vector3, to: THREE.Vector3): THREE.Quaternion {
  return new THREE.Quaternion().setFromUnitVectors(from, to.clone().normalize());
}

/** A tapered leather sleeve, hung from its joint. */
function sleeve(length: number, top: number, bottom: number): THREE.BufferGeometry {
  const geometry = new THREE.CylinderGeometry(top, bottom, length, 10, 1, false);
  geometry.translate(0, -length / 2, 0);
  return geometry;
}

interface Surface {
  material: THREE.Material;
  positions: Float32Array;
  normals: Float32Array;
  uv: Float32Array | null;
  /** Triangles of each piece, as indices into this surface. */
  pieces: Map<Piece, number[]>;
}

export async function loadRiderVisual(): Promise<RiderVisual | null> {
  let gltf;
  try {
    gltf = await loader.loadAsync(`${MODEL_ROOT}models/rider/rider.glb`);
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

  const hipY = HIP * HEIGHT;
  const kneeY = KNEE * HEIGHT;
  const ankleY = ANKLE * HEIGHT;
  const shoulderY = SHOULDER * HEIGHT;
  const neckY = NECK * HEIGHT;

  const surfaces: Surface[] = [];
  const vertex = new THREE.Vector3();
  const normal = new THREE.Vector3();

  // Le cadrage est commun à tous les matériaux : chaque mesh est une partie du
  // même corps (veste, jean, tête…), et recentrer chacun sur lui-même empile
  // les morceaux les uns sur les autres.
  let modelMinX = Infinity;
  let modelMaxX = -Infinity;
  let modelMinY = Infinity;
  let modelMinZ = Infinity;
  let modelMaxZ = -Infinity;
  const rotations = new Map<THREE.Mesh, THREE.Matrix4>();
  for (const mesh of meshes) {
    const rotate = new THREE.Matrix4().makeRotationY(Math.PI).multiply(mesh.matrixWorld);
    rotations.set(mesh, rotate);
    const position = mesh.geometry.getAttribute('position');
    if (!position) continue;
    for (let i = 0; i < position.count; i++) {
      vertex.set(position.getX(i), position.getY(i), position.getZ(i)).applyMatrix4(rotate);
      modelMinX = Math.min(modelMinX, vertex.x);
      modelMaxX = Math.max(modelMaxX, vertex.x);
      modelMinY = Math.min(modelMinY, vertex.y);
      modelMinZ = Math.min(modelMinZ, vertex.z);
      modelMaxZ = Math.max(modelMaxZ, vertex.z);
    }
  }
  const originX = (modelMinX + modelMaxX) / 2;
  const originZ = (modelMinZ + modelMaxZ) / 2;
  const originY = modelMinY;

  for (const mesh of meshes) {
    const original = mesh.geometry;
    const position = original.getAttribute('position');
    const normalAttribute = original.getAttribute('normal');
    const uvAttribute = original.getAttribute('uv');
    if (!position) continue;
    const count = position.count;

    // Espace modèle -> espace pilote : debout, pieds à y = 0, centré sur la
    // colonne, face vers -Z comme la moto. Le modèle regarde +Z (les lunettes
    // et les chaussures sont du côté +Z), d'où la rotation de 180°.
    const rotate = rotations.get(mesh)!;
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(rotate);
    const baked = new Float32Array(count * 3);
    const bakedNormals = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      vertex.set(position.getX(i), position.getY(i), position.getZ(i)).applyMatrix4(rotate);
      baked[i * 3] = vertex.x;
      baked[i * 3 + 1] = vertex.y;
      baked[i * 3 + 2] = vertex.z;
      if (normalAttribute) {
        normal.set(normalAttribute.getX(i), normalAttribute.getY(i), normalAttribute.getZ(i));
        normal.applyMatrix3(normalMatrix).normalize();
      } else {
        normal.set(0, 1, 0);
      }
      bakedNormals[i * 3] = normal.x;
      bakedNormals[i * 3 + 1] = normal.y;
      bakedNormals[i * 3 + 2] = normal.z;
    }
    for (let i = 0; i < count; i++) {
      baked[i * 3] = (baked[i * 3] - originX) * UNIT;
      baked[i * 3 + 1] = (baked[i * 3 + 1] - originY) * UNIT;
      baked[i * 3 + 2] = (baked[i * 3 + 2] - originZ) * UNIT;
    }

    const index = original.index?.array as ArrayLike<number> | undefined;
    const indices = index ?? Uint32Array.from({ length: count }, (_, i) => i);
    const triangles = Math.floor(indices.length / 3);
    const pieces = new Map<Piece, number[]>();
    for (const piece of PIECES) pieces.set(piece, []);

    for (let t = 0; t < triangles; t++) {
      const a = indices[t * 3];
      const b = indices[t * 3 + 1];
      const c = indices[t * 3 + 2];
      const cx = (baked[a * 3] + baked[b * 3] + baked[c * 3]) / 3;
      const cy = (baked[a * 3 + 1] + baked[b * 3 + 1] + baked[c * 3 + 1]) / 3;
      const side = cx > 0 ? 'L' : 'R';
      if (cy < ankleY) pieces.get(`foot${side}` as Piece)!.push(a, b, c);
      else if (cy < kneeY) pieces.get(`shin${side}` as Piece)!.push(a, b, c);
      else if (cy < hipY) pieces.get(`thigh${side}` as Piece)!.push(a, b, c);
      else if (cy > ARM_CUT_Y && Math.abs(cx) > ARM_CUT * HEIGHT) continue;
      else if (cy > neckY) pieces.get('head')!.push(a, b, c);
      else pieces.get('torso')!.push(a, b, c);
    }

    const material = (mesh.material as THREE.MeshStandardMaterial).clone();
    material.roughness = Math.max(0.32, material.roughness);
    material.envMapIntensity = 1.1;
    if (material.map) material.map.anisotropy = 4;
    material.needsUpdate = true;

    surfaces.push({
      material,
      positions: baked,
      normals: bakedNormals,
      uv: uvAttribute ? Float32Array.from(uvAttribute.array as ArrayLike<number>) : null,
      pieces,
    });
  }

  // --- Assemble the pieces --------------------------------------------------
  const geometryOf = (surface: Surface, piece: Piece): THREE.BufferGeometry => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(surface.positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(surface.normals, 3));
    if (surface.uv) geometry.setAttribute('uv', new THREE.Float32BufferAttribute(surface.uv, 2));
    geometry.setIndex(surface.pieces.get(piece)!);
    geometry.computeBoundingSphere();
    return geometry;
  };

  /** One pivot, with every material that belongs to that piece inside it. */
  const pieceGroup = (piece: Piece, joint: THREE.Vector3, parent: THREE.Object3D, parentOrigin: THREE.Vector3): THREE.Group => {
    const holder = new THREE.Group();
    holder.position.copy(joint).sub(parentOrigin);
    for (const surface of surfaces) {
      if (surface.pieces.get(piece)!.length === 0) continue;
      const mesh = new THREE.Mesh(geometryOf(surface, piece), surface.material);
      mesh.position.copy(joint).multiplyScalar(-1);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      holder.add(mesh);
    }
    parent.add(holder);
    return holder;
  };

  const leather = new THREE.MeshStandardMaterial({
    color: 0x141419,
    roughness: 0.78,
    metalness: 0,
    envMapIntensity: 0.18,
  });

  const group = new THREE.Group();
  group.name = 'rider';

  // root (saddle) -> pelvis (hip line) -> spine (torso) -> head, arms.
  //                \-> thighs -> shins -> boots
  const pelvis = new THREE.Group();
  pelvis.position.set(0, hipY, 0);
  group.add(pelvis);
  const spine = new THREE.Group();
  pelvis.add(spine);

  const hipOrigin = new THREE.Vector3(0, hipY, 0);
  pieceGroup('torso', hipOrigin, spine, hipOrigin);
  const headGroup = pieceGroup('head', new THREE.Vector3(0, neckY, 0), spine, hipOrigin);

  const ball = (radius: number): THREE.Mesh => new THREE.Mesh(new THREE.SphereGeometry(radius, 12, 9), leather);

  const thighLen = hipY - kneeY;
  const shinLen = kneeY - ankleY;
  const armUpper = 0.3;
  const armFore = 0.26;

  interface Limb {
    side: number;
    thigh: THREE.Group;
    shin: THREE.Group;
    boot: THREE.Group;
    shoulder: THREE.Group;
    forearm: THREE.Group;
    upperArm: THREE.Mesh;
    foreArm: THREE.Mesh;
    glove: THREE.Mesh;
  }
  const limbs: Limb[] = [];

  for (const side of [1, -1]) {
    const suffix = side > 0 ? 'L' : 'R';
    const hipJoint = new THREE.Vector3(side * 0.088, hipY, 0);
    const kneeJoint = new THREE.Vector3(side * 0.09, kneeY, 0);
    const ankleJoint = new THREE.Vector3(side * 0.09, ankleY, 0);

    const thighGroup = pieceGroup(`thigh${suffix}` as Piece, hipJoint, pelvis, hipOrigin);
    const shinGroup = new THREE.Group();
    shinGroup.position.set(0, -thighLen, 0);
    thighGroup.add(shinGroup);
    for (const surface of surfaces) {
      if (surface.pieces.get(`shin${suffix}` as Piece)!.length === 0) continue;
      const mesh = new THREE.Mesh(geometryOf(surface, `shin${suffix}` as Piece), surface.material);
      mesh.position.copy(kneeJoint).multiplyScalar(-1);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      shinGroup.add(mesh);
    }

    const bootGroup = new THREE.Group();
    bootGroup.position.set(0, -shinLen, 0);
    shinGroup.add(bootGroup);
    for (const surface of surfaces) {
      if (surface.pieces.get(`foot${suffix}` as Piece)!.length === 0) continue;
      const mesh = new THREE.Mesh(geometryOf(surface, `foot${suffix}` as Piece), surface.material);
      mesh.position.copy(ankleJoint).multiplyScalar(-1);
      mesh.castShadow = true;
      bootGroup.add(mesh);
    }

    // Rotules sous les coupes : elles suivent l'articulation, pas le morceau.
    const hipBall = ball(0.085);
    hipBall.position.copy(hipJoint).sub(hipOrigin);
    pelvis.add(hipBall);
    shinGroup.add(ball(0.07));
    thighGroup.add(ball(0.075));

    const shoulderJoint = new THREE.Vector3(side * 0.19, shoulderY - 0.01, 0);
    const shoulder = new THREE.Group();
    shoulder.position.copy(shoulderJoint).sub(hipOrigin);
    spine.add(shoulder);
    const deltoid = ball(0.085);
    deltoid.position.set(-side * 0.015, -0.03, 0.004);
    deltoid.scale.set(1.04, 0.92, 1.02);
    deltoid.castShadow = true;
    shoulder.add(deltoid);

    const upperArm = new THREE.Mesh(sleeve(armUpper, 0.05, 0.044), leather);
    upperArm.castShadow = true;
    shoulder.add(upperArm);

    const forearm = new THREE.Group();
    forearm.position.set(0, -armUpper, 0);
    shoulder.add(forearm);
    const foreArm = new THREE.Mesh(sleeve(armFore, 0.044, 0.038), leather);
    foreArm.castShadow = true;
    forearm.add(foreArm);
    forearm.add(ball(0.043));
    const glove = new THREE.Mesh(new THREE.SphereGeometry(0.048, 12, 9), leather);
    glove.position.set(0, -armFore, 0);
    glove.scale.set(0.9, 0.8, 1.2);
    glove.castShadow = true;
    forearm.add(glove);

    limbs.push({ side, thigh: thighGroup, shin: shinGroup, boot: bootGroup, shoulder, forearm, upperArm, foreArm, glove });
  }

  const anchors: RiderAnchors = {
    gripL: new THREE.Vector3(0.24, 1.02, -0.3),
    gripR: new THREE.Vector3(-0.24, 1.02, -0.3),
    footL: new THREE.Vector3(0.2, 0.36, 0.06),
    footR: new THREE.Vector3(-0.2, 0.36, 0.06),
  };

  // --- IK -------------------------------------------------------------------
  const dir = new THREE.Vector3();
  const mid = new THREE.Vector3();
  const bend = new THREE.Vector3();
  const lowerDir = new THREE.Vector3();
  const inverse = new THREE.Quaternion();
  const boneInverse = new THREE.Quaternion();
  const spineInverse = new THREE.Quaternion();
  const hipPoint = new THREE.Vector3();
  const target = new THREE.Vector3();
  const armTarget = new THREE.Vector3();

  /** Two-bone IK: `goal` and `rootJoint` in the parent's space. */
  const solve = (
    upper: THREE.Object3D,
    lower: THREE.Object3D,
    rootJoint: THREE.Vector3,
    goal: THREE.Vector3,
    upperLen: number,
    lowerLen: number,
    bendHint: THREE.Vector3,
  ): void => {
    dir.copy(goal).sub(rootJoint);
    let distance = dir.length();
    const reach = upperLen + lowerLen - 1e-3;
    const minimum = Math.abs(upperLen - lowerLen) + 1e-3;
    if (distance < 1e-4) {
      dir.set(0, -1, 0);
      distance = 1e-4;
    } else if (distance > reach) {
      dir.multiplyScalar(reach / distance);
      distance = reach;
    } else if (distance < minimum) {
      dir.multiplyScalar(minimum / distance);
      distance = minimum;
    }
    dir.multiplyScalar(1 / distance);

    const cos = (upperLen * upperLen + distance * distance - lowerLen * lowerLen) / (2 * upperLen * distance);
    const along = upperLen * Math.max(-1, Math.min(1, cos));
    const height = Math.sqrt(Math.max(0, upperLen * upperLen - along * along));

    bend.copy(bendHint).addScaledVector(dir, -bendHint.dot(dir));
    if (bend.lengthSq() < 1e-6) bend.set(0, 0, -1);
    bend.normalize();

    mid.copy(rootJoint).addScaledVector(dir, along).addScaledVector(bend, height);
    upper.quaternion.copy(quatFromTo(DOWN, mid.clone().sub(rootJoint).normalize()));

    lowerDir.copy(goal).sub(mid).normalize();
    boneInverse.copy(upper.quaternion).invert();
    lowerDir.applyQuaternion(boneInverse);
    lower.quaternion.copy(quatFromTo(DOWN, lowerDir));
  };

  // Le pilote regarde -Z : ses genoux sortent donc vers l'avant (-Z) entre la
  // hanche et le repose-pied, sinon la jambe se plie à l'envers.
  const legBend = new THREE.Vector3(0, -0.4, -1);
  const armBend = new THREE.Vector3(0, -0.5, -0.1);

  return {
    group,
    anchors,
    update(pose: RiderPose) {
      const load = Math.max(-1, Math.min(1, pose.accel / 9));
      const brace = Math.max(0, Math.min(1, pose.brake));
      const wheelie = Math.max(0, Math.min(1, pose.pitch / 0.9));
      const breathe = Math.sin(pose.time * 2.1) * 0.012;

      spine.rotation.x = 0.17 + load * 0.15 - brace * 0.09 - wheelie * 0.22 + breathe;
      spine.rotation.z = -pose.lean * 0.3;
      spine.rotation.y = pose.steer * 0.12;
      headGroup.rotation.x = -spine.rotation.x * 0.75;
      headGroup.rotation.z = pose.lean * 0.24;

      pelvis.rotation.z = -pose.lean * 0.1;
      pelvis.rotation.x = -pose.pitch * 0.16;

      inverse.copy(pelvis.quaternion).invert();
      spineInverse.copy(spine.quaternion).invert();

      for (const limb of limbs) {
        const left = limb.side > 0;

        target.copy(left ? anchors.footL : anchors.footR).sub(hipOrigin);
        target.applyQuaternion(inverse);
        hipPoint.set(limb.side * 0.088, 0, 0);
        solve(limb.thigh, limb.shin, hipPoint, target, thighLen, shinLen, legBend);
        limb.boot.quaternion.copy(limb.thigh.quaternion).multiply(limb.shin.quaternion).invert();

        armTarget.copy(left ? anchors.gripL : anchors.gripR).sub(hipOrigin).applyQuaternion(inverse);
        armTarget.applyQuaternion(spineInverse);
        hipPoint.copy(limb.shoulder.position);
        armBend.set(limb.side * 0.9, -0.4, -0.15);
        const reachToGrip = armTarget.distanceTo(hipPoint);
        const upperLen = Math.max(0.16, reachToGrip * 0.55);
        const foreLen = Math.max(0.14, reachToGrip * 0.51);
        solve(limb.shoulder, limb.forearm, hipPoint, armTarget, upperLen, foreLen, armBend);
        limb.upperArm.scale.y = upperLen / armUpper;
        limb.foreArm.scale.y = foreLen / armFore;
        limb.forearm.position.y = -upperLen;
        limb.glove.position.y = -foreLen;
      }
    },
    dispose() {
      group.traverse((child) => {
        const part = child as THREE.Mesh;
        if (part.isMesh) part.geometry.dispose();
      });
      for (const surface of surfaces) surface.material.dispose();
      leather.dispose();
    },
  };
}
