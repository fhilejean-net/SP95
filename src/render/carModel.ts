import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { CarVisual } from './car.ts';
import type { CarDef } from '../game/cars.ts';
import type { VehicleSpec } from '../physics/vehicle.ts';

/**
 * Turns a modelled car into the same `CarVisual` contract the procedural car
 * answers to.
 *
 * The model is baked into car space: every mesh's world transform is applied
 * to its geometry, so the wheel nodes can be re-parented onto hub-centred
 * groups and spun. Scale comes from the wheelbase, so a model authored at any
 * size lands on the physics contact patches; the body is then dropped until
 * its wheels touch the same plane.
 */

const loader = new GLTFLoader();
// BASE_URL keeps the models reachable at the dev root and under /SP95/ on Pages.
const MODEL_ROOT = import.meta.env.BASE_URL;

function meshList(root: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh) out.push(mesh);
  });
  return out;
}

function bounds(geometries: THREE.BufferGeometry[]): THREE.Box3 {
  const box = new THREE.Box3();
  for (const geometry of geometries) {
    geometry.computeBoundingBox();
    if (geometry.boundingBox) box.union(geometry.boundingBox);
  }
  return box;
}

export async function loadCarVisual(def: CarDef, spec: VehicleSpec): Promise<CarVisual> {
  const gltf = await loader.loadAsync(`${MODEL_ROOT}${def.model}`);
  const root = gltf.scene;
  root.updateMatrixWorld(true);
  // Models are authored nose-first in their own direction; the game drives
  // toward -Z, and the wheel mounts are placed from that.
  const yaw = new THREE.Matrix4().makeRotationY(def.yaw);

  // --- Which mesh is a wheel, and where its hub is -----------------------
  const meshes = meshList(root);
  const owner = new Map<THREE.Mesh, number>();
  const geometries = new Map<THREE.Mesh, THREE.BufferGeometry>();
  for (const mesh of meshes) {
    // Cloning keeps models that share a geometry from fighting over the bake.
    const geometry = mesh.geometry.clone();
    geometry.applyMatrix4(mesh.matrixWorld);
    geometry.applyMatrix4(yaw);
    geometries.set(mesh, geometry);
  }

  for (let i = 0; i < def.wheels.length; i++) {
    const node = root.getObjectByName(def.wheels[i]);
    if (!node) throw new Error(`${def.id}: missing wheel node ${def.wheels[i]}`);
    for (const mesh of meshList(node)) owner.set(mesh, i);
  }
  if (owner.size === 0) throw new Error(`${def.id}: no wheel geometry`);

  const wheelBoxes = () => {
    const boxes: THREE.Box3[] = [];
    for (let i = 0; i < 4; i++) {
      const list = meshes.filter((mesh) => owner.get(mesh) === i).map((mesh) => geometries.get(mesh)!);
      if (list.length === 0) throw new Error(`${def.id}: wheel ${i} is empty`);
      boxes.push(bounds(list));
    }
    return boxes;
  };

  let boxes = wheelBoxes();
  const hubs = boxes.map((box) => box.getCenter(new THREE.Vector3()));
  const measuredBase = Math.abs(hubs[0].z - hubs[2].z);
  if (!(measuredBase > 0.2)) throw new Error(`${def.id}: wheelbase not found`);
  const scale = spec.wheelbase / measuredBase;

  for (const geometry of geometries.values()) geometry.scale(scale, scale, scale);
  boxes = wheelBoxes();
  for (let i = 0; i < 4; i++) hubs[i] = boxes[i].getCenter(new THREE.Vector3());

  // --- Ride height --------------------------------------------------------
  // The body origin sits at the physics body's centre of mass, not on the
  // ground: the wheels hang at `0.12 - restLength` below it, exactly where
  // updateCarVisual puts the procedural ones.
  const restLength = spec.rideHeight + (spec.mass * 9.81) / (4 * spec.springK);
  const hubY = 0.12 - restLength;
  const frontRadius = (boxes[0].max.y - boxes[0].min.y) / 2;
  const shift = new THREE.Vector3(
    -(hubs[0].x + hubs[1].x) / 2,
    hubY - hubs[0].y,
    -(hubs[0].z + hubs[2].z) / 2,
  );

  const group = new THREE.Group();
  group.name = 'car';
  const wheelGroups: THREE.Group[] = [];
  const bodyGeometries: THREE.BufferGeometry[] = [];
  let paintMaterial: THREE.MeshStandardMaterial | null = null;

  for (const mesh of meshes) {
    const geometry = geometries.get(mesh)!;
    const material = mesh.material as THREE.MeshStandardMaterial;
    if (material) {
      material.envMapIntensity = 1.1;
      material.needsUpdate = true;
    }
    const index = owner.get(mesh);
    if (index === undefined) {
      geometry.translate(shift.x, shift.y, shift.z);
      const body = new THREE.Mesh(geometry, mesh.material);
      body.castShadow = true;
      body.receiveShadow = true;
      group.add(body);
      bodyGeometries.push(geometry);
      if (!paintMaterial && material && /body|paint/i.test(material.name)) paintMaterial = material;
    } else {
      // Hub-local vertices, so the group can spin and steer around the hub.
      geometry.translate(-hubs[index].x, -hubs[index].y, -hubs[index].z);
      const wheel = new THREE.Mesh(geometry, mesh.material);
      wheel.castShadow = true;
      wheel.receiveShadow = true;
      let wheelGroup = wheelGroups[index];
      if (!wheelGroup) {
        wheelGroup = new THREE.Group();
        wheelGroup.rotation.order = 'YXZ';
        wheelGroup.position.copy(hubs[index]).add(shift);
        wheelGroups[index] = wheelGroup;
        group.add(wheelGroup);
      }
      wheelGroup.add(wheel);
    }
  }

  const bodyBox = bounds(bodyGeometries);
  const bodySize = bodyBox.getSize(new THREE.Vector3());
  const bodyCentre = bodyBox.getCenter(new THREE.Vector3());

  // --- Lamps --------------------------------------------------------------
  // The models carry their own lamps, but none is a separate node we could
  // light up. Thin emissive bars sit just behind the rear panel instead; at
  // rest they are dark, under braking they glow.
  const brakeLights: THREE.Mesh[] = [];
  let reverseLight: THREE.Mesh;
  if (def.brakeGlow) {
    const rear = bodyBox.max.z;
    const lampY = bodyBox.min.y + bodySize.y * 0.62;
    for (const side of [-1, 1]) {
      const material = new THREE.MeshStandardMaterial({
        color: 0x3a0407,
        emissive: 0xff1a24,
        emissiveIntensity: 0.4,
        roughness: 0.35,
        metalness: 0.1,
        transparent: true,
        opacity: 0.9,
      });
      const lamp = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.075), material);
      lamp.position.set(bodyCentre.x + side * bodySize.x * 0.28, lampY, rear + 0.004);
      group.add(lamp);
      brakeLights.push(lamp);
    }
    const reverseMaterial = new THREE.MeshStandardMaterial({
      color: 0x777777,
      emissive: 0xffffff,
      emissiveIntensity: 0,
      roughness: 0.4,
    });
    reverseLight = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.055), reverseMaterial);
    reverseLight.position.set(bodyCentre.x, lampY - 0.1, rear + 0.004);
    group.add(reverseLight);
  } else {
    const hidden = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshStandardMaterial({ visible: false }),
    );
    hidden.visible = false;
    group.add(hidden);
    reverseLight = hidden;
  }

  const mounts = wheelGroups.map((wheel) => ({ x: wheel.position.x, z: wheel.position.z }));
  const modelRadius = frontRadius;

  return {
    group,
    wheels: wheelGroups,
    mounts,
    brakeLights,
    reverseLight,
    setPaint: (color: number) => {
      paintMaterial?.color.setHex(color);
    },
    setWheelRadius: (radius: number) => {
      const factor = radius / modelRadius;
      for (const wheel of wheelGroups) wheel.scale.setScalar(factor);
    },
    dispose: () => {
      group.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.geometry.dispose();
        const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of list) {
          if (!material) continue;
          material.dispose();
          const map = (material as THREE.MeshStandardMaterial).map;
          map?.dispose();
        }
      });
    },
  };
}
