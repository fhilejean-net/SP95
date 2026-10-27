import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { CarVisual } from './car.ts';
import type { CarDef } from '../game/cars.ts';
import type { VehicleSpec } from '../physics/vehicle.ts';
import { pickWheels, type Box3Data, type WheelCandidate } from './wheels.ts';

/**
 * Turns a modelled car into the same `CarVisual` contract the procedural car
 * answers to.
 *
 * The model is baked into car space: every mesh's world transform is applied
 * to its geometry, so the wheel nodes can be re-parented onto hub-centred
 * groups and spun. Scale comes from the wheelbase, so a model authored at any
 * size lands on the physics contact patches; the body is then dropped until
 * its wheels touch the same plane.
 *
 * La recherche des roues vit dans `wheels.ts` : elle ne dépend ni de Three ni de
 * Vite, et se teste donc hors navigateur.
 */

export type { Box3Data, WheelCandidate, WheelPick } from './wheels.ts';

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

/**
 * Un nœud par son nom, tel qu'il est écrit au registre. three renomme les nœuds
 * du glTF en y remplaçant espaces et deux-points : `3DWheel Front L_35` devient
 * `3DWheel_Front_L_35`. On cherche donc d'abord à l'identique, puis en ignorant
 * espaces, deux-points et points, sans se soucier de la casse.
 */
function findNode(root: THREE.Object3D, name: string): THREE.Object3D | null {
  const exact = root.getObjectByName(name);
  if (exact) return exact;
  const wanted = normalise(name);
  let found: THREE.Object3D | null = null;
  root.traverse((node) => {
    if (!found && node.name && normalise(node.name) === wanted) found = node;
  });
  return found;
}

function normalise(text: string): string {
  return text.replace(/[\s:.]+/g, '').toLowerCase();
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

  const boxOf = (geometry: THREE.BufferGeometry): Box3Data => {
    geometry.computeBoundingBox();
    const box = geometry.boundingBox!;
    return { min: [box.min.x, box.min.y, box.min.z], max: [box.max.x, box.max.y, box.max.z] };
  };
  /** Nom du nœud et de ses parents, là où se cache « wheel », « rim »… */
  const labelOf = (mesh: THREE.Mesh): string => {
    const parts: string[] = [];
    let node: THREE.Object3D | null = mesh;
    while (node && node !== root) {
      if (node.name) parts.push(node.name);
      node = node.parent;
    }
    return parts.join('/');
  };

  // Les noms du registre, quand le modèle en porte. Un nom qui manque (three
  // renomme les nœuds du glTF, et certains ateliers nomment les groupes autrement
  // que prévu) retombe sur la détection par forme : une coquille au registre ne
  // doit pas rendre une voiture injouable.
  if (def.wheels) {
    const nodes = def.wheels.map((name) => findNode(root, name));
    if (nodes.every((node) => node !== null)) {
      nodes.forEach((node, index) => {
        for (const mesh of meshList(node!)) owner.set(mesh, index);
      });
    } else {
      const suspects: string[] = [];
      root.traverse((node) => {
        if (node.name && /wheel|tyre|tire|roue|rim/i.test(node.name)) suspects.push(node.name);
      });
      console.warn(
        `${def.id}: nœuds de roue absents au registre (` +
          `${def.wheels.filter((_, index) => !nodes[index]).join(', ')}) — ` +
          `détection par forme. Nœuds candidats : ${suspects.slice(0, 10).join(' | ') || 'aucun'}`,
      );
    }
  }

  // Aucun nom utilisable : on cherche les roues dans le modèle lui-même.
  let detected: ReturnType<typeof pickWheels> = null;
  if (owner.size === 0) {
    const body = bounds([...geometries.values()]);
    const model: Box3Data = {
      min: [body.min.x, body.min.y, body.min.z],
      max: [body.max.x, body.max.y, body.max.z],
    };
    const candidates: WheelCandidate[] = meshes.map((mesh) => ({
      name: labelOf(mesh),
      box: boxOf(geometries.get(mesh)!),
    }));
    detected = pickWheels(candidates, model);
    if (!detected) {
      console.warn(
        `${def.id}: roues introuvables, maillages : ` +
          candidates.map((entry) => entry.name).slice(0, 24).join(' | '),
      );
      throw new Error(`${def.id}: no wheel geometry`);
    }
    // Chaque maillage rejoint la roue dont le moyeu est le plus proche, à
    // condition de tenir **tout entier** dans son rayon : la jante, le disque et
    // l'étrier suivent le pneu, mais pas l'aile ni le bas de caisse, qui ne
    // font que passer à côté du moyeu. Le critère porte sur le coin le plus
    // éloigné de la boîte, pas sur son centre — un maillage long dont le centre
    // tombe près du moyeu (une aile, un bas de caisse) était aspiré dans la
    // roue et tournait avec elle.
    for (const mesh of meshes) {
      const box = boxOf(geometries.get(mesh)!);
      let best: { index: number; distance: number } | null = null;
      for (const pick of detected) {
        let farthest = 0;
        let centre = 0;
        for (let corner = 0; corner < 8; corner++) {
          const point: [number, number, number] = [
            corner & 1 ? box.max[0] : box.min[0],
            corner & 2 ? box.max[1] : box.min[1],
            corner & 4 ? box.max[2] : box.min[2],
          ];
          const distance = Math.hypot(
            point[0] - pick.hub[0],
            point[1] - pick.hub[1],
            point[2] - pick.hub[2],
          );
          farthest = Math.max(farthest, distance);
          centre += distance / 8;
        }
        if (farthest > pick.radius * 1.2) continue;
        if (!best || centre < best.distance) best = { index: pick.corner, distance: centre };
      }
      if (best) owner.set(mesh, best.index);
    }
    console.log(
      `${def.id}: roues détectées — ` +
        detected
          .map((pick) => `coin ${pick.corner} moyeu ${pick.hub.map((v) => v.toFixed(2)).join(',')}`)
          .join(' · ') +
        ` rayon ${detected[0].radius.toFixed(3)} m, ${meshes.filter((mesh) => owner.has(mesh)).length} maillages`,
    );
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

  // Le modèle peut être authoré à n'importe quelle échelle — le trueno arrive
  // en centimètres, la Ford GT en unités de 4 m. C'est donc le rapport à la
  // taille du modèle qui dit si la mesure a un sens, pas une valeur en mètres.
  const modelBox = bounds([...geometries.values()]);
  const modelLength = Math.max(modelBox.max.x - modelBox.min.x, modelBox.max.z - modelBox.min.z);
  let boxes = wheelBoxes();
  const hubs = boxes.map((box) => box.getCenter(new THREE.Vector3()));
  const measuredBase = Math.abs(hubs[0].z - hubs[2].z);
  if (!(measuredBase > modelLength * 0.15)) {
    throw new Error(`${def.id}: wheelbase not found`);
  }
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

  // --- Lamps --------------------------------------------------------------
  // The three models bake their lamps into the bodywork: the Aventador and the
  // i20 have no lamp nodes at all, and the RX-7's only emissive material is its
  // headlights. Thin emissive quads used to be stuck a few millimetres behind
  // the rear panel to fake brake lights, but on these shapes the panel curves
  // away and they ended up hanging in the air behind the car. Nothing is added
  // here now: the modelled lamps simply stay as they are. The procedural
  // fallback keeps the lamps that are part of its own bodywork.
  const brakeLights: THREE.Mesh[] = [];
  const reverseLight = new THREE.Mesh(
    new THREE.BufferGeometry(),
    new THREE.MeshStandardMaterial({ visible: false }),
  );
  reverseLight.visible = false;
  group.add(reverseLight);

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
