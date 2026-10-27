/**
 * The city's buildings, from the Sketchfab packs in public/models/buildings.
 *
 * Each pack is a small diorama: the skyscraper set is a row of miniature
 * towers, the other two are street blocks. Every top-level child is therefore
 * one building. It is baked into its own local space (base on y = 0, centred on
 * the footprint) and reused as an instanced prototype, so the whole town costs
 * a few dozen draw calls instead of a few hundred.
 *
 * The models that are only a facade — four walls with no back — get a massing
 * block behind them: a driver looking down the street sees the modelled front,
 * and the alley side stays solid instead of showing the inside of an empty
 * shell.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import RAPIER from '@dimforge/rapier3d-compat';
import { heightAt, nearestRoad } from './layout.ts';
import type { EnvironmentMaterials } from '../render/materials.ts';

const MODELS = `${import.meta.env.BASE_URL}models/buildings`;

/** One lot the town planner hands to the kit: footprint, height and ground. */
export interface BuildingLot {
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
  y: number;
}

export interface BuildingSummary {
  models: number;
  instances: number;
  triangles: number;
}

/** Filled in by `buildBuildings`, read by the smoke test. */
export const BUILDINGS: BuildingSummary = { models: 0, instances: 0, triangles: 0 };

interface Part {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
}

interface Prototype {
  name: string;
  kind: 'tower' | 'facade';
  size: THREE.Vector3;
  parts: Part[];
}

const loader = new GLTFLoader();

/** Bakes one node of the pack into its own space, base at y = 0. */
function bake(node: THREE.Object3D): { parts: Part[]; size: THREE.Vector3 } | null {
  node.updateWorldMatrix(true, true);
  const group = new THREE.Group();
  node.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    const geometry = mesh.geometry.clone();
    geometry.applyMatrix4(mesh.matrixWorld);
    group.add(new THREE.Mesh(geometry, mesh.material as THREE.Material));
  });
  if (group.children.length === 0) return null;

  const box = new THREE.Box3().setFromObject(group);
  const size = box.getSize(new THREE.Vector3());
  // The dioramas ship with their own ground plane and a lamp post: neither is
  // a building, and both are far wider than they are tall.
  if (size.y < 0.6 || size.x < 0.4 || size.z < 0.4) return null;
  if (size.y < 10 && size.y / Math.max(size.x, size.z) < 0.12) return null;

  const centre = box.getCenter(new THREE.Vector3());
  for (const child of group.children) {
    (child as THREE.Mesh).geometry.translate(-centre.x, -box.min.y, -centre.z);
  }

  // One draw call per material: the tower shells are split into glass, frame
  // and roof, which all share the same texture atlas entry.
  const byMaterial = new Map<THREE.Material, THREE.BufferGeometry[]>();
  for (const child of group.children) {
    const mesh = child as THREE.Mesh;
    const material = mesh.material as THREE.Material;
    const list = byMaterial.get(material) ?? [];
    list.push(mesh.geometry as THREE.BufferGeometry);
    byMaterial.set(material, list);
  }

  const parts: Part[] = [];
  for (const [material, geometries] of byMaterial) {
    const merged = geometries.length === 1 ? geometries[0] : mergeGeometries(geometries, false);
    if (merged) parts.push({ geometry: merged, material });
    else for (const geometry of geometries) parts.push({ geometry, material });
  }

  return { parts, size };
}

async function loadPack(
  file: string,
  kind: Prototype['kind'],
  keep: (name: string) => boolean,
): Promise<Prototype[]> {
  let gltf;
  try {
    gltf = await loader.loadAsync(`${MODELS}/${file}`);
  } catch (error) {
    console.warn(`Pack de bâtiments indisponible : ${file}`, error);
    return [];
  }
  gltf.scene.updateMatrixWorld(true);
  // The packs wrap their content in a chain of empty roots (Sketchfab_model,
  // the .fbx node, RootNode): the buildings are the children of the last one.
  let container: THREE.Object3D = gltf.scene;
  while (container.children.length === 1) container = container.children[0];

  const prototypes: Prototype[] = [];
  for (const node of container.children) {
    if (!keep(node.name ?? '')) continue;
    const baked = bake(node);
    if (!baked) continue;
    for (const part of baked.parts) {
      const material = part.material as THREE.MeshStandardMaterial;
      if (material.map) {
        material.map.anisotropy = 4;
        material.map.needsUpdate = true;
      }
    }
    prototypes.push({
      name: node.name ?? file,
      kind,
      size: baked.size,
      parts: baked.parts,
    });
  }
  return prototypes;
}

let cached: Prototype[] | null = null;

export async function loadBuildingKit(): Promise<Prototype[]> {
  if (cached) return cached;
  const [towers, fronts] = await Promise.all([
    loadPack('skyline_towers.glb', 'tower', (name) => !/^(Lamp|Plane)/.test(name)),
    loadPack('street_fronts.glb', 'facade', (name) => /[Bb]uild/.test(name)),
  ]);
  cached = [...towers, ...fronts];
  return cached;
}


/**
 * Places the kit on the lots the planner produced. Returns nothing: the meshes
 * are added to the scene, the colliders to the world.
 */
export async function buildBuildings(
  scene: THREE.Scene,
  world: RAPIER.World,
  mats: EnvironmentMaterials,
  lots: BuildingLot[],
  rand: () => number,
): Promise<BuildingSummary> {
  const prototypes = await loadBuildingKit();
  if (prototypes.length === 0) {
    console.warn('Aucun bâtiment modélisé : la ville reste en boîtes.');
    return fallbackBoxes(scene, world, mats, lots);
  }

  const towers = prototypes.filter((p) => p.kind === 'tower');
  const facades = prototypes.filter((p) => p.kind === 'facade');
  const picks = new Map<Prototype, THREE.Matrix4[]>();
  const masses: THREE.Matrix4[] = [];
  const plazas: THREE.BufferGeometry[] = [];
  const colliders: { x: number; y: number; z: number; yaw: number; hx: number; hy: number; hz: number }[] = [];
  const tan = new THREE.Vector3(0, 1, 0);
  let triangleTotal = 0;

  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();

  for (const lot of lots) {
    // Tall lots become towers, low ones a modelled street wall. The scale is
    // capped by the lot on every axis, so nothing overhangs its block.
    const useTower = lot.h >= 21 || facades.length === 0;
    const pool = useTower ? towers : facades;
    if (pool.length === 0) continue;
    const proto = pool[Math.floor(rand() * pool.length) % pool.length];

    // A facade is thin along x and long along z: its width is driven by the
    // lot, not by the model's own footprint.
    const width = proto.kind === 'facade' ? Math.max(lot.w, lot.d) : lot.w;
    const uniform = Math.min(
      lot.h / proto.size.y,
      width / (proto.kind === 'facade' ? proto.size.z : proto.size.x),
      lot.d / proto.size.z,
    );
    const s = Math.max(0.1, uniform * 0.94);
    const height = proto.size.y * s;

    let yaw: number;
    if (proto.kind === 'facade') {
      const road = nearestRoad(lot.x, lot.z);
      const dx = road.x - lot.x;
      const dz = road.z - lot.z;
      // The modelled fronts look down their own +x.
      yaw = Math.hypot(dx, dz) > 0.5 ? Math.atan2(-dz, dx) : 0;
    } else {
      yaw = Math.floor(rand() * 4) * (Math.PI / 2);
    }

    position.set(lot.x, lot.y - 0.8, lot.z);
    quaternion.setFromAxisAngle(tan, yaw);
    scale.set(s, s, s);
    const matrix = new THREE.Matrix4().compose(position, quaternion, scale);
    const list = picks.get(proto) ?? [];
    list.push(matrix);
    picks.set(proto, list);

    const footprintX = proto.size.x * s;
    const footprintZ = proto.size.z * s;
    let massingDepth = 0;
    if (proto.kind === 'facade') {
      // Behind the facade, capped so the block never spills onto the road.
      massingDepth = Math.min(14, Math.max(4, lot.d - footprintX));
      const back = new THREE.Vector3(-massingDepth, 0, 0).applyAxisAngle(tan, yaw);
      const mass = new THREE.Matrix4().compose(
        position.clone().add(back),
        quaternion,
        new THREE.Vector3(massingDepth, height, footprintZ * 0.98),
      );
      masses.push(mass);
    }

    // A paved apron under every block: a tower standing straight on the grass
    // reads as a prop dropped on a lawn, the same tower on concrete reads as a
    // street. The apron follows the terrain vertex by vertex, so it cannot
    // float on one side of a slope.
    const apronDepth = proto.kind === 'facade' ? footprintX + massingDepth + 2 : footprintX + 2.6;
    const apronWidth = footprintZ + 2.2;
    const apron = new THREE.PlaneGeometry(apronDepth, apronWidth, 5, 5);
    apron.rotateX(-Math.PI / 2);
    apron.translate(proto.kind === 'facade' ? -massingDepth * 0.5 : 0, 0, 0);
    apron.rotateY(yaw);
    apron.translate(lot.x, 0, lot.z);
    const vertices = apron.getAttribute('position');
    const uvs = apron.getAttribute('uv');
    for (let i = 0; i < vertices.count; i++) {
      const vx = vertices.getX(i);
      const vz = vertices.getZ(i);
      vertices.setY(i, heightAt(vx, vz) + 0.05);
      uvs.setXY(i, uvs.getX(i) * (apronDepth / 7), uvs.getY(i) * (apronWidth / 7));
    }
    apron.computeVertexNormals();
    plazas.push(apron);

    const halfX = (footprintX * Math.abs(Math.cos(yaw)) + footprintZ * Math.abs(Math.sin(yaw))) / 2;
    const halfZ = (footprintX * Math.abs(Math.sin(yaw)) + footprintZ * Math.abs(Math.cos(yaw))) / 2;
    colliders.push({
      x: lot.x + (proto.kind === 'facade' ? -Math.cos(yaw) * massingDepth * 0.5 : 0),
      z: lot.z + (proto.kind === 'facade' ? Math.sin(yaw) * massingDepth * 0.5 : 0),
      y: lot.y - 0.8 + height / 2,
      yaw,
      hx: (halfX + (proto.kind === 'facade' ? Math.abs(Math.cos(yaw)) * massingDepth * 0.5 : 0)) * 1.0,
      hy: height / 2,
      hz: (halfZ + (proto.kind === 'facade' ? Math.abs(Math.sin(yaw)) * massingDepth * 0.5 : 0)) * 1.0,
    });
  }

  for (const [proto, matrices] of picks) {
    for (const part of proto.parts) {
      const mesh = new THREE.InstancedMesh(part.geometry, part.material, matrices.length);
      mesh.name = `city-${proto.name}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      for (let i = 0; i < matrices.length; i++) mesh.setMatrixAt(i, matrices[i]);
      // The pack has one texture per tower, but every copy of a tower came out
      // the same shade. A per-instance tint breaks the repetition without a
      // second draw call.
      if (proto.kind === 'tower') {
        const tint = new THREE.Color();
        for (let i = 0; i < matrices.length; i++) {
          const shade = 0.78 + ((i * 37) % 100) / 100 * 0.22;
          tint.setRGB(shade, shade * 0.99, shade * 0.96);
          mesh.setColorAt(i, tint);
        }
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      scene.add(mesh);
    }
    const tris = proto.parts.reduce((sum, part) => {
      const index = part.geometry.getIndex();
      return sum + (index ? index.count : part.geometry.getAttribute('position').count) / 3;
    }, 0);
    triangleTotal += tris * matrices.length;
  }

  if (masses.length > 0) {
    // The massing block reuses the town's window material: a flat grey slab
    // behind a modelled facade reads as a bunker from the alley side.
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mats.buildingLow, masses.length);
    mesh.name = 'city-facade-masses';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    for (let i = 0; i < masses.length; i++) mesh.setMatrixAt(i, masses[i]);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    scene.add(mesh);
  }

  if (plazas.length > 0) {
    const merged = mergeGeometries(plazas, false);
    const mesh = new THREE.Mesh(merged ?? plazas[0], mats.concrete);
    mesh.name = 'city-plazas';
    mesh.receiveShadow = true;
    if (!merged) for (const geometry of plazas.slice(1)) scene.add(new THREE.Mesh(geometry, mats.concrete));
    scene.add(mesh);
  }

  const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  quaternion.identity();
  for (const c of colliders) {
    quaternion.setFromAxisAngle(tan, c.yaw);
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(c.hx, c.hy, c.hz)
        .setTranslation(c.x, c.y, c.z)
        .setRotation({ x: quaternion.x, y: quaternion.y, z: quaternion.z, w: quaternion.w })
        .setFriction(0.7),
      body,
    );
  }

  BUILDINGS.models = prototypes.length;
  BUILDINGS.instances = colliders.length;
  BUILDINGS.triangles = Math.round(triangleTotal);
  return { ...BUILDINGS };
}

/** Last resort: the flat instanced boxes the town used before the packs. */
function fallbackBoxes(
  scene: THREE.Scene,
  world: RAPIER.World,
  mats: EnvironmentMaterials,
  lots: BuildingLot[],
): BuildingSummary {
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const mesh = new THREE.InstancedMesh(geometry, mats.buildingMid, Math.max(1, lots.length));
  mesh.count = lots.length;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  const matrix = new THREE.Matrix4();
  for (let i = 0; i < lots.length; i++) {
    const lot = lots[i];
    matrix.compose(
      new THREE.Vector3(lot.x, lot.y + lot.h / 2 - 1.2, lot.z),
      new THREE.Quaternion(),
      new THREE.Vector3(lot.w, lot.h, lot.d),
    );
    mesh.setMatrixAt(i, matrix);
  }
  mesh.computeBoundingSphere();
  scene.add(mesh);

  const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  for (const lot of lots) {
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(lot.w / 2, lot.h / 2, lot.d / 2)
        .setTranslation(lot.x, lot.y + lot.h / 2 - 1.2, lot.z)
        .setFriction(0.7),
      body,
    );
  }
  BUILDINGS.models = 0;
  BUILDINGS.instances = lots.length;
  BUILDINGS.triangles = 12 * lots.length;
  return { ...BUILDINGS };
}
