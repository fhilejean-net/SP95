/**
 * Le circuit de Suzuka (modèle 2001) posé dans les champs à l'est de la
 * ceinture. Le modèle porte son propre sol : dalles d'herbe, bac à gravier,
 * asphalte, avec ses collines (jusqu'à une quarantaine de mètres entre le point
 * bas et le point haut). Plutôt que d'aplatir le monde autour, on échantillonne
 * cette dalle au chargement et le terrain de jeu la suit, puis un trimesh Rapier
 * la rend praticable.
 *
 * Tout passe par le même balayage de sommets : pas de raycast, une dalle de
 * 1,8 million de triangles répondrait en minutes.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import RAPIER from '@dimforge/rapier3d-compat';
import {
  CIRCUIT,
  CIRCUIT_FADE,
  naturalHeightAt,
  terrainBaseHeight,
  type SurfaceKind,
} from './layout.ts';
import { GROUP_GROUND } from '../physics/vehicle.ts';

// BASE_URL garde le modèle résolvable sous /SP95/ sur GitHub Pages ; en test
// Node, import.meta.env n'existe pas et le chemin retombe sur la racine.
const BASE = import.meta.env?.BASE_URL ?? '/';
const CIRCUIT_URL = `${BASE}models/tracks/suzuka-2001.glb`;

/** Pas de la grille d'échantillonnage de la dalle, en mètres monde. */
const SAMPLE_STEP = 4;
/**
 * Le terrain de jeu se tient sous la dalle : seule la surface du modèle est
 * visible, et le sol de secours ne doit jamais percer au travers.
 */
const GROUND_MARGIN = 0.3;
/**
 * Passes de comblement : les premières bouchent les trous de la dalle, les
 * suivantes étalent le raccord de CIRCUIT_FADE mètres autour d'elle.
 */
const HOLE_PASSES = 3;
const FADE_PASSES = Math.ceil(CIRCUIT_FADE / SAMPLE_STEP) + HOLE_PASSES;

/** Textures qui portent de l'asphalte roulable. */
const ASPHALT_IMAGES = /^(road0[1-7]|roadx|pitroad|grdr|grdrtop|groove00|skidslong)$/;
/** Bac à gravier et terre : ça freine, ça ne tient pas. */
const LOOSE_IMAGES = /^(rf_sand01|rf_sand02|sand|gravel|rmbl)/;
/** Tout ce qui porte le sol du modèle (herbe, eau, sable, asphalte). */
const GROUND_IMAGES = /^(grass|green|sand|rf_|water|rmbl|road0[1-7]|roadx|pitroad|grdr|groove|skid)/;

/** Groupes de collision du terrain : les pneus mordent, la coque ignore. */
const GROUND_GROUP = (GROUP_GROUND << 16) | 0xffff;

/** Pose du départ sur la ligne droite des stands, en repère du modèle. */
const START_LOCAL = { x: 500, z: 430, heading: Math.PI };

/**
 * Cote de la surface visible du circuit (asphalte, herbe, bac à gravier) : le
 * terrain de jeu est plus bas, mais une voiture doit repartir de la piste.
 */
let floorAt: ((x: number, z: number) => number | null) | null = null;

export function circuitFloor(x: number, z: number): number | null {
  return floorAt ? floorAt(x, z) : null;
}

/**
 * Cote de la dalle une fois fondue dans le terrain, à `distance` mètres de son
 * bord : c'est le talus qui raccorde le circuit au reste du monde.
 */
export function fadeGround(plate: number, base: number, distance: number): number {
  const t = Math.min(1, Math.max(0, distance) / CIRCUIT_FADE);
  return plate * (1 - t) + base * t;
}

export interface CircuitHandles {
  /** Départ sur la ligne droite des stands, en coordonnées monde. */
  spawn: { x: number; z: number; heading: number };
  meshes: number;
  triangles: number;
  loadMs: number;
  buildMs: number;
}

interface ModelJson {
  materials: { name?: string; pbrMetallicRoughness?: { baseColorTexture?: { index: number } } }[];
  textures: { source?: number; extensions?: { EXT_texture_webp?: { source: number } } }[];
  images: { name?: string }[];
}

/** Nom de la texture de base color de chaque matériau, par nom glTF. */
function imageNames(json: ModelJson): Map<string, string> {
  const out = new Map<string, string>();
  json.materials.forEach((material, index) => {
    const ref = material.pbrMetallicRoughness?.baseColorTexture;
    if (!ref) return;
    const texture = json.textures[ref.index];
    const source = texture?.source ?? texture?.extensions?.EXT_texture_webp?.source;
    out.set(material.name ?? `mat${index}`, json.images[source ?? -1]?.name ?? '');
  });
  return out;
}

export async function buildCircuit(
  scene: THREE.Scene,
  world: RAPIER.World,
  options: { anisotropy: number },
): Promise<CircuitHandles> {
  const loadStarted = performance.now();
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.loadAsync(CIRCUIT_URL);
  const loadMs = performance.now() - loadStarted;

  const root = gltf.scene;
  const imageOf = imageNames((gltf.parser as unknown as { json: ModelJson }).json);
  const nameOf = (mesh: THREE.Mesh): string => {
    const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    return imageOf.get(material?.name ?? '') ?? '';
  };

  // 1. Classement, et hauteur de la dalle dans le repère du modèle, avant pose.
  root.updateMatrixWorld(true);
  const groundMeshes: THREE.Mesh[] = [];
  const asphaltMeshes: THREE.Mesh[] = [];
  const looseMeshes: THREE.Mesh[] = [];
  let plateTop = -Infinity;
  let plateBottom = Infinity;
  let triangles = 0;
  let meshes = 0;

  const point = new THREE.Vector3();
  root.traverse((object) => {
    if (!(object as THREE.Mesh).isMesh) return;
    const mesh = object as THREE.Mesh;
    meshes++;
    const geometry = mesh.geometry;
    triangles += (geometry.index ? geometry.index.count : geometry.attributes.position.count) / 3;
    const image = nameOf(mesh);
    if (ASPHALT_IMAGES.test(image)) asphaltMeshes.push(mesh);
    else if (LOOSE_IMAGES.test(image)) looseMeshes.push(mesh);
    if (!GROUND_IMAGES.test(image)) return;
    groundMeshes.push(mesh);
    const positions = geometry.attributes.position;
    for (let i = 0; i < positions.count; i++) {
      point.fromBufferAttribute(positions, i).applyMatrix4(mesh.matrixWorld);
      if (point.y > plateTop) plateTop = point.y;
      if (point.y < plateBottom) plateBottom = point.y;
    }
  });

  // 2. Pose : la dalle se centre sur le terrain naturel de l'emprise, sans le
  // déplacer de travers (les collines du modèle restent ces collines-là).
  const natural = naturalHeightAt(CIRCUIT.cx, CIRCUIT.cz);
  const centreY = ((plateTop + plateBottom) / 2) * CIRCUIT.scale;
  root.scale.setScalar(CIRCUIT.scale);
  root.rotation.y = CIRCUIT.yaw;
  root.position.set(CIRCUIT.cx, natural - centreY, CIRCUIT.cz);
  root.updateMatrixWorld(true);
  scene.add(root);

  for (const mesh of [...groundMeshes, ...asphaltMeshes, ...looseMeshes]) {
    mesh.receiveShadow = true;
    // 183 000 triangles dans la passe d'ombres coûteraient plus qu'ils ne rendent.
    mesh.castShadow = false;
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap']) {
        const texture = (material as THREE.MeshStandardMaterial)[key as 'map'];
        if (texture) texture.anisotropy = options.anisotropy;
      }
      material.needsUpdate = true;
    }
  }

  // 3. Grille d'échantillonnage du sol, en coordonnées modèle puis monde.
  const halfX = CIRCUIT.plateHalfX;
  const halfZ = CIRCUIT.plateHalfZ;
  const columns = Math.ceil((halfX * 2) / (SAMPLE_STEP / CIRCUIT.scale));
  const rows = Math.ceil((halfZ * 2) / (SAMPLE_STEP / CIRCUIT.scale));
  const cells = columns * rows;
  const groundY = new Float32Array(cells).fill(Infinity);
  const surfaceY = new Float32Array(cells).fill(-Infinity);
  const covered = new Uint8Array(cells);
  /** 0 sous la dalle, puis 1, 2, 3… cases plus loin dans le raccord. */
  const ring = new Uint8Array(cells).fill(255);
  const asphaltMask = new Uint8Array(cells);
  const looseMask = new Uint8Array(cells);
  const stepLocal = SAMPLE_STEP / CIRCUIT.scale;
  const cos = Math.cos(CIRCUIT.yaw);
  const sin = Math.sin(CIRCUIT.yaw);

  const cellOf = (x: number, z: number, out: { cx: number; cz: number }): boolean => {
    const dx = x - CIRCUIT.cx;
    const dz = z - CIRCUIT.cz;
    const lx = (dx * cos - dz * sin) / CIRCUIT.scale;
    const lz = (dx * sin + dz * cos) / CIRCUIT.scale;
    out.cx = Math.floor((lx + halfX) / stepLocal);
    out.cz = Math.floor((lz + halfZ) / stepLocal);
    return out.cx >= 0 && out.cx < columns && out.cz >= 0 && out.cz < rows;
  };

  const cell = { cx: 0, cz: 0 };
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();

  /** Cases couvertes par une boîte au sol, bornées à la grille. */
  const cellBounds = (maxX: number, maxZ: number, out: { x1: number; z1: number }): boolean => {
    if (!cellOf(maxX, maxZ, cell)) return false;
    out.x1 = Math.min(columns - 1, Math.max(0, cell.cx));
    out.z1 = Math.min(rows - 1, Math.max(0, cell.cz));
    return true;
  };

  // Le point le plus bas de chaque case : le terrain reste sous l'herbe comme
  // sous l'asphalte, donc il ne peut pas percer la piste par en dessous.
  for (const mesh of groundMeshes) {
    const positions = mesh.geometry.attributes.position;
    for (let i = 0; i < positions.count; i++) {
      point.fromBufferAttribute(positions, i).applyMatrix4(mesh.matrixWorld);
      if (!cellOf(point.x, point.z, cell)) continue;
      const index = cell.cz * columns + cell.cx;
      covered[index] = 1;
      ring[index] = 0;
      if (point.y < groundY[index]) groundY[index] = point.y;
      if (point.y > surfaceY[index]) surfaceY[index] = point.y;
    }
  }

  // Revêtement : on marque la surface couverte par chaque triangle, ce qui suit
  // la piste d'assez près pour que la roue sache où elle roule.
  const mark = (mesh: THREE.Mesh, mask: Uint8Array): void => {
    const positions = mesh.geometry.attributes.position;
    const index = mesh.geometry.index;
    const count = index ? index.count : positions.count;
    for (let i = 0; i < count; i += 3) {
      const ia = index ? index.getX(i) : i;
      const ib = index ? index.getX(i + 1) : i + 1;
      const ic = index ? index.getX(i + 2) : i + 2;
      a.fromBufferAttribute(positions, ia).applyMatrix4(mesh.matrixWorld);
      b.fromBufferAttribute(positions, ib).applyMatrix4(mesh.matrixWorld);
      c.fromBufferAttribute(positions, ic).applyMatrix4(mesh.matrixWorld);
      if (
        !cellOf(
          Math.min(a.x, b.x, c.x),
          Math.min(a.z, b.z, c.z),
          cell,
        )
      ) {
        continue;
      }
      const fromX = Math.max(0, cell.cx);
      const fromZ = Math.max(0, cell.cz);
      if (!cellBounds(Math.max(a.x, b.x, c.x), Math.max(a.z, b.z, c.z), far)) continue;
      for (let cz = fromZ; cz <= far.z1; cz++) {
        for (let cx = fromX; cx <= far.x1; cx++) mask[cz * columns + cx] = 1;
      }
    }
  };
  const far = { x1: 0, z1: 0 };
  for (const mesh of asphaltMeshes) mark(mesh, asphaltMask);
  for (const mesh of looseMeshes) mark(mesh, looseMask);

  // Les cases sans sommet (grands triangles, trous dans la dalle) prennent la
  // cote la plus basse du voisinage : à nouveau, jamais au-dessus de la piste.
  // Les passes suivantes étalent cette cote vers l'extérieur : c'est le talus
  // qui raccorde la dalle au terrain, sinon elle se termine sur une falaise.
  for (let pass = 1; pass <= FADE_PASSES; pass++) {
    const filled = covered.slice();
    for (let cz = 0; cz < rows; cz++) {
      for (let cx = 0; cx < columns; cx++) {
        const index = cz * columns + cx;
        if (covered[index] || ring[index] !== 255) continue;
        let best = Infinity;
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = cx + dx;
            const nz = cz + dz;
            if (nx < 0 || nx >= columns || nz < 0 || nz >= rows) continue;
            const neighbour = nz * columns + nx;
            if (!covered[neighbour]) continue;
            if (groundY[neighbour] < best) best = groundY[neighbour];
          }
        }
        if (best === Infinity) continue;
        groundY[index] = best;
        filled[index] = 1;
        ring[index] = Math.min(255, pass);
      }
    }
    covered.set(filled);
  }

  CIRCUIT.ground = (x, z) => {
    if (!cellOf(x, z, cell)) return null;
    const index = cell.cz * columns + cell.cx;
    if (!covered[index]) return null;
    const plate = groundY[index] - GROUND_MARGIN;
    const distance = Math.max(0, ring[index] - HOLE_PASSES) * SAMPLE_STEP;
    if (distance <= 0) return plate;
    return fadeGround(plate, terrainBaseHeight(x, z), distance);
  };

  floorAt = (x, z) => {
    if (!cellOf(x, z, cell)) return null;
    const index = cell.cz * columns + cell.cx;
    if (!covered[index] || surfaceY[index] === -Infinity) return null;
    return surfaceY[index];
  };

  CIRCUIT.surface = (x, z): SurfaceKind | null => {
    if (!cellOf(x, z, cell)) return null;
    const index = cell.cz * columns + cell.cx;
    if (!covered[index]) return null;
    if (asphaltMask[index]) return 'asphalte';
    if (looseMask[index]) return 'terre';
    return 'herbe';
  };

  // 4. Trimesh : le modèle entier, transformé dans le repère du monde.
  const buildStarted = performance.now();
  let vertexTotal = 0;
  let indexTotal = 0;
  const allMeshes: THREE.Mesh[] = [];
  root.traverse((object) => {
    if ((object as THREE.Mesh).isMesh) allMeshes.push(object as THREE.Mesh);
  });
  for (const mesh of allMeshes) {
    vertexTotal += mesh.geometry.attributes.position.count;
    const index = mesh.geometry.index;
    indexTotal += index ? index.count : mesh.geometry.attributes.position.count;
  }
  const vertices = new Float32Array(vertexTotal * 3);
  const indices = new Uint32Array(indexTotal);
  let vertexOffset = 0;
  let indexOffset = 0;
  for (const mesh of allMeshes) {
    const positions = mesh.geometry.attributes.position;
    for (let i = 0; i < positions.count; i++) {
      point.fromBufferAttribute(positions, i).applyMatrix4(mesh.matrixWorld);
      vertices[(vertexOffset + i) * 3] = point.x;
      vertices[(vertexOffset + i) * 3 + 1] = point.y;
      vertices[(vertexOffset + i) * 3 + 2] = point.z;
    }
    const index = mesh.geometry.index;
    if (index) {
      for (let i = 0; i < index.count; i++) indices[indexOffset + i] = vertexOffset + index.getX(i);
      indexOffset += index.count;
    } else {
      for (let i = 0; i < positions.count; i++) indices[indexOffset + i] = vertexOffset + i;
      indexOffset += positions.count;
    }
    vertexOffset += positions.count;
  }

  const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  world.createCollider(
    RAPIER.ColliderDesc.trimesh(vertices, indices)
      .setFriction(0.95)
      .setRestitution(0.02)
      .setCollisionGroups(GROUND_GROUP),
    body,
  );

  // 5. Départ : la ligne droite des stands, dans le repère du monde.
  const spawnX = CIRCUIT.cx + (START_LOCAL.x * cos + START_LOCAL.z * sin) * CIRCUIT.scale;
  const spawnZ = CIRCUIT.cz + (-START_LOCAL.x * sin + START_LOCAL.z * cos) * CIRCUIT.scale;
  const spawn = {
    x: spawnX,
    z: spawnZ,
    heading: START_LOCAL.heading + CIRCUIT.yaw,
  };

  return {
    spawn,
    meshes,
    triangles: Math.round(triangles),
    loadMs: Math.round(loadMs),
    buildMs: Math.round(performance.now() - buildStarted),
  };
}
