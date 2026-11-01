import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { COL_START, COL_VILLAGE, MOUNTAIN_ROADS, SUMMIT } from './layout.ts';
import { GROUP_WORLD } from '../physics/vehicle.ts';
import type { EnvironmentMaterials } from '../render/materials.ts';

/**
 * Les deux extrémités du col : le parking du sommet et le village du bas.
 * Le terrain et la dalle sont construits dans terrain.ts ; ici on pose le
 * mobilier qui donne au joueur un début et une fin lisibles.
 */

export interface ColSettlementSummary {
  /** Nombre de places tracées au parking. */
  parkingBays: number;
  /** Nombre de chalets du village. */
  houses: number;
  /** Colliders fixes ajoutés (maisons, fontaine, panneaux). */
  colliders: number;
  /** Lampadaires allumés. */
  lamps: number;
}

const UP = new THREE.Vector3(0, 1, 0);
const ONE = new THREE.Vector3(1, 1, 1);
const WORLD_GROUP = (GROUP_WORLD << 16) | GROUP_WORLD;

function padY(centerY: number): number {
  return centerY + 0.058;
}

function yawQuaternion(yaw: number): THREE.Quaternion {
  return new THREE.Quaternion().setFromAxisAngle(UP, yaw);
}

function box(
  width: number,
  height: number,
  depth: number,
  x: number,
  y: number,
  z: number,
  yaw = 0,
): THREE.BufferGeometry {
  const geometry = new THREE.BoxGeometry(width, height, depth);
  geometry.applyMatrix4(
    new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), yawQuaternion(yaw), ONE),
  );
  return geometry;
}

/** Toit à deux pans, faîtage le long de X, avant de la maison vers +Z. */
function gableRoof(width: number, depth: number, rise: number): THREE.BufferGeometry {
  const hw = width / 2;
  const hd = depth / 2;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(
      [
        -hw, 0, -hd,
        hw, 0, -hd,
        -hw, 0, hd,
        hw, 0, hd,
        -hw, rise, 0,
        hw, rise, 0,
      ],
      3,
    ),
  );
  geometry.setIndex([
    0, 1, 5, 0, 5, 4,
    2, 4, 5, 2, 5, 3,
    0, 4, 2,
    1, 3, 5,
    0, 2, 3, 0, 3, 1,
  ]);
  geometry.setAttribute(
    'uv',
    new THREE.Float32BufferAttribute(
      [0, 0, 1, 0, 0, 1, 1, 1, 0, 0.5, 1, 0.5],
      2,
    ),
  );
  geometry.computeVertexNormals();
  return geometry;
}

interface HouseArrays {
  stone: THREE.BufferGeometry[];
  walls: THREE.BufferGeometry[];
  roofs: THREE.BufferGeometry[];
  windows: THREE.BufferGeometry[];
  doors: THREE.BufferGeometry[];
  wood: THREE.BufferGeometry[];
}

function emptyHouseArrays(): HouseArrays {
  return { stone: [], walls: [], roofs: [], windows: [], doors: [], wood: [] };
}

/**
 * Un chalet : base de pierre, murs à façade claire, toit à deux pans, fenêtres
 * chaudes et balcon de bois. Les géométries sont accumulées par matériau pour
 * que le village tienne en quelques appels de dessin.
 */
function addChalet(
  arrays: HouseArrays,
  pending: RAPIER.ColliderDesc[],
  x: number,
  y: number,
  z: number,
  yaw: number,
  scale: number,
): void {
  const width = 7.2 * scale;
  const depth = 5.6 * scale;
  const wall = 3.2 * scale;
  const base = 0.55 * scale;

  arrays.stone.push(box(width + 0.35, base, depth + 0.35, x, y + base / 2, z, yaw));
  arrays.walls.push(box(width, wall, depth, x, y + base + wall / 2, z, yaw));
  const roof = gableRoof(width + 0.9, depth + 0.9, 2.0 * scale);
  roof.applyMatrix4(
    new THREE.Matrix4().compose(
      new THREE.Vector3(x, y + base + wall, z),
      yawQuaternion(yaw),
      ONE,
    ),
  );
  arrays.roofs.push(roof);

  const local = (lx: number, ly: number, lz: number): THREE.Vector3 =>
    new THREE.Vector3(lx, ly, lz).applyAxisAngle(UP, yaw).add(new THREE.Vector3(x, y, z));
  const windowY = base + wall * 0.62;
  for (const wx of [-width * 0.28, width * 0.28]) {
    const p = local(wx, windowY, depth / 2 + 0.045);
    arrays.windows.push(box(1.05 * scale, 1.15 * scale, 0.09, p.x, p.y, p.z, yaw));
  }
  for (const s of [-1, 1]) {
    for (const wz of [-depth * 0.22, depth * 0.22]) {
      const p = local(s * (width / 2 + 0.045), windowY, wz);
      arrays.windows.push(box(0.09, 1.05 * scale, 1.0 * scale, p.x, p.y, p.z, yaw));
    }
  }
  for (const wx of [-width * 0.28, width * 0.28]) {
    const p = local(wx, windowY, -depth / 2 - 0.045);
    arrays.windows.push(box(1.0 * scale, 1.05 * scale, 0.09, p.x, p.y, p.z, yaw));
  }

  const door = local(0, base + 1.0 * scale, depth / 2 + 0.05);
  arrays.doors.push(box(1.05 * scale, 2.0 * scale, 0.12, door.x, door.y, door.z, yaw));
  const balcony = local(0, base + wall * 0.72, depth / 2 + 0.62);
  arrays.wood.push(box(width * 0.9, 0.14, 1.05, balcony.x, balcony.y, balcony.z, yaw));
  const rail = local(0, base + wall * 0.72 + 0.55, depth / 2 + 1.08);
  arrays.wood.push(box(width * 0.9, 0.1, 0.1, rail.x, rail.y, rail.z, yaw));
  const chimney = local(width * 0.28, base + wall + 1.0, -depth * 0.2);
  arrays.stone.push(box(0.62, 1.5, 0.62, chimney.x, chimney.y, chimney.z, yaw));

  const halfHeight = (base + wall) / 2;
  pending.push(
    RAPIER.ColliderDesc.cuboid(width / 2 + 0.15, halfHeight, depth / 2 + 0.15)
      .setTranslation(x, y + halfHeight, z)
      .setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) })
      .setFriction(0.7)
      .setCollisionGroups(WORLD_GROUP),
  );
}

function addLamp(
  group: THREE.Group,
  lights: THREE.PointLight[],
  x: number,
  y: number,
  z: number,
  glow: THREE.Material,
  post: THREE.Material,
): void {
  const height = 4.3;
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.12, height, 8), post);
  pole.position.set(x, y + height / 2, z);
  pole.castShadow = true;
  group.add(pole);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.16, 0.32), post);
  head.position.set(x, y + height, z);
  group.add(head);
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.17, 10, 8), glow);
  bulb.position.set(x, y + height - 0.12, z);
  group.add(bulb);
  const light = new THREE.PointLight(0xffd9a0, 52, 30, 1.7);
  light.position.set(x, y + height - 0.15, z);
  light.castShadow = false;
  group.add(light);
  lights.push(light);
}

function signTexture(
  text: string,
  sub: string | null,
  background: string,
  foreground: string,
): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = foreground;
  ctx.lineWidth = 5;
  ctx.strokeRect(8, 8, canvas.width - 16, canvas.height - 16);
  ctx.fillStyle = foreground;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = 'bold 58px Arial, sans-serif';
  ctx.fillText(text, canvas.width / 2, sub ? 52 : 66);
  if (sub) {
    ctx.font = 'bold 24px Arial, sans-serif';
    ctx.fillText(sub, canvas.width / 2, 98);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function addSign(
  group: THREE.Group,
  pending: RAPIER.ColliderDesc[],
  wood: THREE.Material,
  text: string,
  sub: string | null,
  x: number,
  y: number,
  z: number,
  yaw: number,
  width: number,
  height: number,
  background: string,
  solid: boolean,
): void {
  const holder = new THREE.Group();
  holder.position.set(x, y, z);
  holder.rotation.y = yaw;
  const back = new THREE.Mesh(new THREE.BoxGeometry(width + 0.18, height + 0.18, 0.12), wood);
  back.position.y = 2.35;
  back.castShadow = true;
  holder.add(back);
  const texture = signTexture(text, sub, background, '#f6f3e9');
  const face = new THREE.Mesh(
    new THREE.PlaneGeometry(width, height),
    texture
      ? new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide })
      : new THREE.MeshBasicMaterial({ color: background, side: THREE.DoubleSide }),
  );
  face.position.set(0, 2.35, 0.07);
  holder.add(face);
  for (const side of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, 2.3, 0.12), wood);
    post.position.set(side * width * 0.38, 1.15, 0);
    post.castShadow = true;
    holder.add(post);
  }
  group.add(holder);
  if (solid) {
    pending.push(
      RAPIER.ColliderDesc.cuboid(width / 2 + 0.12, 1.15, 0.12)
        .setTranslation(x, y + 1.15, z)
        .setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) })
        .setFriction(0.6)
        .setCollisionGroups(WORLD_GROUP),
    );
  }
}

function angularDistance(a: number, b: number): number {
  let delta = Math.abs(a - b) % (Math.PI * 2);
  if (delta > Math.PI) delta = Math.PI * 2 - delta;
  return delta;
}

function flushMeshes(
  group: THREE.Group,
  arrays: HouseArrays,
  mats: EnvironmentMaterials,
  windowMaterial: THREE.Material,
  woodMaterial: THREE.Material,
): void {
  const entries: [THREE.BufferGeometry[], THREE.Material, string][] = [
    [arrays.stone, mats.concrete, 'settlement-stone'],
    [arrays.walls, mats.house, 'settlement-walls'],
    [arrays.roofs, mats.roofTile, 'settlement-roofs'],
    [arrays.windows, windowMaterial, 'settlement-windows'],
    [arrays.doors, woodMaterial, 'settlement-doors'],
    [arrays.wood, woodMaterial, 'settlement-wood'],
  ];
  for (const [geometries, material, name] of entries) {
    if (geometries.length === 0) continue;
    const merged = mergeGeometries(geometries);
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, material);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
}

/** Le parking du sommet : places, ligne de départ, auberge, panneaux, lampes. */
function buildParking(
  scene: THREE.Scene,
  mats: EnvironmentMaterials,
  windowMaterial: THREE.Material,
  woodMaterial: THREE.Material,
  glowMaterial: THREE.Material,
  lights: THREE.PointLight[],
  pending: RAPIER.ColliderDesc[],
): number {
  const group = new THREE.Group();
  group.name = 'col-parking';
  scene.add(group);

  const road = MOUNTAIN_ROADS[0];
  let exitAngle = Math.atan2(road.points[1].z - SUMMIT.cz, road.points[1].x - SUMMIT.cx);
  for (const p of road.points) {
    const radius = Math.hypot(p.x - SUMMIT.cx, p.z - SUMMIT.cz);
    if (radius > 10 && radius < 28) {
      exitAngle = Math.atan2(p.z - SUMMIT.cz, p.x - SUMMIT.cx);
      break;
    }
  }
  const chaletAngle = exitAngle + Math.PI;

  // 18 séparateurs radiaux ; on retire le passage de la route et l'emprise de
  // l'auberge. Les traits sont posés sur la dalle, pas dans le terrain.
  const bays: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 18; i++) {
    const angle = (i / 18) * Math.PI * 2;
    if (angularDistance(angle, exitAngle) < 0.32) continue;
    if (angularDistance(angle, chaletAngle) < 0.4) continue;
    const x = SUMMIT.cx + Math.cos(angle) * 15.6;
    const z = SUMMIT.cz + Math.sin(angle) * 15.6;
    bays.push(box(5.8, 0.012, 0.11, x, padY(SUMMIT.y), z, -angle));
  }
  if (bays.length > 0) {
    const merged = mergeGeometries(bays);
    if (merged) {
      const lines = new THREE.Mesh(merged, mats.lines);
      lines.name = 'col-parking-bays';
      group.add(lines);
    }
  }

  // Ligne de départ, perpendiculaire au cap de la voiture.
  const start = new THREE.Mesh(new THREE.BoxGeometry(6.2, 0.012, 0.38), mats.lines);
  // La voiture démarre sur la dalle plate du parking, pas sur le ruban qui
  // descend déjà : la ligne se pose à la cote de la dalle.
  start.position.set(COL_START.x, padY(SUMMIT.y), COL_START.z);
  start.rotation.y = COL_START.heading;
  start.name = 'col-start-line';
  group.add(start);

  const arrays = emptyHouseArrays();
  const chaletX = SUMMIT.cx + Math.cos(chaletAngle) * 15.4;
  const chaletZ = SUMMIT.cz + Math.sin(chaletAngle) * 15.4;
  const chaletYaw = Math.atan2(SUMMIT.cx - chaletX, SUMMIT.cz - chaletZ);
  addChalet(arrays, pending, chaletX, SUMMIT.y + 0.04, chaletZ, chaletYaw, 0.82);
  flushMeshes(group, arrays, mats, windowMaterial, woodMaterial);

  // Panneau « P » à l'entrée et panneau du col près de l'auberge.
  addSign(
    group,
    pending,
    woodMaterial,
    'P',
    null,
    SUMMIT.cx + Math.cos(exitAngle + 0.42) * 20.2,
    SUMMIT.y + 0.04,
    SUMMIT.cz + Math.sin(exitAngle + 0.42) * 20.2,
    Math.PI / 2 - (exitAngle + 0.42),
    1.15,
    1.25,
    '#1d4f91',
    false,
  );
  addSign(
    group,
    pending,
    woodMaterial,
    'COL DE MOLLENDRUZ',
    'PARKING · DÉPART',
    SUMMIT.cx + Math.cos(chaletAngle + 0.5) * 19.4,
    SUMMIT.y + 0.04,
    SUMMIT.cz + Math.sin(chaletAngle + 0.5) * 19.4,
    Math.PI / 2 - (chaletAngle + 0.5),
    4.2,
    0.9,
    '#1d3b2c',
    false,
  );

  for (const offset of [0.9, -0.9]) {
    addLamp(
      group,
      lights,
      SUMMIT.cx + Math.cos(chaletAngle + offset) * 19,
      SUMMIT.y + 0.04,
      SUMMIT.cz + Math.sin(chaletAngle + offset) * 19,
      glowMaterial,
      woodMaterial,
    );
  }

  return Math.max(0, bays.length - 1);
}

/**
 * Construit les deux extrémités du col. Retourne les compteurs du smoke test.
 * Le corps fixe des colliders est créé ici et partagé par les deux lieux.
 */
export function buildColSettlements(
  scene: THREE.Scene,
  world: RAPIER.World,
  mats: EnvironmentMaterials,
): ColSettlementSummary {
  const pending: RAPIER.ColliderDesc[] = [];
  const lights: THREE.PointLight[] = [];
  const windowMaterial = new THREE.MeshStandardMaterial({
    color: 0x3a2412,
    emissive: 0xffb45f,
    emissiveIntensity: 1.35,
    roughness: 0.45,
    metalness: 0,
  });
  const woodMaterial = new THREE.MeshStandardMaterial({
    color: 0x4a2f1d,
    roughness: 0.86,
    metalness: 0,
  });
  const glowMaterial = new THREE.MeshBasicMaterial({ color: 0xffe2b0 });

  const parkingBays = buildParking(
    scene,
    mats,
    windowMaterial,
    woodMaterial,
    glowMaterial,
    lights,
    pending,
  );

  // --- Village du bas ------------------------------------------------------
  const group = new THREE.Group();
  group.name = 'col-village';
  scene.add(group);
  const centerY = COL_VILLAGE.y + 0.04;
  const road = MOUNTAIN_ROADS[0];
  const last = road.points[road.points.length - 1];
  const previous = road.points[Math.max(0, road.points.length - 12)];
  const entryAngle = Math.atan2(previous.z - last.z, previous.x - last.x);
  const arrays = emptyHouseArrays();
  const houses = 11;
  for (let i = 0; i < houses; i++) {
    const angle = entryAngle + 0.52 + (i / (houses - 1)) * (Math.PI * 2 - 1.04);
    const x = COL_VILLAGE.cx + Math.cos(angle) * 25.2;
    const z = COL_VILLAGE.cz + Math.sin(angle) * 25.2;
    const yaw = Math.atan2(-Math.cos(angle), -Math.sin(angle));
    const scale = 0.9 + ((i * 7) % 5) * 0.035;
    addChalet(arrays, pending, x, centerY, z, yaw, scale);
  }
  flushMeshes(group, arrays, mats, windowMaterial, woodMaterial);

  // Fontaine de la place.
  const fountainStone = new THREE.Mesh(
    new THREE.CylinderGeometry(3.0, 3.25, 0.85, 24),
    mats.concrete,
  );
  fountainStone.position.set(COL_VILLAGE.cx, centerY + 0.425, COL_VILLAGE.cz);
  fountainStone.castShadow = true;
  fountainStone.receiveShadow = true;
  group.add(fountainStone);
  const water = new THREE.Mesh(
    new THREE.CylinderGeometry(2.55, 2.55, 0.06, 24),
    new THREE.MeshStandardMaterial({ color: 0x2a4657, roughness: 0.16, metalness: 0.35 }),
  );
  water.position.set(COL_VILLAGE.cx, centerY + 0.86, COL_VILLAGE.cz);
  group.add(water);
  const column = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.55, 2.2, 12), mats.concrete);
  column.position.set(COL_VILLAGE.cx, centerY + 1.75, COL_VILLAGE.cz);
  column.castShadow = true;
  group.add(column);
  const bowl = new THREE.Mesh(new THREE.SphereGeometry(0.62, 14, 10), mats.concrete);
  bowl.position.set(COL_VILLAGE.cx, centerY + 2.9, COL_VILLAGE.cz);
  bowl.castShadow = true;
  group.add(bowl);
  pending.push(
    RAPIER.ColliderDesc.cylinder(0.45, 3.3)
      .setTranslation(COL_VILLAGE.cx, centerY + 0.45, COL_VILLAGE.cz)
      .setFriction(0.9)
      .setCollisionGroups(WORLD_GROUP),
  );

  // Anneau de pierre au pied de la fontaine : la place se lit comme une place.
  const ring = new THREE.Mesh(new THREE.RingGeometry(COL_VILLAGE.radius - 0.8, COL_VILLAGE.radius, 64), mats.concrete);
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(COL_VILLAGE.cx, centerY + 0.052, COL_VILLAGE.cz);
  ring.receiveShadow = true;
  group.add(ring);

  addSign(
    group,
    pending,
    woodMaterial,
    'MOLLENDRUZ',
    'VILLAGE · 1 020 m',
    COL_VILLAGE.cx + Math.cos(entryAngle) * 28.4 + Math.cos(entryAngle + Math.PI / 2) * 5.5,
    COL_VILLAGE.y + 0.04,
    COL_VILLAGE.cz + Math.sin(entryAngle) * 28.4 + Math.sin(entryAngle + Math.PI / 2) * 5.5,
    Math.PI / 2 - entryAngle,
    4.6,
    0.95,
    '#4a2f1d',
    true,
  );

  for (const offset of [1.15, 2.6, 4.05]) {
    addLamp(
      group,
      lights,
      COL_VILLAGE.cx + Math.cos(entryAngle + offset) * 20.5,
      centerY,
      COL_VILLAGE.cz + Math.sin(entryAngle + offset) * 20.5,
      glowMaterial,
      woodMaterial,
    );
  }

  const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  for (const desc of pending) world.createCollider(desc, body);
  const colliders = pending.length;

  scene.userData.colSettlements = { parkingBays, houses, colliders, lamps: lights.length };
  return { parkingBays, houses, colliders, lamps: lights.length };
}
