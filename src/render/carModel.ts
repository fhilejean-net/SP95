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
 * to its geometry, so the wheel pieces can be re-parented onto hub-centred
 * groups and spun. Scale comes from the wheelbase, so a model authored at any
 * size lands on the physics contact patches; the body is then dropped until
 * its wheels touch the same plane.
 *
 * La recherche des roues vit dans `wheels.ts` : elle ne dépend ni de Three ni de
 * Vite, et se teste donc hors navigateur. Ici, les noms de nœuds ne servent que
 * de piste — plusieurs packs récents les écrivent faux (une « roue avant gauche »
 * qui contient les quatre, quatre groupes vides et les maillages ailleurs) —,
 * donc c'est la position réelle des pièces qui décide du coin.
 */

export type { Box3Data, WheelCandidate, WheelPick } from './wheels.ts';

const loader = new GLTFLoader();
// BASE_URL keeps the models reachable at the dev root and under /SP95/ on Pages.
const MODEL_ROOT = import.meta.env.BASE_URL;

/** Un maillage qui sent la roue : pneu, jante, moyeu, disque. */
const NAMED_WHEEL_PARTS = /wheel|tyre|tire|roue|jante|[^a-z]rims?\b|moyeu|hub/i;
/** Ce qui ne tourne pas avec la roue : étrier, passage de roue, suspension. */
const FIXED_WHEEL_PARTS = /caliper|calliper|étrier|etrier|wheelhouse|well|fender|suspension|arche|arch/i;
/**
 * Un rayon de roue fait 7 à 8 % de la longueur d'une voiture, quel que soit
 * l'échelle du fichier. Ces bornes sont donc relatives au modèle, pas en mètres.
 */
const WHEEL_RADIUS_MIN_RATIO = 0.055;
const WHEEL_RADIUS_MAX_RATIO = 0.22;
/** Une pièce muette (jante, écrou) tient dans le pneu ; une aile dépasse. */
const WHEEL_CONTAINMENT = 1.02;

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
  const box3Of = (mesh: THREE.Mesh): THREE.Box3 => {
    const data = boxOf(geometries.get(mesh)!);
    return new THREE.Box3(
      new THREE.Vector3(data.min[0], data.min[1], data.min[2]),
      new THREE.Vector3(data.max[0], data.max[1], data.max[2]),
    );
  };
  /** Nom du nœud, de ses parents et de ses matériaux, là où se cache « wheel ». */
  const labelOf = (mesh: THREE.Mesh): string => {
    const parts: string[] = [];
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) if (material?.name) parts.push(material.name);
    let node: THREE.Object3D | null = mesh;
    while (node && node !== root) {
      if (node.name) parts.push(node.name);
      node = node.parent;
    }
    return parts.join(' ');
  };

  const body = bounds([...geometries.values()]);
  const bodyCentre = body.getCenter(new THREE.Vector3());
  const modelLength = Math.max(body.max.x - body.min.x, body.max.z - body.min.z);

  const labels = new Map<THREE.Mesh, string>();
  for (const mesh of meshes) labels.set(mesh, labelOf(mesh));
  const owner = new Map<THREE.Mesh, number>();

  // Le volant, la roue de secours et les roues des portières vivent dans la
  // moitié haute du modèle ; les vraies roues touchent le sol.
  const isWheelPiece = (mesh: THREE.Mesh): boolean => {
    const label = labels.get(mesh)!;
    if (!NAMED_WHEEL_PARTS.test(label) || FIXED_WHEEL_PARTS.test(label)) return false;
    return box3Of(mesh).getCenter(new THREE.Vector3()).y <= bodyCentre.y;
  };

  // 0 FL, 1 FR, 2 RL, 3 RR — quartiers mesurés depuis le centre de la caisse,
  // car plusieurs modèles sont authorés décalés par rapport à l'origine.
  const cornerOf = (mesh: THREE.Mesh): number => {
    const centre = box3Of(mesh).getCenter(new THREE.Vector3());
    return (centre.x >= bodyCentre.x ? 1 : 0) + (centre.z >= bodyCentre.z ? 2 : 0);
  };

  const corners: THREE.Mesh[][] = [[], [], [], []];
  for (const mesh of meshes) if (isWheelPiece(mesh)) corners[cornerOf(mesh)].push(mesh);

  let hubs: THREE.Vector3[] = [];
  let radii: number[] = [];
  let halfWidths: number[] = [];

  const cornerBoxes = (): THREE.Box3[] =>
    corners.map((list) => bounds(list.map((mesh) => geometries.get(mesh)!)));

  if (corners.every((list) => list.length > 0)) {
    const boxes = cornerBoxes();
    hubs = boxes.map((box) => box.getCenter(new THREE.Vector3()));
    radii = boxes.map((box) => (box.max.y - box.min.y) / 2);
    halfWidths = boxes.map((box) => (box.max.x - box.min.x) / 2);
  }

  const plausible =
    radii.length === 4 &&
    radii.every(
      (radius) =>
        radius > modelLength * WHEEL_RADIUS_MIN_RATIO &&
        radius < modelLength * WHEEL_RADIUS_MAX_RATIO,
    );

  if (!plausible) {
    // Rien ne s'appelle « wheel » dans ce fichier : on retombe sur la forme des
    // pièces (`wheels.ts`), qui mesure des moyeux symétriques.
    corners.forEach((list) => list.splice(0));
    const bodyData: Box3Data = {
      min: [body.min.x, body.min.y, body.min.z],
      max: [body.max.x, body.max.y, body.max.z],
    };
    const candidates: WheelCandidate[] = meshes.map((mesh) => ({
      name: labels.get(mesh)!,
      box: boxOf(geometries.get(mesh)!),
    }));
    const detected = pickWheels(candidates, bodyData);
    if (!detected) {
      console.warn(
        `${def.id}: roues introuvables, maillages : ` +
          candidates
            .map((entry) => entry.name)
            .slice(0, 24)
            .join(' | '),
      );
      throw new Error(`${def.id}: no wheel geometry`);
    }
    hubs = detected.map((pick) => new THREE.Vector3(pick.hub[0], pick.hub[1], pick.hub[2]));
    radii = detected.map(() => detected[0].radius);
    halfWidths = detected.map(() => detected[0].radius * 0.5);
    // Chaque pièce rejoint le moyeu le plus proche, à condition de tenir dans
    // son pneu.
    for (const mesh of meshes) {
      const box = box3Of(mesh);
      let best = -1;
      let bestDistance = Infinity;
      for (let index = 0; index < 4; index++) {
        const hub = hubs[index];
        let farthest = 0;
        let distance = 0;
        for (let corner = 0; corner < 8; corner++) {
          const point = new THREE.Vector3(
            corner & 1 ? box.max.x : box.min.x,
            corner & 2 ? box.max.y : box.min.y,
            corner & 4 ? box.max.z : box.min.z,
          );
          const radial = Math.hypot(point.y - hub.y, point.z - hub.z);
          farthest = Math.max(farthest, radial);
          distance += radial / 8;
        }
        if (farthest > radii[index] * WHEEL_CONTAINMENT) continue;
        if (Math.abs(box.max.x - hub.x) > halfWidths[index] * 1.3) continue;
        if (Math.abs(box.min.x - hub.x) > halfWidths[index] * 1.3) continue;
        if (distance < bestDistance) {
          bestDistance = distance;
          best = index;
        }
      }
      if (best >= 0) owner.set(mesh, best);
    }
    console.log(
      `${def.id}: roues mesurées à la forme — ` +
        detected.map((pick) => `coin ${pick.corner}`).join(', ') +
        `, rayon ${detected[0].radius.toFixed(3)}`,
    );
  } else {
    // Les pièces reconnues rejoignent leur coin.
    for (let index = 0; index < 4; index++) {
      for (const mesh of corners[index]) owner.set(mesh, index);
    }

    // Puis les pièces muettes (jante, disque, écrou) qui tiennent **tout
    // entières** dans le cylindre d'une roue la suivent. Le test porte sur le
    // coin des boîtes le plus éloigné du moyeu : une aile ou un bas de caisse,
    // qui passent à côté du pneu, n'y entrent pas.
    for (const mesh of meshes) {
      if (owner.has(mesh) || FIXED_WHEEL_PARTS.test(labels.get(mesh)!)) continue;
      const box = box3Of(mesh);
      let best = -1;
      let bestDistance = Infinity;
      for (let index = 0; index < 4; index++) {
        const hub = hubs[index];
        if (Math.abs(box.max.x - hub.x) > halfWidths[index] * 1.25) continue;
        if (Math.abs(box.min.x - hub.x) > halfWidths[index] * 1.25) continue;
        let farthest = 0;
        let distance = 0;
        for (let corner = 0; corner < 8; corner++) {
          const point = new THREE.Vector3(
            corner & 1 ? box.max.x : box.min.x,
            corner & 2 ? box.max.y : box.min.y,
            corner & 4 ? box.max.z : box.min.z,
          );
          const radial = Math.hypot(point.y - hub.y, point.z - hub.z);
          farthest = Math.max(farthest, radial);
          distance += radial / 8;
        }
        if (farthest > radii[index] * WHEEL_CONTAINMENT) continue;
        if (distance < bestDistance) {
          bestDistance = distance;
          best = index;
        }
      }
      if (best >= 0) owner.set(mesh, best);
    }

    console.log(
      `${def.id}: roues détectées — ` +
        hubs
          .map((hub, index) => `coin ${index} moyeu ${hub.toArray().map((v) => v.toFixed(3)).join(',')}`)
          .join(' · ') +
        ` rayon ${radii[0].toFixed(3)}, ${owner.size} maillages`,
    );
  }

  if (owner.size === 0) throw new Error(`${def.id}: no wheel geometry`);

  const wheelBoxes = (): THREE.Box3[] => {
    const boxes: THREE.Box3[] = [];
    for (let i = 0; i < 4; i++) {
      const assigned = meshes.filter((mesh) => owner.get(mesh) === i);
      if (assigned.length === 0) throw new Error(`${def.id}: wheel ${i} is empty`);
      boxes.push(bounds(assigned.map((mesh) => geometries.get(mesh)!)));
    }
    return boxes;
  };

  // Le modèle peut être authoré à n'importe quelle échelle — le trueno arrive
  // en centimètres, la Ford GT en unités de 4 m. C'est donc le rapport à la
  // taille du modèle qui dit si la mesure a un sens, pas une valeur en mètres.
  let boxes = wheelBoxes();
  const wheelHubs = boxes.map((box) => box.getCenter(new THREE.Vector3()));
  // Les deux côtés mesurent l'empattement : leur moyenne résiste à un coin mal
  // découpé, là où la seule paire de gauche le suivrait.
  const measuredBase =
    (Math.abs(wheelHubs[0].z - wheelHubs[2].z) + Math.abs(wheelHubs[1].z - wheelHubs[3].z)) / 2;
  if (!(measuredBase > modelLength * 0.15)) {
    throw new Error(`${def.id}: wheelbase not found`);
  }
  const scale = spec.wheelbase / measuredBase;

  for (const geometry of geometries.values()) geometry.scale(scale, scale, scale);
  boxes = wheelBoxes();
  for (let i = 0; i < 4; i++) wheelHubs[i] = boxes[i].getCenter(new THREE.Vector3());

  // --- Ride height --------------------------------------------------------
  // The body origin sits at the physics body's centre of mass, not on the
  // ground: the wheels hang at `0.12 - restLength` below it, exactly where
  // updateCarVisual puts the procedural ones.
  const restLength = spec.rideHeight + (spec.mass * 9.81) / (4 * spec.springK);
  const hubY = 0.12 - restLength;
  const frontRadius = (boxes[0].max.y - boxes[0].min.y) / 2;
  const shift = new THREE.Vector3(
    -(wheelHubs[0].x + wheelHubs[1].x) / 2,
    hubY - wheelHubs[0].y,
    -(wheelHubs[0].z + wheelHubs[2].z) / 2,
  );

  const group = new THREE.Group();
  group.name = 'car';
  const wheelGroups: THREE.Group[] = [];
  let paintMaterial: THREE.MeshStandardMaterial | null = null;

  for (const mesh of meshes) {
    const geometry = geometries.get(mesh)!;
    const sourceMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const materials = sourceMaterials.map((material) => {
      if (material instanceof THREE.MeshStandardMaterial) material.envMapIntensity = 1.1;
      return material;
    });
    const material = Array.isArray(mesh.material) ? materials : materials[0];
    const index = owner.get(mesh);
    if (index === undefined) {
      geometry.translate(shift.x, shift.y, shift.z);
      const body = new THREE.Mesh(geometry, material);
      body.castShadow = true;
      body.receiveShadow = true;
      group.add(body);
      const paintCandidate = Array.isArray(material)
        ? material.find((entry) => /body|paint|colou?r/i.test(entry.name))
        : material;
      if (
        !paintMaterial &&
        paintCandidate instanceof THREE.MeshStandardMaterial &&
        /body|paint|colou?r/i.test(paintCandidate.name)
      ) {
        paintMaterial = paintCandidate;
      }
    } else {
      // Hub-local vertices, so the group can spin and steer around the hub.
      geometry.translate(-wheelHubs[index].x, -wheelHubs[index].y, -wheelHubs[index].z);
      const wheel = new THREE.Mesh(geometry, material);
      wheel.castShadow = true;
      wheel.receiveShadow = true;
      let wheelGroup = wheelGroups[index];
      if (!wheelGroup) {
        wheelGroup = new THREE.Group();
        wheelGroup.rotation.order = 'YXZ';
        wheelGroup.position.copy(wheelHubs[index]).add(shift);
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
