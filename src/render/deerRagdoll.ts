import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { GROUP_GROUND, GROUP_RAGDOLL, GROUP_WORLD } from '../physics/vehicle.ts';

/**
 * Ragdoll du cerf : onze corps dynamiques reliés par des joints sphériques,
 * construits sur la pose courante du squelette. Chaque corps pilote son os, et
 * le maillage squeletté suit — le mixer est arrêté pendant ce temps.
 *
 * Le GLB est ramené à 3,4 m par un `scale` sur la scène du modèle. Les poses
 * Rapier sont donc ramenées dans l'espace de cette scène avant d'être
 * décomposées en transformations d'os : sans ça, chaque os hériterait du
 * facteur inverse et la bête rétrécirait image après image.
 */
export interface DeerRagdoll {
  update(): void;
  dispose(): void;
}

interface PartSpec {
  bone: string;
  /** Extrémité du membre, pour la capsule ; le corps reste à l'os. */
  tip: string | null;
  /** Os parent, qui porte le joint sphérique. */
  parent: string | null;
  radius: number;
  mass: number;
}

/** Hanches, colonne, tête, bras et jambes : assez pour tomber comme un corps. */
const PARTS: PartSpec[] = [
  { bone: 'C_Hip_J_00', tip: 'C_spine_04_J_021', parent: null, radius: 0.3, mass: 20 },
  { bone: 'C_spine_04_J_021', tip: 'C_Head_J_023', parent: 'C_Hip_J_00', radius: 0.28, mass: 16 },
  { bone: 'C_Head_J_023', tip: null, parent: 'C_spine_04_J_021', radius: 0.3, mass: 7 },
  { bone: 'L_shoulder_J_034', tip: 'L_elbow_J_035', parent: 'C_spine_04_J_021', radius: 0.14, mass: 4 },
  { bone: 'L_elbow_J_035', tip: 'L_wrist_J_036', parent: 'L_shoulder_J_034', radius: 0.12, mass: 3 },
  { bone: 'R_shoulder_J_053', tip: 'R_elbow_J_054', parent: 'C_spine_04_J_021', radius: 0.14, mass: 4 },
  { bone: 'R_elbow_J_054', tip: 'R_wrist_J_055', parent: 'R_shoulder_J_053', radius: 0.12, mass: 3 },
  { bone: 'L_upper_leg_J_072', tip: 'L_knee_J_073', parent: 'C_Hip_J_00', radius: 0.18, mass: 9 },
  { bone: 'L_knee_J_073', tip: 'L_ankle_J_074', parent: 'L_upper_leg_J_072', radius: 0.14, mass: 5 },
  { bone: 'R_upper_leg_J_078', tip: 'R_knee_J_079', parent: 'C_Hip_J_00', radius: 0.18, mass: 9 },
  { bone: 'R_knee_J_079', tip: 'R_ankle_J_080', parent: 'R_upper_leg_J_078', radius: 0.14, mass: 5 },
];

/**
 * Les morceaux du ragdoll ne se cognent pas entre eux (membre propre hors du
 * filtre), mais restent solides pour la route et la caisse.
 */
const RAGDOLL_GROUPS = (GROUP_RAGDOLL << 16) | (GROUP_WORLD | GROUP_GROUND);

const UP = new THREE.Vector3(0, 1, 0);

export function spawnDeerRagdoll(
  world: RAPIER.World,
  scene: THREE.Object3D,
  velocity: THREE.Vector3,
): DeerRagdoll | null {
  scene.updateMatrixWorld(true);

  const bones = new Map<string, THREE.Bone>();
  const bonePos = new Map<string, THREE.Vector3>();
  const boneQuat = new Map<string, THREE.Quaternion>();
  for (const spec of PARTS) {
    const found = scene.getObjectByName(spec.bone);
    if (!found) return null;
    const bone = found as THREE.Bone;
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    bone.matrixWorld.decompose(pos, quat, scale);
    bones.set(spec.bone, bone);
    bonePos.set(spec.bone, pos);
    boneQuat.set(spec.bone, quat);
  }

  const parts: {
    spec: PartSpec;
    bone: THREE.Bone;
    body: RAPIER.RigidBody;
    /** Échelle héritée par l'os : la pose Rapier doit la porter pour que la
     *  transformation locale reste à 1 au lieu d'absorber 1/échelle. */
    scale: THREE.Vector3;
  }[] = [];
  for (const spec of PARTS) {
    const bone = bones.get(spec.bone)!;
    const pos = bonePos.get(spec.bone)!;
    const quat = boneQuat.get(spec.bone)!;
    const scale = new THREE.Vector3();
    bone.parent?.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), scale);
    if (scale.x === 0) scale.set(1, 1, 1);
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(pos.x, pos.y, pos.z)
        .setRotation({ x: quat.x, y: quat.y, z: quat.z, w: quat.w })
        .setLinearDamping(0.12)
        .setAngularDamping(0.55),
    );
    world.createCollider(buildCollider(spec, boneQuat, bonePos), body);
    parts.push({ spec, bone, body, scale });
  }

  // Les jointures tombent à l'os de l'enfant : chaque corps tourne autour de
  // l'articulation qui le relie à son parent.
  for (const part of parts) {
    if (!part.spec.parent) continue;
    const parent = parts.find((entry) => entry.spec.bone === part.spec.parent);
    if (!parent) continue;
    const anchor = new THREE.Vector3()
      .subVectors(bonePos.get(part.spec.bone)!, bonePos.get(parent.spec.bone)!)
      .applyQuaternion(boneQuat.get(parent.spec.bone)!.clone().invert());
    world.createImpulseJoint(
      RAPIER.JointData.spherical(
        { x: anchor.x, y: anchor.y, z: anchor.z },
        { x: 0, y: 0, z: 0 },
      ),
      parent.body,
      part.body,
      true,
    );
  }

  // Le choc projette la bête devant la voiture, membres en pagaille.
  for (const part of parts) {
    part.body.setLinvel(
      {
        x: velocity.x * 0.55 + (Math.random() - 0.5) * 1.6,
        y: 1.4 + Math.random() * 2.2,
        z: velocity.z * 0.55 + (Math.random() - 0.5) * 1.6,
      },
      true,
    );
    part.body.setAngvel(
      {
        x: (Math.random() - 0.5) * 9,
        y: (Math.random() - 0.5) * 9,
        z: (Math.random() - 0.5) * 9,
      },
      true,
    );
  }

  // Matrices réutilisées : `update` tourne à chaque image.
  const bodyWorld = new THREE.Matrix4();
  const local = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const rotation = new THREE.Quaternion();

  return {
    update(): void {
      for (const part of parts) {
        const t = part.body.translation();
        const r = part.body.rotation();
        rotation.set(r.x, r.y, r.z, r.w);
        bodyWorld.compose(position.set(t.x, t.y, t.z), rotation, part.scale);
        // La matrice monde du parent porte déjà le scale du GLB : il s'annule
        // ici, et l'os garde une échelle de 1 au lieu de la réduire à chaque
        // image.
        const parent = part.bone.parent;
        if (parent) {
          local.copy(parent.matrixWorld).invert().multiply(bodyWorld);
        } else {
          local.copy(bodyWorld);
        }
        local.decompose(part.bone.position, part.bone.quaternion, part.bone.scale);
        // Toute la descendance : le cou, le poignet ou la cheville entre deux
        // morceaux doivent être à jour avant que leur enfant soit posé.
        part.bone.updateWorldMatrix(false, true);
      }
    },
    dispose(): void {
      for (const part of parts) world.removeRigidBody(part.body);
    },
  };
}

/** Capsule le long du membre, ou bille pour une extrémité (tête, mains). */
function buildCollider(
  spec: PartSpec,
  boneQuat: Map<string, THREE.Quaternion>,
  bonePos: Map<string, THREE.Vector3>,
): RAPIER.ColliderDesc {
  let desc: RAPIER.ColliderDesc;
  const tip = spec.tip ? bonePos.get(spec.tip) : null;
  if (tip) {
    const start = bonePos.get(spec.bone)!;
    const along = new THREE.Vector3().subVectors(tip, start);
    const length = along.length();
    const axis = along.normalize();
    const localAxis = axis.applyQuaternion(boneQuat.get(spec.bone)!.clone().invert());
    const rotation = new THREE.Quaternion().setFromUnitVectors(UP, localAxis);
    const half = Math.max(0.01, length / 2 - spec.radius);
    desc = RAPIER.ColliderDesc.capsule(half, spec.radius)
      .setTranslation(
        (localAxis.x * length) / 2,
        (localAxis.y * length) / 2,
        (localAxis.z * length) / 2,
      )
      .setRotation({ x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w });
  } else {
    desc = RAPIER.ColliderDesc.ball(spec.radius);
  }
  return desc
    .setMass(spec.mass)
    .setFriction(0.85)
    .setRestitution(0.04)
    .setCollisionGroups(RAGDOLL_GROUPS);
}
