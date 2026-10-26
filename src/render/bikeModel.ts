import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { BikeSpec } from '../physics/bike.ts';
import { createRider, type BikePose, type BikeVisual } from './bike.ts';
import { RIDER_HIP_HEIGHT, loadRiderVisual, type RiderVisual } from './riderModel.ts';

/**
 * The modelled bike.
 *
 * The GLB arrives as ~1600 small meshes, which is 1600 draw calls a frame.
 * They are baked into four blocks instead — the chassis, the steering head,
 * the sliding fork and the two wheels — merged per material. Baking also lets
 * the wheels and the fork be re-parented onto their own pivots.
 *
 * The front end is the interesting part. The model keeps the fork, the top
 * clamp, the bars and both tire halves as separate siblings, so taking only
 * `Complete_front_wheel1` as "the front wheel" leaves the tire carcass glued
 * to the frame and the bars steering nothing. Every mesh is therefore
 * classified by the nearest named ancestor: the front end turns around the
 * real steering axis (measured from the wheel hub to the top clamp), and the
 * lower fork slides inside the upper legs with the suspension.
 *
 * The pose is the same three pivots as the procedural bike: the ground line
 * under the rear contact, the lean around that line, and the wheelie around
 * the rear contact patch. The terrain pitch and roll are added to the lean and
 * the wheelie so a bike on a downhill follows the hill instead of floating
 * horizontally. Rotating the body itself would lift the tires off the road,
 * which is exactly what a bike visual must never do.
 */

const loader = new GLTFLoader();
const MODEL_ROOT = import.meta.env.BASE_URL;

const FRONT_WHEEL = 'Complete_front_wheel1';
const REAR_WHEEL = 'rear_wheel1';

interface Bake {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
}

type Part = 'body' | 'frontUpper' | 'frontLower' | 'frontWheel' | 'rearWheel';

function meshList(root: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh) out.push(mesh);
  });
  return out;
}

/** Nearest named ancestor that identifies a part of the bike. */
function classify(mesh: THREE.Object3D): Part {
  let node: THREE.Object3D | null = mesh;
  while (node) {
    const name = node.name;
    if (/^(Complete_front_wheel|front_tire_half)/.test(name)) return 'frontWheel';
    if (/^(rear_wheel1$|rear_tire_half)/.test(name)) return 'rearWheel';
    if (/^(lower_fork_tube|front_fender|front_axel|front_brake_caliper|front_brake_pad)/.test(name)) {
      return 'frontLower';
    }
    if (
      /^(fork|forks_top_clamp|Renthal_Limited_Edition_Bars|RENTHAL|front_brake_master|clutch_perch|fork_clamp_bolt|tripple_clamp|renthal_left_hand_grip|waffle_grip|throttle|ignition_stop_button)/.test(
        name,
      )
    ) {
      return 'frontUpper';
    }
    node = node.parent;
  }
  return 'body';
}

/**
 * Copies one mesh into a plain, un-quantized geometry in model space, keeping
 * only what the renderer needs: positions, normals, and vertex colours when the
 * material asks for them. UVs are dropped — this model has no textures.
 */
function bakeMesh(mesh: THREE.Mesh, transform: THREE.Matrix4): THREE.BufferGeometry {
  const source = mesh.geometry;
  const position = source.getAttribute('position');
  const normal = source.getAttribute('normal');
  const colour = source.getAttribute('color');
  const material = mesh.material as THREE.MeshStandardMaterial;
  const count = position.count;

  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    positions[i * 3] = position.getX(i);
    positions[i * 3 + 1] = position.getY(i);
    positions[i * 3 + 2] = position.getZ(i);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

  const normals = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    normals[i * 3] = normal ? normal.getX(i) : 0;
    normals[i * 3 + 1] = normal ? normal.getY(i) : 1;
    normals[i * 3 + 2] = normal ? normal.getZ(i) : 0;
  }
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));

  if (colour && material?.vertexColors) {
    const colours = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      colours[i * 3] = colour.getX(i);
      colours[i * 3 + 1] = colour.getY(i);
      colours[i * 3 + 2] = colour.getZ(i);
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  }

  if (source.index) {
    const src = source.index.array as ArrayLike<number>;
    const index = new Uint32Array(src.length);
    index.set(src as unknown as ArrayLike<number>);
    geometry.setIndex(new THREE.BufferAttribute(index, 1));
  }

  geometry.applyMatrix4(transform);
  return geometry;
}

function groupByMaterial(bakes: Bake[]): Map<THREE.Material, THREE.BufferGeometry[]> {
  const groups = new Map<THREE.Material, THREE.BufferGeometry[]>();
  for (const bake of bakes) {
    const list = groups.get(bake.material);
    if (list) list.push(bake.geometry);
    else groups.set(bake.material, [bake.geometry]);
  }
  return groups;
}

function boxOf(objects: THREE.Object3D[], yaw: THREE.Matrix4): THREE.Box3 {
  const box = new THREE.Box3();
  const corner = new THREE.Vector3();
  for (const object of objects) {
    const local = new THREE.Box3().setFromObject(object);
    for (const x of [0, 1]) {
      for (const y of [0, 1]) {
        for (const z of [0, 1]) {
          corner
            .set(
              x ? local.max.x : local.min.x,
              y ? local.max.y : local.min.y,
              z ? local.max.z : local.min.z,
            )
            .applyMatrix4(yaw);
          box.expandByPoint(corner);
        }
      }
    }
  }
  return box;
}

export async function loadBikeVisual(spec: BikeSpec): Promise<BikeVisual> {
  const [gltf, riderModel] = await Promise.all([
    loader.loadAsync(`${MODEL_ROOT}models/cars/moto.glb`),
    loadRiderVisual(),
  ]);
  const root = gltf.scene;
  root.updateMatrixWorld(true);

  // The model is authored nose-first along -X; the game drives toward -Z.
  const yaw = new THREE.Matrix4().makeRotationY(-Math.PI / 2);

  const frontNode = root.getObjectByName(FRONT_WHEEL);
  const rearNode = root.getObjectByName(REAR_WHEEL);
  if (!frontNode || !rearNode) throw new Error('moto: missing wheel nodes');

  // The tire halves live outside the wheel nodes: include them in the hub and
  // in the wheel group, or half the tire keeps spinning with the frame.
  const frontTires = meshList(root).filter((mesh) => classify(mesh) === 'frontWheel' && !frontNode.getObjectById(mesh.id));
  const rearTires = meshList(root).filter((mesh) => classify(mesh) === 'rearWheel' && !rearNode.getObjectById(mesh.id));
  const frontParts: THREE.Object3D[] = [frontNode, ...frontTires];
  const rearParts: THREE.Object3D[] = [rearNode, ...rearTires];

  const frontBox = boxOf(frontParts, yaw);
  const rearBox = boxOf(rearParts, yaw);
  const frontHub = frontBox.getCenter(new THREE.Vector3());
  const rearHub = rearBox.getCenter(new THREE.Vector3());

  const measuredBase = Math.abs(frontHub.z - rearHub.z);
  if (!(measuredBase > 0.2)) throw new Error('moto: wheelbase not found');

  const scale = spec.wheelbase / measuredBase;
  const halfBase = spec.wheelbase / 2;

  // --- Steering axis -------------------------------------------------------
  const topClamp = root.getObjectByName('forks_top_clamp1');
  const topBox = topClamp
    ? boxOf([topClamp], yaw)
    : new THREE.Box3(
        new THREE.Vector3(frontHub.x, frontHub.y + 0.6, frontHub.z),
        new THREE.Vector3(frontHub.x, frontHub.y + 0.7, frontHub.z),
      );
  const topCentre = topBox.getCenter(new THREE.Vector3());
  const steerAxis = new THREE.Vector3().subVectors(topCentre, frontHub);
  if (steerAxis.lengthSq() < 1e-4) steerAxis.set(0, 1, 0);
  steerAxis.normalize();
  const steerQuat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), steerAxis);
  const steerQuatInv = steerQuat.clone().invert();

  // Wheel hub in the steering frame, and the axle in that same frame.
  const hubInSteer = frontHub.clone().sub(topCentre).applyQuaternion(steerQuatInv);
  const axleInSteer = new THREE.Vector3(1, 0, 0).applyQuaternion(steerQuatInv).normalize();
  const spinQuat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), axleInSteer);
  const spinQuatInv = spinQuat.clone().invert();

  // --- Bake every mesh into its part --------------------------------------
  const yawOnly = new THREE.Matrix4().copy(yaw);
  const toSteer = new THREE.Matrix4()
    .makeRotationFromQuaternion(steerQuatInv)
    .multiply(new THREE.Matrix4().makeTranslation(-topCentre.x, -topCentre.y, -topCentre.z));
  const toWheel = new THREE.Matrix4()
    .makeRotationFromQuaternion(spinQuatInv)
    .multiply(new THREE.Matrix4().makeTranslation(-hubInSteer.x, -hubInSteer.y, -hubInSteer.z))
    .multiply(toSteer);
  const toRear = new THREE.Matrix4().makeTranslation(-rearHub.x, -rearHub.y, -rearHub.z);

  const bodyBakes: Bake[] = [];
  const upperBakes: Bake[] = [];
  const lowerBakes: Bake[] = [];
  const frontWheelBakes: Bake[] = [];
  const rearWheelBakes: Bake[] = [];

  for (const mesh of meshList(root)) {
    const material = mesh.material as THREE.Material;
    if (!material) continue;
    const part = classify(mesh);
    const model = new THREE.Matrix4().multiplyMatrices(yawOnly, mesh.matrixWorld);
    let transform: THREE.Matrix4;
    if (part === 'frontWheel') transform = new THREE.Matrix4().multiplyMatrices(toWheel, model);
    else if (part === 'frontUpper') transform = new THREE.Matrix4().multiplyMatrices(toSteer, model);
    else if (part === 'frontLower') transform = new THREE.Matrix4().multiplyMatrices(toSteer, model);
    else if (part === 'rearWheel') transform = new THREE.Matrix4().multiplyMatrices(toRear, model);
    else transform = model;

    const geometry = bakeMesh(mesh, transform);
    const bake = { geometry, material };
    if (part === 'frontWheel') frontWheelBakes.push(bake);
    else if (part === 'frontUpper') upperBakes.push(bake);
    else if (part === 'frontLower') lowerBakes.push(bake);
    else if (part === 'rearWheel') rearWheelBakes.push(bake);
    else bodyBakes.push(bake);
  }

  // --- Assembly -----------------------------------------------------------
  // --- Saddle, pegs and grips ---------------------------------------------
  // The rider is posed against the real bike, not against guessed numbers:
  // the seat top sets his hips, the footpegs his boots, the bar ends his hands.
  const seatNodes = ['seat_half1', 'seat_half2']
    .map((name) => root.getObjectByName(name))
    .filter((node): node is THREE.Object3D => Boolean(node));
  const seatBox = seatNodes.length > 0 ? boxOf(seatNodes, yaw) : null;
  // The GLB splits the handlebar: its named node only covers one half, so the
  // grips are placed off the steering head — where the bar is bolted — with
  // the standard MX bar offsets, then turned with the steering.
  const barsNode = root.getObjectByName('Renthal_Limited_Edition_Bars1');
  const barsBox = barsNode ? boxOf([barsNode], yaw) : null;

  const group = new THREE.Group();
  group.name = 'bike';
  const pose = new THREE.Group();
  const leanPivot = new THREE.Group();
  const pitchPivot = new THREE.Group();
  pitchPivot.position.z = halfBase;
  const bike = new THREE.Group();
  bike.position.z = -halfBase;
  group.add(pose);
  pose.add(leanPivot);
  leanPivot.add(pitchPivot);
  pitchPivot.add(bike);

  const materials = new Set<THREE.Material>();

  const addBlocks = (bakes: Bake[], parent: THREE.Object3D, centre?: THREE.Vector3): void => {
    for (const [material, geometries] of groupByMaterial(bakes)) {
      const merged = geometries.length === 1 ? geometries[0] : mergeGeometries(geometries, false);
      materials.add(material);
      const standard = material as THREE.MeshStandardMaterial;
      if ('envMapIntensity' in standard) standard.envMapIntensity = 1.15;
      standard.needsUpdate = true;

      if (!merged) {
        // Never lose the bike to a merge that refused the attributes: fall back
        // to one block per source mesh.
        for (const geometry of geometries) {
          if (centre) geometry.translate(-centre.x, -centre.y, -centre.z);
          const block = new THREE.Mesh(geometry, material);
          block.castShadow = true;
          block.receiveShadow = true;
          parent.add(block);
        }
        continue;
      }
      if (merged !== geometries[0]) for (const geometry of geometries) geometry.dispose();
      if (centre) merged.translate(-centre.x, -centre.y, -centre.z);
      const block = new THREE.Mesh(merged, material);
      block.castShadow = true;
      block.receiveShadow = true;
      parent.add(block);
    }
  };

  // Everything baked lives in model units: one scale and one offset place the
  // rear hub on the rear contact patch and the tyres on the ground.
  const groundY = Math.min(frontBox.min.y, rearBox.min.y);
  const modelSpace = new THREE.Group();
  bike.add(modelSpace);

  const chassis = new THREE.Group();
  chassis.name = 'chassis';
  modelSpace.add(chassis);
  addBlocks(bodyBakes, chassis);

  // Steering head: the whole front end turns around the measured axis, not
  // around a vertical axis through the hub.
  // The steering head is bolted to the chassis: it drops with the body when
  // the suspension compresses, and the slider below it takes up the travel so
  // the front tire stays on the road.
  const steerPivot = new THREE.Group();
  steerPivot.position.copy(topCentre);
  steerPivot.quaternion.copy(steerQuat);
  chassis.add(steerPivot);
  addBlocks(upperBakes, steerPivot);

  // Sliding fork: the lower legs, the fender, the caliper and the wheel.
  const slider = new THREE.Group();
  steerPivot.add(slider);
  addBlocks(lowerBakes, slider);

  // The mount carries the axle orientation; the wheel group only ever spins
  // around X, so the two rotations cannot overwrite each other.
  const frontMount = new THREE.Group();
  frontMount.position.copy(hubInSteer);
  frontMount.quaternion.copy(spinQuat);
  slider.add(frontMount);
  const frontWheel = new THREE.Group();
  frontWheel.rotation.order = 'YXZ';
  frontMount.add(frontWheel);
  addBlocks(frontWheelBakes, frontWheel);

  const rearWheel = new THREE.Group();
  rearWheel.rotation.order = 'YXZ';
  rearWheel.position.copy(rearHub);
  modelSpace.add(rearWheel);
  addBlocks(rearWheelBakes, rearWheel);

  modelSpace.scale.setScalar(scale);
  modelSpace.position.set(
    -((frontHub.x + rearHub.x) / 2) * scale,
    -groundY * scale,
    halfBase - rearHub.z * scale,
  );

  // Rider and tail unit live in metres, outside the scaled model space, so
  // they can follow the suspension drop without fighting the model scale.
  const bodyRig = new THREE.Group();
  bike.add(bodyRig);
  let rider: RiderVisual | null = riderModel;
  /** Bar centre in bike space, and how far the grips sit either side of it. */
  const gripOrigin = new THREE.Vector3(0, 1.1, -0.3);
  let gripHalfWidth = 0.41;
  // Model coordinates -> the metres the rider is built in.
  const toBike = (point: THREE.Vector3) =>
    point.clone().multiplyScalar(scale).add(modelSpace.position);
  if (rider) {
    const seatTop = seatBox ? toBike(new THREE.Vector3(0, seatBox.max.y, 0)).y : 0.95;
    // `seat_half` covers the saddle *and* the rear subframe: the rider sits on
    // the front third of that box, against the tank, not halfway down the
    // fender. Sitting on the box centre put him 30 cm too far back, with his
    // arms stretched to the bars.
    const seatZ = seatBox
      ? toBike(new THREE.Vector3(0, 0, seatBox.min.z + (seatBox.max.z - seatBox.min.z) * 0.3)).z
      : 0.02;
    // The group's origin is the rider's feet; what has to sit on the saddle is
    // his hips, so the group is pushed down by the hip height.
    rider.group.position.set(0, seatTop + 0.04 - RIDER_HIP_HEIGHT, seatZ);
    bodyRig.add(rider.group);

    // Boots: the footpegs sit a hand's width below the saddle and just behind
    // the hips. The GLB has no reliably named peg nodes (the `fastway_peg`
    // ones are tyre studs, 15 cm off the ground), so the pegs are placed off
    // the saddle the model does name.
    const pegY = seatTop - 0.6;
    const pegZ = seatZ + 0.12;
    rider.anchors.footL.set(0.2, pegY, pegZ).sub(rider.group.position);
    rider.anchors.footR.set(-0.2, pegY, pegZ).sub(rider.group.position);

    // Grips: measured off the top clamp, which the model does name.
    const topBike = toBike(topCentre);
    gripOrigin.copy(topBike).add(new THREE.Vector3(0, 0.075, 0.015));
    if (barsBox) {
      // Use the bar's own reach along the bar when the node has it: the half
      // width is the real thing, so the gloves sit on the grips.
      const halfWidth = Math.max(Math.abs(barsBox.max.x - topCentre.x), Math.abs(topCentre.x - barsBox.min.x));
      gripHalfWidth = Math.max(0.36, Math.min(0.46, halfWidth * scale));
    }
  } else {
    bodyRig.add(createRider());
  }

  // Tail unit: the number plate is what grinds the tarmac on a bavette.
  const plateNode = new THREE.Object3D();
  plateNode.position.set(0, 0.58, 0.82);
  bodyRig.add(plateNode);

  const tailMat = new THREE.MeshStandardMaterial({
    color: 0x520508,
    emissive: 0xd3121b,
    emissiveIntensity: 0.55,
    roughness: 0.4,
  });
  const tailLight = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.04, 0.03), tailMat);
  tailLight.position.set(0, 0.88, 0.72);
  bodyRig.add(tailLight);

  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
  const wheelbase = spec.wheelbase;

  return {
    group,
    wheels: [frontWheel, rearWheel],
    setPose(poseState: BikePose) {
      // The rear contact is the anchor: the local ground goes where the ray
      // found it, so neither the lean nor the wheelie lifts the rear tire.
      pose.position.y = -(poseState.rearSuspension + poseState.wheelRadius);
      leanPivot.rotation.z = -(poseState.lean + poseState.slopeRoll);
      // A compressed rear spring lifts the nose, a compressed front one dives
      // it: the difference between the two travels is the chassis attitude.
      const suspensionPitch =
        (poseState.restLength - poseState.rearSuspension - (poseState.restLength - poseState.frontSuspension)) /
        wheelbase;
      pitchPivot.rotation.x = poseState.pitch + poseState.slopePitch + clamp(suspensionPitch, -0.05, 0.05);
      steerPivot.rotation.y = -poseState.steer;

      const rearSag = clamp(poseState.restLength - poseState.rearSuspension, 0, 0.09);
      const frontSag = clamp(poseState.restLength - poseState.frontSuspension, -0.04, 0.09);
      const drop = clamp(rearSag * 0.5 + frontSag * 0.25, 0, 0.045);

      // The chassis squats on its springs while the wheels stay on the road,
      // and the lower fork slides inside the upper legs. The steering head
      // drops with the chassis, so the slider adds that drop back: the tire
      // stays planted while the fork visibly compresses.
      chassis.position.y = -drop / scale;
      bodyRig.position.y = -drop;
      // The chassis drop *is* the fork compression: the wheel has to stay on
      // the ground. Only an extended fork (front wheel in the air) slides the
      // lower leg further down.
      slider.position.y = clamp(drop + Math.min(0, frontSag), -0.05, 0.1) / scale;

      // The grips turn with the bar: swing them around the steering axis so the
      // gloves go with the handlebar instead of hovering over the tank.
      if (rider) {
        const angle = -poseState.steer;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        for (const side of [1, -1]) {
          const dx = side * gripHalfWidth;
          const dz = 0.02;
          const x = dx * cos + dz * sin;
          const z = -dx * sin + dz * cos;
          const target = side > 0 ? rider.anchors.gripL : rider.anchors.gripR;
          target
            .set(gripOrigin.x + x, gripOrigin.y, gripOrigin.z + z)
            .sub(rider.group.position);
        }
      }

      rider?.update({
        lean: poseState.lean,
        pitch: poseState.pitch,
        accel: poseState.accel,
        brake: poseState.brake,
        steer: poseState.steer,
        time: poseState.time,
      });
    },
    setSpin(frontSpin, rearSpin) {
      frontWheel.rotation.x = -frontSpin;
      rearWheel.rotation.x = -rearSpin;
    },
    setBrake(braking) {
      tailMat.emissiveIntensity = braking ? 2.4 : 0.55;
    },
    plateWorldPosition(target) {
      plateNode.getWorldPosition(target);
      return target;
    },
    dispose() {
      group.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.geometry.dispose();
      });
      for (const material of materials) material.dispose();
      tailMat.dispose();
      rider?.dispose();
    },
  };
}
