import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { CITY, DRIFT_PAD, SUMMIT, heightAt, nearestRoad, padEdgeDistance, roadClearance } from './layout.ts';
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
