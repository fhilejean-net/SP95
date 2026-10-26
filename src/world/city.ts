import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import {
  CITY,
  DRIFT_PAD,
  SAMPLED_ROADS,
  SUMMIT,
  heightAt,
  nearestRoad,
  padEdgeDistance,
  roadClearance,
} from './layout.ts';
import { roadEnds } from './terrain.ts';
import type { EnvironmentMaterials } from '../render/materials.ts';

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

interface BuildingLot {
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
  y: number;
  color: THREE.Color;
}

export interface DynamicProp {
  body: RAPIER.RigidBody;
  mesh: THREE.Object3D;
}

/** Counts for the smoke test: the city has to look lived in, not just filled. */
export const NEIGHBOURHOODS = { houses: 0, shops: 0 };

/** A pitched roof: five faces of a tent, 1 m wide, 1 m deep, 1 m tall. */
function gableGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(
      [
        -0.5, 0, -0.5, 0.5, 0, -0.5, 0, 1, -0.5,
        -0.5, 0, 0.5, 0.5, 0, 0.5, 0, 1, 0.5,
      ],
      3,
    ),
  );
  geometry.setIndex([0, 2, 1, 3, 4, 5, 0, 3, 5, 0, 5, 2, 1, 2, 5, 1, 5, 4]);
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * The dead ends used to be a turning circle and nothing else: a driver had no
 * reason to go there. Every street now runs through a row of houses on both
 * sides, and half of them end on a shop with its sign on. It is all instanced,
 * so a hundred and fifty buildings cost three draw calls.
 */
function buildNeighbourhoods(
  scene: THREE.Scene,
  world: RAPIER.World,
  mats: EnvironmentMaterials,
  rand: () => number,
): void {
  const ends = roadEnds();
  const placed: { x: number; z: number }[] = [];
  const free = (x: number, z: number, gap: number): boolean => {
    for (const p of placed) {
      if (Math.hypot(p.x - x, p.z - z) < gap) return false;
    }
    return true;
  };
  const bodies: { x: number; y: number; z: number; yaw: number; sx: number; sy: number; sz: number; tint: THREE.Color }[] = [];
  const roofs: typeof bodies = [];
  const shops: typeof bodies = [];
  const colliders: { x: number; y: number; z: number; yaw: number; sx: number; sy: number; sz: number }[] = [];

  const palettes = [0xf0e2cf, 0xe6d3b8, 0xd8c3a5, 0xcfd6cd, 0xe9d8c8, 0xd3c0b0];

  const placeHouse = (
    cx: number,
    cz: number,
    faceX: number,
    faceZ: number,
    gap: number,
  ): void => {
    if (!free(cx, cz, gap)) return;
    if (roadClearance(cx, cz) < 8.5) return;
    if (padEdgeDistance(cx, cz) < 14) return;
    if (Math.hypot(cx - SUMMIT.cx, cz - SUMMIT.cz) < SUMMIT.radius + 14) return;
    if (Math.hypot(cx - DRIFT_PAD.cx, cz - DRIFT_PAD.cz) < 90) return;
    const ground = heightAt(cx, cz);
    const yaw = Math.atan2(-faceX, -faceZ);
    const sx = 8.4 + rand() * 2.6;
    const sz = 7.2 + rand() * 2.2;
    const sy = 3.4 + rand() * 2.4;
    const tint = new THREE.Color(palettes[Math.floor(rand() * palettes.length)]);
    bodies.push({ x: cx, y: ground - 0.7 + sy / 2, z: cz, yaw, sx, sy, sz, tint });
    roofs.push({
      x: cx,
      y: ground - 0.7 + sy,
      z: cz,
      yaw,
      sx: sx * 1.14,
      sy: 1.7 + rand() * 1.1,
      sz: sz * 1.12,
      tint: new THREE.Color(1, 1, 1),
    });
    colliders.push({ x: cx, y: ground - 0.7 + sy / 2, z: cz, yaw, sx, sy, sz });
    placed.push({ x: cx, z: cz });
    NEIGHBOURHOODS.houses++;
  };

  // Shops first: a shop closes the street. It sits past the turning circle,
  // its door and its sign facing the driver, so the dead end is a destination
  // instead of a circle of asphalt in a field. Houses would take that spot if
  // the rows were placed first.
  for (const end of ends) {
    const sx = 13.5;
    const sz = 9.2;
    const sy = 4.8;
    const back = end.radius + 1.4 + sz / 2;
    const cx = end.x + end.dx * back;
    const cz = end.z + end.dz * back;
    if (roadClearance(cx, cz) < 9) continue;
    if (padEdgeDistance(cx, cz) < 14) continue;
    if (Math.hypot(cx - DRIFT_PAD.cx, cz - DRIFT_PAD.cz) < 90) continue;
    if (Math.hypot(cx - SUMMIT.cx, cz - SUMMIT.cz) < SUMMIT.radius + 20) continue;
    const ground = heightAt(cx, cz);
    // The shop's front is its local -Z, turned to face back down the street.
    const yaw = Math.atan2(end.dx, end.dz);
    const y = ground - 0.9 + sy / 2;
    shops.push({ x: cx, y, z: cz, yaw, sx, sy, sz, tint: new THREE.Color(0xffffff) });
    colliders.push({ x: cx, y, z: cz, yaw, sx, sy, sz });
    // Every corner counts as taken, so no house row grows through the shop.
    const rightX = -end.dz;
    const rightZ = end.dx;
    for (const along of [-1, 0, 1]) {
      for (const across of [-1, 1]) {
        placed.push({
          x: cx + end.dx * along * sz * 0.5 + rightX * across * sx * 0.5,
          z: cz + end.dz * along * sz * 0.5 + rightZ * across * sx * 0.5,
        });
      }
    }
    NEIGHBOURHOODS.shops++;
  }

  // Town houses along every open street: the blocks read as streets with
  // addresses, not as grass with the odd tower dropped on it.
  for (const road of SAMPLED_ROADS) {
    if (road.def.closed || road.def.surface === 'dirt') continue;
    if (road.def.kind === 'rural') continue;
    const points = road.points;
    let travelled = 0;
    let next = 12;
    let side = 1;
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const length = Math.hypot(dx, dz);
      if (length < 0.01) continue;
      const tx = dx / length;
      const tz = dz / length;
      while (next <= travelled + length) {
        const t = (next - travelled) / length;
        const px = a.x + dx * t;
        const pz = a.z + dz * t;
        const nx = -tz;
        const nz = tx;
        const cx = px + nx * side * 13.2;
        const cz = pz + nz * side * 13.2;
        placeHouse(cx, cz, -nx * side, -nz * side, 8.5);
        side *= -1;
        next += 15.5;
      }
      travelled += length;
    }
  }

  // Extra depth at the dead ends, where the turn-around deserves a square.
  for (const end of ends) {
    const nx = -end.dz;
    const nz = end.dx;
    for (const side of [-1, 1]) {
      for (let i = 0; i < 4; i++) {
        const back = 27 + i * 13.5;
        const cx = end.x - end.dx * back + nx * side * 12.6;
        const cz = end.z - end.dz * back + nz * side * 12.6;
        placeHouse(cx, cz, -nx * side, -nz * side, 9);
      }
    }
  }

  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);

  const instanced = (
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    list: typeof bodies,
    name: string,
  ): THREE.InstancedMesh => {
    const mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, list.length));
    mesh.count = list.length;
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      position.set(item.x, item.y, item.z);
      quaternion.setFromAxisAngle(up, item.yaw);
      scale.set(item.sx, item.sy, item.sz);
      matrix.compose(position, quaternion, scale);
      mesh.setMatrixAt(i, matrix);
      mesh.setColorAt(i, item.tint);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    scene.add(mesh);
    return mesh;
  };

  instanced(new THREE.BoxGeometry(1, 1, 1), mats.house, bodies, 'houses');
  instanced(gableGeometry(), mats.roofTile, roofs, 'house-roofs');
  instanced(new THREE.BoxGeometry(1, 1, 1), mats.shop, shops, 'shops');

  // Signboards over the shop doors, and an awning under each one.
  const signs: typeof bodies = [];
  const awnings: typeof bodies = [];
  for (const shop of shops) {
    const face = new THREE.Vector3(0, 0, -1).applyAxisAngle(up, shop.yaw);
    signs.push({
      x: shop.x + face.x * (shop.sz / 2 + 0.16),
      y: shop.y + shop.sy / 2 - 0.5,
      z: shop.z + face.z * (shop.sz / 2 + 0.16),
      yaw: shop.yaw,
      sx: shop.sx * 0.62,
      sy: 0.9,
      sz: 0.18,
      tint: new THREE.Color(1, 1, 1),
    });
    awnings.push({
      x: shop.x + face.x * (shop.sz / 2 + 0.85),
      y: shop.y + shop.sy / 2 - 1.35,
      z: shop.z + face.z * (shop.sz / 2 + 0.85),
      yaw: shop.yaw,
      sx: shop.sx * 0.8,
      sy: 0.14,
      sz: 1.7,
      tint: new THREE.Color(1, 1, 1),
    });
  }
  instanced(new THREE.BoxGeometry(1, 1, 1), mats.sign, signs, 'shop-signs');
  instanced(new THREE.BoxGeometry(1, 1, 1), mats.roof, awnings, 'shop-awnings');

  const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  for (const item of colliders) {
    quaternion.setFromAxisAngle(up, item.yaw);
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(item.sx / 2, item.sy / 2, item.sz / 2)
        .setTranslation(item.x, item.y, item.z)
        .setRotation({ x: quaternion.x, y: quaternion.y, z: quaternion.z, w: quaternion.w })
        .setFriction(0.7),
      body,
    );
  }
}

export function buildCity(
  scene: THREE.Scene,
  world: RAPIER.World,
  mats: EnvironmentMaterials,
): DynamicProp[] {
  const rand = mulberry32(95);
  const lots: BuildingLot[] = [];

  for (let gx = CITY.minX + 25; gx < CITY.maxX - 15; gx += 36) {
    for (let gz = CITY.minZ + 25; gz < CITY.maxZ - 15; gz += 36) {
      if (rand() < 0.28) continue;
      const x = gx + (rand() - 0.5) * 14;
      const z = gz + (rand() - 0.5) * 14;
      if (padEdgeDistance(x, z) < 20) continue;
      const w = 14 + rand() * 20;
      const d = 14 + rand() * 20;
      const road = nearestRoad(x, z);
      if (road.dist < Math.max(w, d) * 0.62 + 9) continue;
      const distToCentre = Math.hypot(x + 110, z + 55);
      const h = 8 + rand() * 18 + Math.max(0, 1 - distToCentre / 260) * 26;
      lots.push({
        x,
        z,
        w,
        d,
        h,
        y: heightAt(x, z),
        color: new THREE.Color().setHSL(
          0.07 + rand() * 0.06,
          0.12 + rand() * 0.12,
          0.62 + rand() * 0.18,
        ),
      });
      if (lots.length >= 90) break;
    }
    if (lots.length >= 90) break;
  }

  const groups: Record<'low' | 'mid' | 'tall', BuildingLot[]> = { low: [], mid: [], tall: [] };
  for (const lot of lots) {
    if (lot.h < 18) groups.low.push(lot);
    else if (lot.h < 34) groups.mid.push(lot);
    else groups.tall.push(lot);
  }

  const box = new THREE.BoxGeometry(1, 1, 1);
  const roofGeo = new THREE.BoxGeometry(1, 1, 1);
  const materials = {
    low: mats.buildingLow,
    mid: mats.buildingMid,
    tall: mats.buildingTall,
  };

  const matrix = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const position = new THREE.Vector3();

  for (const key of ['low', 'mid', 'tall'] as const) {
    const list = groups[key];
    if (list.length === 0) continue;
    const mesh = new THREE.InstancedMesh(box, materials[key], list.length);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = `buildings-${key}`;
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      position.set(b.x, b.y + b.h / 2 - 1.2, b.z);
      scale.set(b.w, b.h, b.d);
      quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0);
      matrix.compose(position, quat, scale);
      mesh.setMatrixAt(i, matrix);
      mesh.setColorAt(i, b.color);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    scene.add(mesh);
  }

  // Parapets hide the window texture on the roofs.
  const roof = new THREE.InstancedMesh(roofGeo, mats.roof, lots.length);
  for (let i = 0; i < lots.length; i++) {
    const b = lots[i];
    position.set(b.x, b.y + b.h - 1.0, b.z);
    scale.set(b.w * 1.02, 0.7, b.d * 1.02);
    quat.identity();
    matrix.compose(position, quat, scale);
    roof.setMatrixAt(i, matrix);
  }
  roof.castShadow = true;
  roof.receiveShadow = true;
  scene.add(roof);

  // Building collision boxes.
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  for (const b of lots) {
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(b.w / 2, b.h / 2, b.d / 2)
        .setTranslation(b.x, b.y + b.h / 2 - 1.2, b.z)
        .setFriction(0.7),
      body,
    );
  }

  // --- Trees ---------------------------------------------------------------
  const trunkGeo = new THREE.CylinderGeometry(0.22, 0.34, 3.2, 6);
  trunkGeo.translate(0, 1.6, 0);
  const canopyGeo = new THREE.IcosahedronGeometry(2.6, 0);
  canopyGeo.translate(0, 4.6, 0);
  const treeCount = 520;
  const trunks = new THREE.InstancedMesh(trunkGeo, mats.trunk, treeCount);
  const canopies = new THREE.InstancedMesh(canopyGeo, mats.foliage, treeCount);
  trunks.castShadow = true;
  canopies.castShadow = true;
  canopies.receiveShadow = true;

  let treeIdx = 0;
  let guard = 0;
  while (treeIdx < treeCount && guard < treeCount * 12) {
    guard++;
    const x = (rand() - 0.5) * 1720;
    const z = (rand() - 0.5) * 1720;
    if (x > CITY.minX - 30 && x < CITY.maxX + 30 && z > CITY.minZ - 30 && z < CITY.maxZ + 45) continue;
    if (padEdgeDistance(x, z) < 25) continue;
    const road = nearestRoad(x, z);
    if (roadClearance(x, z) < road.width * 0.5 + 14) continue;
    if (Math.hypot(x - SUMMIT.cx, z - SUMMIT.cz) < SUMMIT.radius + 12) continue;
    const y = heightAt(x, z);
    if (y > 104) continue;
    const s = 0.75 + rand() * 0.9;
    const rotation = rand() * Math.PI * 2;
    position.set(x, y - 0.2, z);
    scale.set(s, s * (0.85 + rand() * 0.5), s);
    quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotation);
    matrix.compose(position, quat, scale);
    trunks.setMatrixAt(treeIdx, matrix);
    canopies.setMatrixAt(treeIdx, matrix);
    canopies.setColorAt(
      treeIdx,
      new THREE.Color().setHSL(0.24 + rand() * 0.06, 0.3 + rand() * 0.2, 0.24 + rand() * 0.12),
    );
    treeIdx++;
  }
  trunks.count = treeIdx;
  canopies.count = treeIdx;
  trunks.instanceMatrix.needsUpdate = true;
  canopies.instanceMatrix.needsUpdate = true;
  if (canopies.instanceColor) canopies.instanceColor.needsUpdate = true;
  scene.add(trunks, canopies);

  // --- Knockable cones around the drift pad --------------------------------
  const props: DynamicProp[] = [];
  const coneGeo = new THREE.ConeGeometry(0.28, 0.75, 10);
  coneGeo.translate(0, 0.4, 0);
  const baseGeo = new THREE.BoxGeometry(0.62, 0.1, 0.62);
  baseGeo.translate(0, 0.05, 0);

  const conePositions: [number, number][] = [];
  for (let i = 0; i < 10; i++) {
    const t = i / 10;
    conePositions.push([
      DRIFT_PAD.cx - 56 + t * 112,
      DRIFT_PAD.cz + (i % 2 === 0 ? -22 : 22) + (rand() - 0.5) * 4,
    ]);
  }
  for (let i = 0; i < 12; i++) {
    const angle = (i / 12) * Math.PI * 2;
    conePositions.push([
      DRIFT_PAD.cx + Math.cos(angle) * 46,
      DRIFT_PAD.cz + Math.sin(angle) * 32,
    ]);
  }

  // Marking circle on the summit of the col.
  const summitCones: [number, number][] = [];
  for (let i = 0; i < 14; i++) {
    const angle = (i / 14) * Math.PI * 2;
    summitCones.push([
      SUMMIT.cx + Math.cos(angle) * 38,
      SUMMIT.cz + Math.sin(angle) * 38,
    ]);
  }

  for (const [x, z] of [...conePositions, ...summitCones]) {
    const isSummit = Math.hypot(x - SUMMIT.cx, z - SUMMIT.cz) < SUMMIT.radius + 1;
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(x, (isSummit ? SUMMIT.y : DRIFT_PAD.y) + 0.1, z)
        .setLinearDamping(0.4)
        .setAngularDamping(0.6),
    );
    world.createCollider(
      RAPIER.ColliderDesc.cone(0.38, 0.3).setTranslation(0, 0.38, 0).setMass(4).setFriction(0.6),
      body,
    );
    const group = new THREE.Group();
    const cone = new THREE.Mesh(coneGeo, mats.cone);
    cone.castShadow = true;
    const base = new THREE.Mesh(baseGeo, mats.cone);
    base.castShadow = true;
    group.add(cone, base);
    group.position.set(x, isSummit ? SUMMIT.y : DRIFT_PAD.y, z);
    scene.add(group);
    props.push({ body, mesh: group });
  }

  // --- Neighbourhoods along the dead ends ----------------------------------
  buildNeighbourhoods(scene, world, mats, rand);

  return props;
}

export function syncProps(props: DynamicProp[]): void {
  for (const prop of props) {
    const t = prop.body.translation();
    const r = prop.body.rotation();
    prop.mesh.position.set(t.x, t.y - 0.1, t.z);
    prop.mesh.quaternion.set(r.x, r.y, r.z, r.w);
  }
}
