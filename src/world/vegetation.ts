import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  CITY,
  DIRT_TRACKS,
  SAMPLED_ROADS,
  SUMMIT,
  heightAt,
  padEdgeDistance,
  roadClearance,
  surfaceAt,
} from './layout.ts';
import { GROUP_WORLD } from '../physics/vehicle.ts';

/**
 * Trees and grass from the two models the art folder ships.
 *
 * Both GLBs are authored at survey scale: the trees are hundreds of units tall
 * and every clump of grass sits at its own spot in the file. Each named tree is
 * therefore baked out on its own, normalised to one metre, and then drawn as an
 * instanced mesh. The grass uses the `KHR_materials_pbrSpecularGlossiness`
 * extension, which three does not implement, so its diffuse textures are read
 * from the parser and rebuilt as standard materials: otherwise the whole lawn
 * comes out white.
 */

const loader = new GLTFLoader();
const MODEL_ROOT = import.meta.env.BASE_URL;

export interface VegetationSummary {
  trees: number;
  grass: number;
}

interface Part {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
}

interface Variant {
  parts: Part[];
}

interface Placement {
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale: number;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Copies a mesh into plain floats and folds its world transform into them. */
function bakeMesh(mesh: THREE.Mesh, transform: THREE.Matrix4): THREE.BufferGeometry {
  const source = mesh.geometry;
  const position = source.getAttribute('position');
  const normal = source.getAttribute('normal');
  const uv = source.getAttribute('uv');
  const count = position.count;

  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    positions[i * 3] = position.getX(i);
    positions[i * 3 + 1] = position.getY(i);
    positions[i * 3 + 2] = position.getZ(i);
  }
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

  if (normal) {
    const normals = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      normals[i * 3] = normal.getX(i);
      normals[i * 3 + 1] = normal.getY(i);
      normals[i * 3 + 2] = normal.getZ(i);
    }
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  }
  if (uv) {
    const uvs = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      uvs[i * 2] = uv.getX(i);
      uvs[i * 2 + 1] = uv.getY(i);
    }
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  }
  if (source.index) {
    const src = source.index.array as ArrayLike<number>;
    const index = new Uint32Array(src.length);
    index.set(src as unknown as ArrayLike<number>);
    geometry.setIndex(new THREE.BufferAttribute(index, 1));
  }

  geometry.applyMatrix4(transform);
  geometry.computeBoundingSphere();
  return geometry;
}

/** Bakes one named subtree into a one-metre-tall, ground-anchored variant. */
function extractVariant(node: THREE.Object3D): Variant | null {
  node.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(node);
  const height = box.max.y - box.min.y;
  if (!(height > 0.01)) return null;
  const centre = box.getCenter(new THREE.Vector3());
  const scale = 1 / height;
  const normalise = new THREE.Matrix4()
    .makeScale(scale, scale, scale)
    .multiply(new THREE.Matrix4().makeTranslation(-centre.x, -box.min.y, -centre.z));

  const parts: Part[] = [];
  node.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    parts.push({
      geometry: bakeMesh(mesh, new THREE.Matrix4().multiplyMatrices(normalise, mesh.matrixWorld)),
      material: mesh.material as THREE.Material,
    });
  });
  return parts.length > 0 ? { parts } : null;
}

function instance(
  scene: THREE.Scene,
  variant: Variant,
  placements: Placement[],
  name: string,
  shadows: boolean,
): void {
  if (placements.length === 0) return;
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();

  for (const part of variant.parts) {
    const mesh = new THREE.InstancedMesh(part.geometry, part.material, placements.length);
    mesh.name = name;
    mesh.castShadow = shadows;
    mesh.receiveShadow = true;
    for (let i = 0; i < placements.length; i++) {
      const p = placements[i];
      position.set(p.x, p.y, p.z);
      quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.yaw);
      scale.setScalar(p.scale);
      matrix.compose(position, quaternion, scale);
      mesh.setMatrixAt(i, matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    scene.add(mesh);
  }
}

/**
 * The grass model's materials use specular-glossiness: rebuild them from the
 * diffuse texture and cut the alpha instead of blending, which keeps the tufts
 * out of the transparency sort and lets them cast shadows.
 */
async function grassMaterials(gltf: Awaited<ReturnType<GLTFLoader['loadAsync']>>): Promise<Map<string, THREE.Material>> {
  const json = gltf.parser.json as {
    materials?: {
      name?: string;
      extensions?: {
        KHR_materials_pbrSpecularGlossiness?: { diffuseTexture?: { index: number } };
      };
    }[];
  };
  const out = new Map<string, THREE.Material>();
  for (const material of json.materials ?? []) {
    const extension = material.extensions?.KHR_materials_pbrSpecularGlossiness;
    const name = material.name ?? '';
    if (!extension?.diffuseTexture) continue;
    try {
      const texture = (await gltf.parser.getDependency('texture', extension.diffuseTexture.index)) as THREE.Texture;
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = 4;
      out.set(
        name,
        new THREE.MeshStandardMaterial({
          map: texture,
          // The scan is autumn-dry; a pale green tint ties it to the painted
          // terrain instead of reading as straw dropped on a lawn.
          color: 0xd6e2b4,
          alphaTest: 0.12,
          side: THREE.DoubleSide,
          roughness: 0.95,
          metalness: 0,
        }),
      );
    } catch {
      // A missing texture is not a reason to lose the grass.
    }
  }
  return out;
}

export async function buildVegetation(
  scene: THREE.Scene,
  world: RAPIER.World,
  lowFx: boolean,
): Promise<VegetationSummary> {
  const [trees, birches, grass] = await Promise.all([
    loader.loadAsync(`${MODEL_ROOT}models/cars/trees_low_poly.glb`),
    loader.loadAsync(`${MODEL_ROOT}models/cars/birch_trees.glb`),
    loader.loadAsync(`${MODEL_ROOT}models/cars/grass.glb`),
  ]);

  // Leaf cards are alpha-cut in the source; blending them would sort badly at
  // distance and self-shadow into black blotches.
  for (const gltf of [trees, birches]) {
    gltf.scene.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      const material = mesh.material as THREE.MeshStandardMaterial;
      material.side = THREE.DoubleSide;
      material.transparent = false;
      // The birch cards are almost all transparent pixels: a high cut-off
      // leaves only the dark twigs and the tree reads as a burnt skeleton.
      material.alphaTest = 0.1;
      material.depthWrite = true;
      material.needsUpdate = true;
    });
  }

  // --- Tree variants ------------------------------------------------------
  const treeVariants: { variant: Variant; height: number }[] = [];
  const treeSources: [THREE.Object3D | undefined, number][] = [
    [trees.scene.getObjectByName('tree4'), 12],
    [trees.scene.getObjectByName('tree6'), 8.5],
    [birches.scene.getObjectByName('birch-1'), 11],
    [birches.scene.getObjectByName('birch-2'), 9.5],
    [birches.scene.getObjectByName('birch-3'), 6.5],
    [birches.scene.getObjectByName('birch-4'), 10],
  ];
  for (const [node, height] of treeSources) {
    if (!node) continue;
    const variant = extractVariant(node);
    if (variant) treeVariants.push({ variant, height });
  }

  const rand = mulberry32(0x5f95);
  const treeCount = lowFx ? 140 : 780;
  const placements: Placement[][] = treeVariants.map(() => []);
  const trunks: { x: number; y: number; z: number; height: number; radius: number }[] = [];
  const spacing: { x: number; z: number }[] = [];

  let attempts = 0;
  let placedTrees = 0;
  while (placedTrees < treeCount && attempts < treeCount * 50) {
    attempts++;
    // The massif keeps its forest, but most trunks now line the roads and the
    // dirt stages: that is the landscape the player actually drives through.
    const roll = rand();
    let x: number;
    let z: number;
    if (roll < 0.3) {
      const angle = rand() * Math.PI * 2;
      const radius = 25 + rand() * 300;
      x = -480 + Math.cos(angle) * radius;
      z = -420 + Math.sin(angle) * radius;
    } else if (roll < 0.86) {
      const roads = [...SAMPLED_ROADS, ...DIRT_TRACKS];
      const road = roads[Math.floor(rand() * roads.length)];
      const point = road.points[Math.floor(rand() * road.points.length)];
      const angle = rand() * Math.PI * 2;
      const radius = road.def.width * 0.5 + 9 + rand() * 52;
      x = point.x + Math.cos(angle) * radius;
      z = point.z + Math.sin(angle) * radius;
    } else {
      const angle = rand() * Math.PI * 2;
      const radius = 120 + rand() * 820;
      x = Math.cos(angle) * radius;
      z = Math.sin(angle) * radius;
    }

    if (Math.abs(x) > 960 || Math.abs(z) > 960) continue;
    if (x > CITY.minX - 8 && x < CITY.maxX + 8 && z > CITY.minZ - 8 && z < CITY.maxZ + 8) continue;
    if (Math.hypot(x - SUMMIT.cx, z - SUMMIT.cz) < SUMMIT.radius + 9) continue;
    if (padEdgeDistance(x, z) < 9) continue;
    // The housing lots sit a few metres off the pavement: near the city a
    // trunk needs a much wider berth, or the canopy comes out of a roof.
    const nearCity =
      x > CITY.minX - 60 && x < CITY.maxX + 60 && z > CITY.minZ - 60 && z < CITY.maxZ + 60;
    if (roadClearance(x, z) < (nearCity ? 16 : 7)) continue;
    if (surfaceAt(x, z).kind !== 'herbe') continue;

    const y = heightAt(x, z);
    const gx = heightAt(x + 3, z) - y;
    const gz = heightAt(x, z + 3) - y;
    if (Math.hypot(gx, gz) / 3 > 0.72) continue;
    if (spacing.some((other) => (other.x - x) ** 2 + (other.z - z) ** 2 < 7 * 7)) continue;

    const variantIndex = Math.floor(rand() * treeVariants.length);
    const variant = treeVariants[variantIndex];
    const scale = variant.height * (0.78 + rand() * 0.5);
    placements[variantIndex].push({ x, y, z, yaw: rand() * Math.PI * 2, scale });
    spacing.push({ x, z });
    trunks.push({ x, y, z, height: scale * 0.8, radius: Math.max(0.18, scale * 0.028) });
    placedTrees++;
  }

  const names = ['tree4', 'tree6', 'birch-1', 'birch-2', 'birch-3', 'birch-4'];
  treeVariants.forEach((entry, i) => {
    instance(scene, entry.variant, placements[i], `trees-${names[i] ?? i}`, !lowFx);
  });

  // Trunks are solid: a forest you can drive through is wallpaper. One static
  // body carries every collider, so the broad phase sees a single island.
  if (trunks.length > 0) {
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    for (const trunk of trunks) {
      world.createCollider(
        RAPIER.ColliderDesc.cylinder(trunk.height * 0.5, trunk.radius)
          .setTranslation(trunk.x, trunk.y + trunk.height * 0.5, trunk.z)
          .setCollisionGroups((GROUP_WORLD << 16) | GROUP_WORLD),
        body,
      );
    }
  }

  // --- Grass --------------------------------------------------------------
  const materialMap = await grassMaterials(grass);
  const grassVariants: Variant[] = [];
  for (const name of ['Grass1', 'GrassAutumn3']) {
    const node = grass.scene.getObjectByName(name);
    if (!node) continue;
    node.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      const original = mesh.material as THREE.Material;
      const replacement = materialMap.get(original.name);
      if (replacement) mesh.material = replacement;
    });
    const variant = extractVariant(node);
    if (variant) grassVariants.push(variant);
  }

  const grassPlacements: Placement[][] = grassVariants.map(() => []);
  const grassCount = lowFx ? 600 : 2400;
  const roads = [...SAMPLED_ROADS, ...DIRT_TRACKS];
  let placedGrass = 0;
  attempts = 0;
  while (placedGrass < grassCount && attempts < grassCount * 60) {
    attempts++;
    // Most tufts line the verges of the asphalt and dirt roads: that is where
    // the player sees them from the saddle. A few fill the meadows.
    const alongRoad = rand() < 0.78;
    let x: number;
    let z: number;
    let referenceHeight: number | null = null;
    if (alongRoad) {
      const road = roads[Math.floor(rand() * roads.length)];
      const points = road.points;
      const i = Math.floor(rand() * points.length);
      const a = points[i];
      const b = points[(i + 1) % points.length];
      const tx = b.x - a.x;
      const tz = b.z - a.z;
      const length = Math.hypot(tx, tz) || 1;
      const side = rand() < 0.5 ? -1 : 1;
      const offset = road.def.width * 0.5 + 0.6 + rand() * 4.2;
      x = a.x + (tz / length) * offset * side;
      z = a.z + (-tx / length) * offset * side;
      referenceHeight = a.y;
    } else {
      const angle = rand() * Math.PI * 2;
      const radius = 30 + rand() * 380;
      x = -480 + Math.cos(angle) * radius;
      z = -420 + Math.sin(angle) * radius;
    }

    if (Math.abs(x) > 960 || Math.abs(z) > 960) continue;
    if (surfaceAt(x, z).kind !== 'herbe') continue;
    if (roadClearance(x, z) < 0.4) continue;
    const y = heightAt(x, z);
    if (referenceHeight !== null && Math.abs(y - referenceHeight) > 1.6) continue;
    const gx = heightAt(x + 2, z) - y;
    const gz = heightAt(x, z + 2) - y;
    if (Math.hypot(gx, gz) / 2 > 0.65) continue;

    const variantIndex = Math.floor(rand() * grassVariants.length);
    grassPlacements[variantIndex].push({
      x,
      y,
      z,
      yaw: rand() * Math.PI * 2,
      scale: 0.9 + rand() * 0.9,
    });
    placedGrass++;
  }

  grassVariants.forEach((variant, i) => {
    instance(scene, variant, grassPlacements[i], `grass-${i}`, false);
  });

  return { trees: placedTrees, grass: placedGrass };
}
