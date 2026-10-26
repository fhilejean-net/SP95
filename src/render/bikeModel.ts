import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { BikeSpec } from '../physics/bike.ts';
import { createRider, type BikeVisual } from './bike.ts';

/**
 * The modelled bike.
 *
 * The model arrives as ~1600 small meshes, which is 1600 draw calls a frame:
 * far too many for a bike that is on screen all the time. They are baked into
 * two blocks instead — the body and each wheel — merged per material, and the
 * wheels are re-parented onto hub-centred groups so they can spin and steer.
 *
 * Baking means reading the quantized attributes through their accessors
 * (`getX` and friends undo `KHR_mesh_quantization`) and writing plain floats,
 * which is also what lets the merge accept them.
 *
 * The pose is the same three nested pivots as the procedural bike: the ground
 * line under the rear contact, the lean around that line, and the wheelie
 * around the rear contact patch. Rotating the body itself would lift the tires
 * off the road, which is exactly what a bike visual must never do.
 */

const loader = new GLTFLoader();
const MODEL_ROOT = import.meta.env.BASE_URL;

const FRONT_WHEEL = 'Complete_front_wheel1';
const REAR_WHEEL = 'rear_wheel1';

interface Bake {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
}

function meshList(root: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh) out.push(mesh);
  });
  return out;
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

export async function loadBikeVisual(spec: BikeSpec): Promise<BikeVisual> {
  const gltf = await loader.loadAsync(`${MODEL_ROOT}models/cars/moto.glb`);
  const root = gltf.scene;
  root.updateMatrixWorld(true);

  // The model is authored nose-first along -X; the game drives toward -Z.
  const yaw = new THREE.Matrix4().makeRotationY(-Math.PI / 2);

  const frontNode = root.getObjectByName(FRONT_WHEEL);
  const rearNode = root.getObjectByName(REAR_WHEEL);
  if (!frontNode || !rearNode) throw new Error('moto: missing wheel nodes');

  // Hub and radius of each wheel, in the yawed model frame.
  const hubOf = (node: THREE.Object3D) => {
    const box = new THREE.Box3().setFromObject(node);
    const hub = box.getCenter(new THREE.Vector3()).applyMatrix4(yaw);
    return { hub, box };
  };
  const front = hubOf(frontNode);
  const rear = hubOf(rearNode);
  const measuredBase = Math.abs(front.hub.z - rear.hub.z);
  if (!(measuredBase > 0.2)) throw new Error('moto: wheelbase not found');

  const scale = spec.wheelbase / measuredBase;
  const halfBase = spec.wheelbase / 2;

  const wheels = [frontNode, rearNode];
  const wheelBakes: Bake[][] = [[], []];
  const bodyBakes: Bake[] = [];

  for (const mesh of meshList(root)) {
    const material = mesh.material as THREE.Material;
    if (!material) continue;
    const owner = wheels.findIndex((node) => {
      let found = false;
      node.traverse((child) => {
        if (child === mesh) found = true;
      });
      return found;
    });
    // Model space, then the yaw that brings the nose to the game's forward.
    const transform = new THREE.Matrix4().multiplyMatrices(yaw, mesh.matrixWorld);
    const geometry = bakeMesh(mesh, transform);
    if (owner < 0) bodyBakes.push({ geometry, material });
    else wheelBakes[owner].push({ geometry, material });
  }

  // --- Assembly -----------------------------------------------------------
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
  const groundY = Math.min(front.box.min.y, rear.box.min.y);
  const modelSpace = new THREE.Group();
  bike.add(modelSpace);
  addBlocks(bodyBakes, modelSpace);

  const wheelGroups: THREE.Group[] = [];
  for (let i = 0; i < 2; i++) {
    const hub = i === 0 ? front.hub : rear.hub;
    const wheel = new THREE.Group();
    wheel.rotation.order = 'YXZ';
    wheel.position.copy(hub);
    wheelGroups[i] = wheel;
    modelSpace.add(wheel);
    addBlocks(wheelBakes[i], wheel, hub);
  }

  modelSpace.scale.setScalar(scale);
  modelSpace.position.set(
    -((front.hub.x + rear.hub.x) / 2) * scale,
    -groundY * scale,
    halfBase - rear.hub.z * scale,
  );

  // The rider: the model is a bike, not a rider, and a bike riding itself is
  // the one thing that reads as fake from the chase camera.
  bike.add(createRider());

  // Tail unit: the number plate is what grinds the tarmac on a bavette.
  const plateNode = new THREE.Object3D();
  plateNode.position.set(0, 0.58, 0.82);
  bike.add(plateNode);

  const tailMat = new THREE.MeshStandardMaterial({
    color: 0x520508,
    emissive: 0xd3121b,
    emissiveIntensity: 0.55,
    roughness: 0.4,
  });
  const tailLight = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.04, 0.03), tailMat);
  tailLight.position.set(0, 0.88, 0.72);
  bike.add(tailLight);

  const frontWheel = wheelGroups[0];
  const rearWheel = wheelGroups[1];

  return {
    group,
    wheels: [frontWheel, rearWheel],
    setPose(leanAngle, pitch, steer, rearSuspension, wheelRadius) {
      // The rear contact is the anchor: the local ground goes where the ray
      // found it, so neither the lean nor the wheelie lifts the rear tire.
      pose.position.y = -(rearSuspension + wheelRadius);
      leanPivot.rotation.z = -leanAngle;
      pitchPivot.rotation.x = pitch;
      frontWheel.rotation.y = -steer;
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
    },
  };
}
