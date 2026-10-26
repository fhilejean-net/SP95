import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/**
 * The modelled pillion.
 *
 * The GLB is a single static mesh of a woman standing with one hand on her
 * hip. Skinning such a mesh with a guessed skeleton is what stretched her thigh
 * towards the bars: the weights pull the wrong vertices, and the two arms never
 * match the pose the bike needs.
 *
 * So the mesh is cut instead of deformed. The torso, the head and the legs
 * become rigid pieces, each one pivoting around a real joint (hip, knee,
 * ankle): a piece keeps its shape, so nothing can stretch. Ball joints in the
 * same leather hide the seams at the knees and the hips.
 *
 * The arms are the one part that cannot survive the cut: the source has one arm
 * hanging and one bent onto the hip, and a riding pose needs both hands on the
 * grips. They are rebuilt as tapered leather sleeves, and a two-bone IK solves
 * each one against the handlebar so the gloves actually hold the bars — even
 * when the bar turns or the rider leans on the tank.
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
const HEIGHT = 1.68;
/** Source mesh height, in model units. */
const SOURCE_HEIGHT = 1.0016;

/** Joint heights as a fraction of the standing height. */
const HIP = 0.472;
/** Height of the hip line above the rider group's origin, metres. */
export const RIDER_HIP_HEIGHT = HIP * 1.68;
const KNEE = 0.268;
const ANKLE = 0.062;
const SHOULDER = 0.805;
const NECK = 0.848;

const loader = new GLTFLoader();
const MODEL_ROOT = import.meta.env.BASE_URL;

const DOWN = new THREE.Vector3(0, -1, 0);

function quatFromTo(from: THREE.Vector3, to: THREE.Vector3): THREE.Quaternion {
  return new THREE.Quaternion().setFromUnitVectors(from, to.clone().normalize());
}

/** A tapered leather sleeve, hung from its joint. */
function sleeve(length: number, top: number, bottom: number): THREE.BufferGeometry {
  const geometry = new THREE.CylinderGeometry(top, bottom, length, 10, 1, false);
  geometry.translate(0, -length / 2, 0);
  return geometry;
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

  // Model space -> rider space: human height, feet on y = 0, facing -Z like
  // the bike, centred on the spine.
  const scale = HEIGHT / SOURCE_HEIGHT;
  const yaw = new THREE.Matrix4().makeRotationY(Math.PI / 2).multiply(source.matrixWorld);
  const vertex = new THREE.Vector3();
  const baked = new Float32Array(count * 3);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < count; i++) {
    vertex.set(position.getX(i), position.getY(i), position.getZ(i)).applyMatrix4(yaw);
    baked[i * 3] = vertex.x;
    baked[i * 3 + 1] = vertex.y;
    baked[i * 3 + 2] = vertex.z;
    minX = Math.min(minX, vertex.x);
    maxX = Math.max(maxX, vertex.x);
    minY = Math.min(minY, vertex.y);
    minZ = Math.min(minZ, vertex.z);
    maxZ = Math.max(maxZ, vertex.z);
  }
  const centreZ = (minZ + maxZ) / 2;
  for (let i = 0; i < count; i++) {
    baked[i * 3] = (baked[i * 3] - (minX + maxX) / 2) * scale;
    baked[i * 3 + 1] = (baked[i * 3 + 1] - minY) * scale;
    baked[i * 3 + 2] = (baked[i * 3 + 2] - centreZ) * scale;
  }

  const positions = new THREE.Float32BufferAttribute(baked, 3);
  const normals = new Float32Array(count * 3);
  if (normal) {
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(yaw);
    for (let i = 0; i < count; i++) {
      vertex.set(normal.getX(i), normal.getY(i), normal.getZ(i)).applyMatrix3(normalMatrix).normalize();
      normals[i * 3] = vertex.x;
      normals[i * 3 + 1] = vertex.y;
      normals[i * 3 + 2] = vertex.z;
    }
  } else {
    for (let i = 0; i < count; i++) normals[i * 3 + 1] = 1;
  }
  const normalAttribute = new THREE.Float32BufferAttribute(normals, 3);
  const uvAttribute = uv ? new THREE.Float32BufferAttribute(Float32Array.from(uv.array as ArrayLike<number>), 2) : null;

  // --- Cut the mesh into rigid pieces --------------------------------------
  const hipY = HIP * HEIGHT;
  const kneeY = KNEE * HEIGHT;
  const ankleY = ANKLE * HEIGHT;
  const shoulderY = SHOULDER * HEIGHT;
  const neckY = NECK * HEIGHT;

  /**
   * The arms are cut along the two chains the source pose actually has: one
   * hanging from the shoulder, one bent down onto the hip. A plain |x| test
   * leaves the inner half of the sleeve behind, which is what looked like a
   * tube sticking out of her chest.
   */
  const armChain = [
    new THREE.Vector3(0.152, 1.352, 0),
    new THREE.Vector3(0.168, 1.05, 0.01),
    new THREE.Vector3(0.155, 0.82, 0.015),
    new THREE.Vector3(0.11, 0.8, 0.01),
  ];
  const distanceToChain = (x: number, y: number, z: number): number => {
    let best = Infinity;
    for (let i = 0; i < armChain.length - 1; i++) {
      const a = armChain[i];
      const b = armChain[i + 1];
      const abx = b.x - a.x;
      const aby = b.y - a.y;
      const abz = b.z - a.z;
      const lengthSq = abx * abx + aby * aby + abz * abz || 1;
      const t = Math.max(0, Math.min(1, ((x - a.x) * abx + (y - a.y) * aby + (z - a.z) * abz) / lengthSq));
      const dx = x - (a.x + abx * t);
      const dy = y - (a.y + aby * t);
      const dz = z - (a.z + abz * t);
      best = Math.min(best, dx * dx + dy * dy + dz * dz);
    }
    return Math.sqrt(best);
  };
  const isArm = (x: number, y: number, z: number) =>
    y > 0.7 && (distanceToChain(Math.abs(x), y, z) < 0.075 || (Math.abs(x) > 0.152 && y > 0.82));

  const torso: number[] = [];
  const head: number[] = [];
  const thigh: number[][] = [[], []];
  const shin: number[][] = [[], []];
  const foot: number[][] = [[], []];

  const rawIndex = original.index?.array as ArrayLike<number> | undefined;
  const indices = rawIndex ?? Uint32Array.from({ length: count }, (_, i) => i);
  const triangleCount = Math.floor(indices.length / 3);

  for (let t = 0; t < triangleCount; t++) {
    const a = indices[t * 3];
    const b = indices[t * 3 + 1];
    const c = indices[t * 3 + 2];
    const cx = (baked[a * 3] + baked[b * 3] + baked[c * 3]) / 3;
    const cy = (baked[a * 3 + 1] + baked[b * 3 + 1] + baked[c * 3 + 1]) / 3;
    const side = cx > 0 ? 0 : 1;

    if (cy < ankleY) foot[side].push(a, b, c);
    else if (cy < kneeY) shin[side].push(a, b, c);
    else if (cy < hipY) thigh[side].push(a, b, c);
    else if (isArm(cx, cy, (baked[a * 3 + 2] + baked[b * 3 + 2] + baked[c * 3 + 2]) / 3)) continue;
    else if (cy > neckY) head.push(a, b, c);
    else torso.push(a, b, c);
  }

  const build = (triangles: number[]): THREE.BufferGeometry => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', positions);
    geometry.setAttribute('normal', normalAttribute);
    if (uvAttribute) geometry.setAttribute('uv', uvAttribute);
    geometry.setIndex(triangles);
    geometry.computeBoundingSphere();
    return geometry;
  };

  const sourceMaterial = (mesh.material as THREE.MeshStandardMaterial).clone();
  sourceMaterial.roughness = Math.max(0.32, sourceMaterial.roughness);
  sourceMaterial.envMapIntensity = 1.15;
  sourceMaterial.needsUpdate = true;

  const leather = new THREE.MeshStandardMaterial({
    color: 0x141419,
    roughness: 0.36,
    metalness: 0.3,
    envMapIntensity: 1.2,
  });

  const group = new THREE.Group();
  group.name = 'rider';

  // --- Hierarchy ------------------------------------------------------------
  // root (saddle) -> pelvis (hip line) -> spine (torso) -> head, arms.
  //                \-> thighs -> shins -> boots
  const pelvis = new THREE.Group();
  pelvis.position.set(0, hipY, 0);
  group.add(pelvis);

  const spine = new THREE.Group();
  pelvis.add(spine);

  const piece = (
    triangles: number[],
    joint: THREE.Vector3,
    parent: THREE.Object3D,
    parentOrigin: THREE.Vector3,
    material: THREE.Material,
  ): THREE.Group => {
    const holder = new THREE.Group();
    holder.position.copy(joint).sub(parentOrigin);
    const part = new THREE.Mesh(build(triangles), material);
    part.position.copy(joint).multiplyScalar(-1);
    part.castShadow = true;
    part.receiveShadow = true;
    holder.add(part);
    parent.add(holder);
    return holder;
  };

  const hipOrigin = new THREE.Vector3(0, hipY, 0);
  piece(torso, hipOrigin, spine, hipOrigin, sourceMaterial);
  const headGroup = piece(head, new THREE.Vector3(0, neckY, 0), spine, hipOrigin, sourceMaterial);

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
    /** Sleeve meshes, stretched to whatever the grip asks for. */
    upperArm: THREE.Mesh;
    foreArm: THREE.Mesh;
    glove: THREE.Mesh;
  }
  const limbs: Limb[] = [];

  for (const side of [1, -1]) {
    const which = side > 0 ? 0 : 1;
    const hipJoint = new THREE.Vector3(side * 0.085, hipY, 0);
    const kneeJoint = new THREE.Vector3(side * 0.09, kneeY, 0);
    const ankleJoint = new THREE.Vector3(side * 0.09, ankleY, 0);

    const thighGroup = piece(thigh[which], hipJoint, pelvis, hipOrigin, sourceMaterial);
    const shinGroup = new THREE.Group();
    shinGroup.position.set(0, -thighLen, 0);
    thighGroup.add(shinGroup);
    const shinMesh = new THREE.Mesh(build(shin[which]), sourceMaterial);
    shinMesh.position.copy(kneeJoint).multiplyScalar(-1);
    shinMesh.castShadow = true;
    shinMesh.receiveShadow = true;
    shinGroup.add(shinMesh);

    const bootGroup = new THREE.Group();
    bootGroup.position.set(0, -shinLen, 0);
    shinGroup.add(bootGroup);
    const bootMesh = new THREE.Mesh(build(foot[which]), sourceMaterial);
    bootMesh.position.copy(ankleJoint).multiplyScalar(-1);
    bootMesh.castShadow = true;
    bootGroup.add(bootMesh);

    // Ball joints under the cut edges.
    const hipBall = ball(0.08);
    hipBall.position.copy(hipJoint).sub(hipOrigin);
    pelvis.add(hipBall);
    shinGroup.add(ball(0.066));
    thighGroup.add(ball(0.072));

    // --- Arms -------------------------------------------------------------
    // Slightly inboard of the sleeve: the deltoid has to sit inside the jacket
    // or the arm reads as a pipe bolted to the collarbone.
    const shoulderJoint = new THREE.Vector3(side * 0.128, shoulderY - 0.01, 0);
    const shoulder = new THREE.Group();
    shoulder.position.copy(shoulderJoint).sub(hipOrigin);
    spine.add(shoulder);
    shoulder.add(ball(0.075));

    const upperArm = new THREE.Mesh(sleeve(armUpper, 0.047, 0.042), leather);
    upperArm.castShadow = true;
    shoulder.add(upperArm);

    const forearm = new THREE.Group();
    forearm.position.set(0, -armUpper, 0);
    shoulder.add(forearm);
    const foreArm = new THREE.Mesh(sleeve(armFore, 0.042, 0.036), leather);
    foreArm.castShadow = true;
    forearm.add(foreArm);
    forearm.add(ball(0.042));
    const glove = new THREE.Mesh(new THREE.SphereGeometry(0.045, 12, 9), leather);
    glove.position.set(0, -armFore, 0);
    glove.scale.set(0.9, 0.8, 1.2);
    glove.castShadow = true;
    forearm.add(glove);

    limbs.push({
      side,
      thigh: thighGroup,
      shin: shinGroup,
      boot: bootGroup,
      shoulder,
      forearm,
      upperArm,
      foreArm,
      glove,
    });
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
  // Kept apart from `inverse`: the solver runs inside the loop that uses it.
  const boneInverse = new THREE.Quaternion();
  const spineInverse = new THREE.Quaternion();
  const hipPoint = new THREE.Vector3();
  const target = new THREE.Vector3();
  const armTarget = new THREE.Vector3();

  /**
   * Two-bone IK. `rootJoint` and `goal` are in the parent's space; the middle
   * joint bends towards `bendHint` (made perpendicular to the chain).
   */
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

  const legBend = new THREE.Vector3(0, -0.4, 1);
  const armBend = new THREE.Vector3(0, -0.5, -0.1);

  return {
    group,
    anchors,
    update(pose: RiderPose) {
      const load = Math.max(-1, Math.min(1, pose.accel / 9));
      const brace = Math.max(0, Math.min(1, pose.brake));
      const wheelie = Math.max(0, Math.min(1, pose.pitch / 0.9));
      const breathe = Math.sin(pose.time * 2.1) * 0.012;

      // Spine: on the tank under power, braced back on the brakes, pulled down
      // by gravity in a wheelie.
      spine.rotation.x = 0.17 + load * 0.15 - brace * 0.09 - wheelie * 0.22 + breathe;
      spine.rotation.z = -pose.lean * 0.3;
      spine.rotation.y = pose.steer * 0.12;
      headGroup.rotation.x = -spine.rotation.x * 0.75;
      headGroup.rotation.z = pose.lean * 0.24;

      // A rider counter-steers with his hips: the pelvis leans less than the
      // bike, and follows the wheelie a little.
      pelvis.rotation.z = -pose.lean * 0.1;
      pelvis.rotation.x = -pose.pitch * 0.16;

      // Everything below works in the pelvis frame.
      inverse.copy(pelvis.quaternion).invert();
      spineInverse.copy(spine.quaternion).invert();

      for (const limb of limbs) {
        const left = limb.side > 0;

        // --- Leg: hip -> boot on the peg ---
        target.copy(left ? anchors.footL : anchors.footR).sub(hipOrigin);
        target.applyQuaternion(inverse);
        hipPoint.set(limb.side * 0.085, 0, 0);
        solve(limb.thigh, limb.shin, hipPoint, target, thighLen, shinLen, legBend);
        // Boots stay as modelled: flat, toes forward.
        limb.boot.quaternion.copy(limb.thigh.quaternion).multiply(limb.shin.quaternion).invert();

        // --- Arm: shoulder -> grip ---
        // The shoulders hang off the spine, so the grip has to come all the way
        // down into that frame before the IK sees it: otherwise the arms point
        // wherever the torso happens to be rotated.
        armTarget.copy(left ? anchors.gripL : anchors.gripR).sub(hipOrigin).applyQuaternion(inverse);
        armTarget.applyQuaternion(spineInverse);
        hipPoint.copy(limb.shoulder.position);
        armBend.set(limb.side * 0.9, -0.4, -0.15);
        // The sleeves stretch to the distance the bar asks for. A rider's arm
        // is not a fixed length between the saddle and the grips, and stretching
        // the sleeve is invisible where a floating hand would be obvious.
        const reachToGrip = armTarget.distanceTo(hipPoint);
        // 6 % over the distance, so the elbow keeps a bend instead of locking
        // into a straight tube when the rider leans on the bars.
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
      sourceMaterial.dispose();
      leather.dispose();
    },
  };
}
