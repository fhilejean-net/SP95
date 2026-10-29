import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
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
// Les voitures récentes sont compressées en meshopt (géométrie) et WebP
// (textures) : sans le décodeur, la F1 arrive invisible ou vide.
loader.setMeshoptDecoder(MeshoptDecoder);
// BASE_URL keeps the models reachable at the dev root and under /SP95/ on Pages.
const MODEL_ROOT = import.meta.env.BASE_URL;

/** Un maillage qui sent la roue : pneu, jante, moyeu, disque. */
const NAMED_WHEEL_PARTS = /wheel|tyre|tire|tread|roue|jante|\brims?\b|rim|moyeu|hub/i;
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
/**
 * Réflexions : le ciel et les néons de la piste arrivent par l'environnement.
 * Au-dessus de 1, la peinture prend des reflets francs sans cramer les chromes.
 */
const ENV_INTENSITY = 1.0;
/** Peinture vernie : une couche de clearcoat par-dessus la couleur de base. */
const PAINT_MATERIAL = /paint|body|colou?r|carrosserie|peinture/i;
const PAINT_CLEARCOAT = 1;
const PAINT_CLEARCOAT_ROUGHNESS = 0.055;

/**
 * Convertit une peinture en matériau physique verni. Les autres matières
 * (pneus, jantes, verre) sont rendues telles quelles : un clearcoat sur un pneu
 * le rend huileux.
 */
function glossPaint(material: THREE.Material): THREE.Material {
  if (!(material instanceof THREE.MeshStandardMaterial)) return material;
  if (material.transparent || !PAINT_MATERIAL.test(material.name ?? '')) return material;
  // On recopie champ par champ, pas `copy()` : `MeshPhysicalMaterial.copy()`
  // attend une *physique* en source et lit `source.clearcoatNormalScale`, que
  // toute `MeshStandardMaterial` n'a pas — la peinture de la voiture par défaut
  // plantait là et le jeu retombait sur la voiture de secours.
  const paint = new THREE.MeshPhysicalMaterial({
    name: material.name,
    color: material.color ? material.color.clone() : new THREE.Color(0xffffff),
    map: material.map ?? null,
    normalMap: material.normalMap ?? null,
    normalScale: material.normalScale ? material.normalScale.clone() : new THREE.Vector2(1, 1),
    aoMap: material.aoMap ?? null,
    aoMapIntensity: material.aoMapIntensity ?? 1,
    roughnessMap: material.roughnessMap ?? null,
    roughness: material.roughness,
    metalnessMap: material.metalnessMap ?? null,
    metalness: material.metalness,
    emissive: material.emissive ? material.emissive.clone() : new THREE.Color(0x000000),
    emissiveMap: material.emissiveMap ?? null,
    emissiveIntensity: material.emissiveIntensity ?? 1,
    alphaMap: material.alphaMap ?? null,
    side: material.side,
    transparent: material.transparent,
    opacity: material.opacity,
    alphaTest: material.alphaTest,
    depthWrite: material.depthWrite,
    clearcoat: PAINT_CLEARCOAT,
    clearcoatRoughness: PAINT_CLEARCOAT_ROUGHNESS,
    envMapIntensity: ENV_INTENSITY,
  });
  return paint;
}

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

/**
 * Découpe un maillage qui contient les quatre roues en quatre morceaux.
 *
 * La F1 de McLaren livre ses jantes, ses pneus et ses flancs en un maillage
 * par matière : chaque maillage couvre les quatre coins. La détection ne peut
 * pas voir quatre roues dans une boîte de cinq mètres de long, et le rendu ne
 * peut pas faire tourner une pièce qui contient les quatre. On répartit donc
 * les triangles par quadrant autour du centre de la voiture.
 *
 * Les géométries sont déjà cuites en repère voiture quand cette fonction
 * tourne : le quadrant se lit directement en x/z.
 */
function splitWheelMesh(
  geometry: THREE.BufferGeometry,
  centreX: number,
  centreZ: number,
): THREE.BufferGeometry[] {
  const position = geometry.attributes.position as THREE.BufferAttribute;
  const normal = geometry.attributes.normal as THREE.BufferAttribute | undefined;
  const uv = geometry.attributes.uv as THREE.BufferAttribute | undefined;
  const index = geometry.index;
  const count = index ? index.count : position.count;
  const groups: number[][] = [[], [], [], []];
  for (let i = 0; i < count; i += 3) {
    const a = index ? index.getX(i) : i;
    const b = index ? index.getX(i + 1) : i + 1;
    const c = index ? index.getX(i + 2) : i + 2;
    const x = (position.getX(a) + position.getX(b) + position.getX(c)) / 3;
    const z = (position.getZ(a) + position.getZ(b) + position.getZ(c)) / 3;
    const corner = (x >= centreX ? 1 : 0) + (z >= centreZ ? 2 : 0);
    groups[corner].push(a, b, c);
  }
  const parts: THREE.BufferGeometry[] = [];
  for (const group of groups) {
    if (group.length === 0) continue;
    const out = new THREE.BufferGeometry();
    const positions = new Float32Array(group.length * 3);
    const normals = normal ? new Float32Array(group.length * 3) : null;
    const uvs = uv ? new Float32Array(group.length * 2) : null;
    group.forEach((vertex, k) => {
      positions[k * 3] = position.getX(vertex);
      positions[k * 3 + 1] = position.getY(vertex);
      positions[k * 3 + 2] = position.getZ(vertex);
      if (normal && normals) {
        normals[k * 3] = normal.getX(vertex);
        normals[k * 3 + 1] = normal.getY(vertex);
        normals[k * 3 + 2] = normal.getZ(vertex);
      }
      if (uv && uvs) {
        uvs[k * 2] = uv.getX(vertex);
        uvs[k * 2 + 1] = uv.getY(vertex);
      }
    });
    out.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    if (normals) out.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    if (uvs) out.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    out.computeBoundingBox();
    parts.push(out);
  }
  return parts;
}

interface CornerSplit {
  hubs: THREE.Vector3[];
  radius: number;
  pieces: {
    geometry: THREE.BufferGeometry;
    material: THREE.Material | THREE.Material[];
    corner: number | null;
  }[];
}

/**
 * Découpe les roues d'un modèle qui les a fusionnées dans la carrosserie.
 *
 * Certains packs (la CR-Z, la Hoonicorn, le kart) livrent un maillage par
 * matière : chaque maillage traverse la voiture et contient les quatre pneus
 * avec le reste. Aucun nom de nœud ne les trahit, et leur boîte englobante fait
 * la taille du véhicule. On mesure donc les quatre coins sur les sommets eux-
 * mêmes — les roues sont le point le plus bas et le plus extérieur —, puis on
 * répartit les **triangles** dans un cylindre autour de chaque moyeu. Le reste
 * demeure la carrosserie.
 *
 * Renvoie `null` si les quatre coins ne ressemblent pas à des roues : mieux vaut
 * la voiture de secours qu'un découpage au hasard.
 */
function splitWheelsByCorner(
  meshes: THREE.Mesh[],
  geometries: Map<THREE.Mesh, THREE.BufferGeometry>,
  body: THREE.Box3,
): CornerSplit | null {
  const size = body.getSize(new THREE.Vector3());
  const centre = body.getCenter(new THREE.Vector3());
  const length = Math.max(size.x, size.z);
  if (!(length > 0)) return null;

  // Un échantillon de sommets suffit pour trouver les quatre coins : les roues
  // sont basses, extérieures en x et en z, et symétriques.
  const boxes = [0, 1, 2, 3].map(() => new THREE.Box3());
  const counts = [0, 0, 0, 0];
  for (const geometry of geometries.values()) {
    const position = geometry.attributes.position as THREE.BufferAttribute | undefined;
    if (!position) continue;
    const step = Math.max(1, Math.floor(position.count / 6000));
    for (let i = 0; i < position.count; i += step) {
      const x = position.getX(i);
      const y = position.getY(i);
      const z = position.getZ(i);
      if (y > centre.y) continue;
      const sideX = x >= centre.x ? 1 : 0;
      const sideZ = z >= centre.z ? 1 : 0;
      if (Math.abs(x - centre.x) < size.x * 0.3) continue;
      if (Math.abs(z - centre.z) < size.z * 0.22) continue;
      const corner = sideX + sideZ * 2;
      boxes[corner].expandByPoint(new THREE.Vector3(x, y, z));
      counts[corner] += 1;
    }
  }
  const hubs = boxes.map((box) => box.getCenter(new THREE.Vector3()));
  const radii = boxes.map((box) => (box.max.y - box.min.y) / 2);
  const radius = radii.reduce((sum, value) => sum + value, 0) / 4;
  if (counts.some((count) => count < 20)) return null;
  if (!(radius > length * 0.035) || !(radius < length * 0.22)) return null;
  // Une roue est ronde : la hauteur et la longueur de la boîte se ressemblent.
  const round = boxes.every((box) => {
    const height = box.max.y - box.min.y;
    const depth = box.max.z - box.min.z;
    return Math.abs(height - depth) < Math.max(height, depth) * 0.35;
  });
  if (!round) return null;

  const halfWidth = radius * 0.7;
  const pieces: CornerSplit['pieces'] = [];
  for (const mesh of meshes) {
    const source = geometries.get(mesh)!;
    const position = source.attributes.position as THREE.BufferAttribute;
    const normal = source.attributes.normal as THREE.BufferAttribute | undefined;
    const uv = source.attributes.uv as THREE.BufferAttribute | undefined;
    const index = source.index;
    const count = index ? index.count : position.count;
    const buckets: number[][] = [[], [], [], [], []];
    for (let i = 0; i < count; i += 3) {
      const a = index ? index.getX(i) : i;
      const b = index ? index.getX(i + 1) : i + 1;
      const c = index ? index.getX(i + 2) : i + 2;
      const x = (position.getX(a) + position.getX(b) + position.getX(c)) / 3;
      const y = (position.getY(a) + position.getY(b) + position.getY(c)) / 3;
      const z = (position.getZ(a) + position.getZ(b) + position.getZ(c)) / 3;
      let target = 4;
      for (let corner = 0; corner < 4; corner++) {
        const hub = hubs[corner];
        if (Math.abs(x - hub.x) > halfWidth) continue;
        if (Math.hypot(y - hub.y, z - hub.z) > radius * 1.08) continue;
        target = corner;
        break;
      }
      buckets[target].push(a, b, c);
    }
    for (let bucket = 0; bucket < buckets.length; bucket++) {
      const group = buckets[bucket];
      if (group.length === 0) continue;
      const part = new THREE.BufferGeometry();
      const positions = new Float32Array(group.length * 3);
      const normals = normal ? new Float32Array(group.length * 3) : null;
      const uvs = uv ? new Float32Array(group.length * 2) : null;
      group.forEach((vertex, k) => {
        positions[k * 3] = position.getX(vertex);
        positions[k * 3 + 1] = position.getY(vertex);
        positions[k * 3 + 2] = position.getZ(vertex);
        if (normal && normals) {
          normals[k * 3] = normal.getX(vertex);
          normals[k * 3 + 1] = normal.getY(vertex);
          normals[k * 3 + 2] = normal.getZ(vertex);
        }
        if (uv && uvs) {
          uvs[k * 2] = uv.getX(vertex);
          uvs[k * 2 + 1] = uv.getY(vertex);
        }
      });
      part.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      if (normals) part.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
      if (uvs) part.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
      part.computeBoundingBox();
      pieces.push({ geometry: part, material: mesh.material, corner: bucket < 4 ? bucket : null });
    }
  }
  if (![0, 1, 2, 3].every((corner) => pieces.some((piece) => piece.corner === corner))) return null;
  return { hubs, radius, pieces };
}

/**
 * Repli pour les modèles dont les roues ne peuvent pas être extraites.
 *
 * La Hoonicorn est riggée (peau liée à un squelette) : ses maillages sont en
 * pose de repos et traversent toute la voiture. Le kart, lui, sort d'un export
 * normalisé dans une boîte de 2×2×2. Dans les deux cas il n'y a aucun moyeu
 * mesurable. On garde la carrosserie du modèle — mise à l'échelle de la fiche,
 * posée sur le sol — et on perce les quatre passages de roue pour y monter des
 * roues procédurales : elles tournent, braquent et ont le bon rayon physique.
 */
function buildFallbackCar(
  spec: VehicleSpec,
  meshes: THREE.Mesh[],
  geometries: Map<THREE.Mesh, THREE.BufferGeometry>,
  body: THREE.Box3,
): CarVisual {
  const size = body.getSize(new THREE.Vector3());
  const centre = body.getCenter(new THREE.Vector3());
  const length = Math.max(size.z, size.x * 0.9, 1e-4);
  const scale = (spec.bodyHalf.z * 2) / length;
  const restLength = spec.rideHeight + (spec.mass * 9.81) / (4 * spec.springK);
  const hubY = 0.12 - restLength;
  const radius = spec.wheelRadius;
  const halfTrack = spec.track / 2;
  const halfBase = spec.wheelbase / 2;
  const hubs = [
    new THREE.Vector3(-halfTrack, hubY, -halfBase),
    new THREE.Vector3(halfTrack, hubY, -halfBase),
    new THREE.Vector3(-halfTrack, hubY, halfBase),
    new THREE.Vector3(halfTrack, hubY, halfBase),
  ];
  const width = Math.max(0.16, radius * 0.55);

  // Le point le plus bas du modèle doit effleurer le sol sous les roues.
  const scaledMinY = body.min.y * scale;
  const offset = new THREE.Vector3(
    -centre.x * scale,
    hubY - radius + 0.03 - scaledMinY,
    -centre.z * scale,
  );

  const group = new THREE.Group();
  group.name = 'car';
  let paintMaterial: THREE.MeshStandardMaterial | null = null;

  for (const mesh of meshes) {
    const source = geometries.get(mesh)!;
    const position = source.attributes.position as THREE.BufferAttribute;
    const normal = source.attributes.normal as THREE.BufferAttribute | undefined;
    const uv = source.attributes.uv as THREE.BufferAttribute | undefined;
    const index = source.index;
    const count = index ? index.count : position.count;
    const kept: number[] = [];
    for (let i = 0; i < count; i += 3) {
      const a = index ? index.getX(i) : i;
      const b = index ? index.getX(i + 1) : i + 1;
      const c = index ? index.getX(i + 2) : i + 2;
      const x = position.getX(a) * scale + offset.x;
      const y = position.getY(a) * scale + offset.y;
      const z = position.getZ(a) * scale + offset.z;
      let inside = false;
      for (const hub of hubs) {
        if (Math.abs(x - hub.x) > width * 0.9) continue;
        if (Math.hypot(y - hub.y, z - hub.z) < radius * 1.12) inside = true;
        if (inside) break;
      }
      if (!inside) kept.push(a, b, c);
    }
    if (kept.length === 0) continue;
    const part = new THREE.BufferGeometry();
    const positions = new Float32Array(kept.length * 3);
    const normals = normal ? new Float32Array(kept.length * 3) : null;
    const uvs = uv ? new Float32Array(kept.length * 2) : null;
    kept.forEach((vertex, k) => {
      positions[k * 3] = position.getX(vertex) * scale + offset.x;
      positions[k * 3 + 1] = position.getY(vertex) * scale + offset.y;
      positions[k * 3 + 2] = position.getZ(vertex) * scale + offset.z;
      if (normal && normals) {
        normals[k * 3] = normal.getX(vertex);
        normals[k * 3 + 1] = normal.getY(vertex);
        normals[k * 3 + 2] = normal.getZ(vertex);
      }
      if (uv && uvs) {
        uvs[k * 2] = uv.getX(vertex);
        uvs[k * 2 + 1] = uv.getY(vertex);
      }
    });
    part.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    if (normals) part.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    if (uvs) part.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    part.computeVertexNormals();
    const sourceMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const materials = sourceMaterials.map((material) => {
      if (material instanceof THREE.MeshStandardMaterial) material.envMapIntensity = ENV_INTENSITY;
      return material;
    });
    const glossed = materials.map((entry) => glossPaint(entry));
    const bodyMesh = new THREE.Mesh(part, Array.isArray(mesh.material) ? glossed : glossed[0]);
    bodyMesh.castShadow = true;
    bodyMesh.receiveShadow = true;
    group.add(bodyMesh);
    const candidate = materials.find((entry) => /body|paint|colou?r/i.test(entry.name ?? ''));
    if (!paintMaterial && candidate instanceof THREE.MeshStandardMaterial) paintMaterial = candidate;
  }

  const tyre = new THREE.MeshStandardMaterial({ color: 0x141517, roughness: 0.9, metalness: 0.02 });
  const rim = new THREE.MeshStandardMaterial({ color: 0xb9bdc2, roughness: 0.32, metalness: 0.9 });
  const wheelGroups: THREE.Group[] = [];
  for (const hub of hubs) {
    const wheel = new THREE.Group();
    wheel.rotation.order = 'YXZ';
    wheel.position.copy(hub);
    const tyreMesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, width, 20), tyre);
    tyreMesh.rotation.z = Math.PI / 2;
    tyreMesh.castShadow = true;
    wheel.add(tyreMesh);
    const rimMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(radius * 0.58, radius * 0.58, width * 1.02, 16),
      rim,
    );
    rimMesh.rotation.z = Math.PI / 2;
    wheel.add(rimMesh);
    group.add(wheel);
    wheelGroups.push(wheel);
  }

  const reverseLight = new THREE.Mesh(
    new THREE.BufferGeometry(),
    new THREE.MeshStandardMaterial({ visible: false }),
  );
  reverseLight.visible = false;
  group.add(reverseLight);

  return {
    group,
    wheels: wheelGroups,
    mounts: wheelGroups.map((wheel) => ({ x: wheel.position.x, z: wheel.position.z })),
    brakeLights: [],
    reverseLight,
    setPaint: (color: number) => {
      paintMaterial?.color.setHex(color);
    },
    setWheelRadius: (next: number) => {
      const factor = next / radius;
      for (const wheel of wheelGroups) wheel.scale.setScalar(factor);
    },
    dispose: () => {
      group.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.geometry.dispose();
      });
    },
  };
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

  const labels = new Map<THREE.Mesh, string>();
  for (const mesh of meshes) labels.set(mesh, labelOf(mesh));

  // Les modèles dont les quatre roues partagent un maillage par matière : on
  // les découpe avant de mesurer quoi que ce soit, sinon la boîte englobante
  // d'une « roue » fait la longueur de la voiture et la détection échoue.
  const whole = bounds([...geometries.values()]);
  const wholeSize = whole.getSize(new THREE.Vector3());
  const wholeCentre = whole.getCenter(new THREE.Vector3());
  for (const mesh of [...meshes]) {
    if (!/wheel|tyre|tire|tread|\brim/i.test(labels.get(mesh)!)) continue;
    const geometry = geometries.get(mesh)!;
    geometry.computeBoundingBox();
    const box = geometry.boundingBox!;
    // Une roue seule tient dans un coin ; un maillage qui **traverse le centre**
    // de la voiture en contient au moins deux (les packs fusionnent souvent les
    // deux roues d'un même côté). C'est ce croisement qui décide, pas la taille
    // du maillage : sur la CR-Z, deux pneus ne font que la moitié de la
    // longueur et passaient sous l'ancien seuil.
    const marginX = wholeSize.x * 0.05;
    const marginZ = wholeSize.z * 0.05;
    const crossesX = box.min.x < wholeCentre.x - marginX && box.max.x > wholeCentre.x + marginX;
    const crossesZ = box.min.z < wholeCentre.z - marginZ && box.max.z > wholeCentre.z + marginZ;
    if (!crossesX && !crossesZ) continue;
    const parts = splitWheelMesh(geometry, wholeCentre.x, wholeCentre.z);
    if (parts.length < 2) continue;
    meshes.splice(meshes.indexOf(mesh), 1);
    geometries.delete(mesh);
    for (const part of parts) {
      const piece = new THREE.Mesh(part, mesh.material);
      meshes.push(piece);
      geometries.set(piece, part);
      labels.set(piece, labels.get(mesh) ?? 'wheel');
    }
  }

  const body = bounds([...geometries.values()]);
  const bodyCentre = body.getCenter(new THREE.Vector3());
  const modelLength = Math.max(body.max.x - body.min.x, body.max.z - body.min.z);
  const owner = new Map<THREE.Mesh, number>();

  // Le volant, la roue de secours et les roues des portières vivent dans la
  // moitié haute du modèle ; les vraies roues touchent le sol.
  const isWheelPiece = (mesh: THREE.Mesh): boolean => {
    const label = labels.get(mesh)!;
    if (!NAMED_WHEEL_PARTS.test(label) || FIXED_WHEEL_PARTS.test(label)) return false;
    const centre = box3Of(mesh).getCenter(new THREE.Vector3());
    // Une roue est basse **et** dans un coin : le volant, le pneu de secours et
    // les pièces centrales d'un modèle ne doivent pas tirer un moyeu au milieu
    // de la caisse.
    if (centre.y > bodyCentre.y) return false;
    // Un morceau central (pneu de secours, pièce de cockpit) ne doit pas
    // entrer dans le coin où il se trouve : il décalerait le moyeu. Une roue
    // est décalée sur *les deux* axes par rapport au centre de la caisse.
    if (Math.abs(centre.x - bodyCentre.x) < (body.max.x - body.min.x) * 0.15) return false;
    return Math.abs(centre.z - bodyCentre.z) > modelLength * 0.15;
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
    let detected = pickWheels(candidates, bodyData);
    if (!detected) {
      // Dernier recours : découper les pneus au triangle, autour des quatre
      // coins mesurés sur les sommets. C'est ce qui sauve les modèles dont les
      // roues sont fusionnées dans un maillage par matière (CR-Z, Hoonicorn,
      // kart) et qu'aucun nom de nœud ne trahit.
      const split = splitWheelsByCorner(meshes, geometries, body);
      if (split) {
        const originals = [...meshes];
        meshes.length = 0;
        for (const mesh of originals) geometries.delete(mesh);
        for (const piece of split.pieces) {
          const mesh = new THREE.Mesh(piece.geometry, piece.material);
          meshes.push(mesh);
          geometries.set(mesh, piece.geometry);
          labels.set(mesh, piece.corner === null ? 'body' : 'wheel');
        }
        detected = [0, 1, 2, 3].map((corner) => ({
          corner: corner as 0 | 1 | 2 | 3,
          hub: split.hubs[corner].toArray() as [number, number, number],
          radius: split.radius,
        }));
        console.log(
          `${def.id}: roues découpées au triangle — rayon ${split.radius.toFixed(3)}, ` +
            `${split.pieces.length} morceaux`,
        );
      }
    }
    if (!detected) {
      console.warn(`${def.id}: roues non extraites — roues procédurales montées sur la carrosserie`);
      return buildFallbackCar(spec, meshes, geometries, body);
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
  const boxes = wheelBoxes();
  const wheelHubs = boxes.map((box) => box.getCenter(new THREE.Vector3()));
  // Les deux côtés mesurent l'empattement : leur moyenne résiste à un coin mal
  // découpé, là où la seule paire de gauche le suivrait.
  const measuredBase =
    (Math.abs(wheelHubs[0].z - wheelHubs[2].z) + Math.abs(wheelHubs[1].z - wheelHubs[3].z)) / 2;
  if (!(measuredBase > modelLength * 0.15)) {
    throw new Error(`${def.id}: wheelbase not found`);
  }
  const scale = spec.wheelbase / measuredBase;

  // Les moyeux sont mis à l'échelle à partir de leur position **mesurée avant**
  // le facteur : recomputer les boîtes après `geometry.scale()` donnait des
  // centres faux sur les modèles quantifiés (l'empattement s'effondrait à
  // zéro et les roues se retrouvaient au milieu de la caisse).
  const preHubs = wheelHubs.map((hub) => hub.clone());
  const preRadius = radii[0];
  for (const geometry of geometries.values()) geometry.scale(scale, scale, scale);
  for (let i = 0; i < 4; i++) wheelHubs[i] = preHubs[i].clone().multiplyScalar(scale);

  // --- Ride height --------------------------------------------------------
  // The body origin sits at the physics body's centre of mass, not on the
  // ground: the wheels hang at `0.12 - restLength` below it, exactly where
  // updateCarVisual puts the procedural ones.
  const restLength = spec.rideHeight + (spec.mass * 9.81) / (4 * spec.springK);
  const hubY = 0.12 - restLength;
  const frontRadius = preRadius * scale;
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
      if (material instanceof THREE.MeshStandardMaterial) material.envMapIntensity = ENV_INTENSITY;
      return material;
    });
    const material = Array.isArray(mesh.material) ? materials : materials[0];
    const index = owner.get(mesh);
    if (index === undefined) {
      geometry.translate(shift.x, shift.y, shift.z);
      // La peinture vernie : le clearcoat capte le ciel même quand la couleur
      // de base est mate, ce qui distingue une carrosserie d'un aplat de
      // plastique. Il ne s'applique qu'au maillage nommé comme la peinture, et
      // jamais à un matériau transparent (vitres, optiques).
      const glossed = Array.isArray(material)
        ? material.map((entry) => glossPaint(entry))
        : glossPaint(material);
      const body = new THREE.Mesh(geometry, glossed);
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
