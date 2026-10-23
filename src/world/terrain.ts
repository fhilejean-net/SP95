import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import {
  DRIFT_PAD,
  RACE_START,
  RING,
  SAMPLED_ROADS,
  TERRAIN_SEGMENTS,
  WORLD_SIZE,
  heightAt,
} from './layout.ts';
import type { EnvironmentMaterials } from '../render/materials.ts';

const ROAD_LIFT = 0.03;
const UP = new THREE.Vector3(0, 1, 0);

export interface TerrainData {
  heights: Float32Array;
  size: number;
  segments: number;
  /** Bilinear sample of the generated height grid (matches the collider). */
  sample: (x: number, z: number) => number;
}

export function buildTerrain(scene: THREE.Scene, world: RAPIER.World, mats: EnvironmentMaterials): TerrainData {
  const segments = TERRAIN_SEGMENTS;
  const size = WORLD_SIZE;
  const step = size / segments;
  const count = segments + 1;
  const heights = new Float32Array(count * count);
  const positions = new Float32Array(count * count * 3);
  const uvs = new Float32Array(count * count * 2);
  const colors = new Float32Array(count * count * 3);
  const indices: number[] = [];
  const half = size / 2;

  const color = new THREE.Color();
  const grass = new THREE.Color(0x7f8c5c);
  const dry = new THREE.Color(0x918b60);
  const rock = new THREE.Color(0x807b73);

  for (let iz = 0; iz < count; iz++) {
    for (let ix = 0; ix < count; ix++) {
      const i = iz * count + ix;
      const x = -half + ix * step;
      const z = -half + iz * step;
      const y = heightAt(x, z);
      heights[i] = y;
      positions[i * 3] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;
      uvs[i * 2] = ix / segments;
      uvs[i * 2 + 1] = iz / segments;

      const slope = Math.abs(heightAt(x + step, z) - y) + Math.abs(heightAt(x, z + step) - y);
      const t = Math.min(1, Math.max(0, (y - 12) / 45));
      const s = Math.min(1, slope / 2.2);
      color.copy(grass).lerp(dry, Math.min(1, t * 0.9 + s * 0.4));
      color.lerp(rock, s * 0.75);
      const noise = 0.94 + 0.12 * Math.sin(x * 0.37) * Math.cos(z * 0.31);
      colors[i * 3] = color.r * noise;
      colors[i * 3 + 1] = color.g * noise;
      colors[i * 3 + 2] = color.b * noise;
    }
  }

  for (let iz = 0; iz < segments; iz++) {
    for (let ix = 0; ix < segments; ix++) {
      const a = iz * count + ix;
      const b = a + 1;
      const c = a + count;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  const mesh = new THREE.Mesh(geometry, mats.terrain);
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  mesh.name = 'terrain';
  scene.add(mesh);

  const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  world.createCollider(
    RAPIER.ColliderDesc.trimesh(new Float32Array(positions), new Uint32Array(indices))
      .setFriction(0.95)
      .setRestitution(0.02),
    body,
  );

  const sample = (x: number, z: number): number => {
    const fx = Math.min(segments - 0.001, Math.max(0, (x + half) / step));
    const fz = Math.min(segments - 0.001, Math.max(0, (z + half) / step));
    const ix = Math.floor(fx);
    const iz = Math.floor(fz);
    const tx = fx - ix;
    const tz = fz - iz;
    const h00 = heights[iz * count + ix];
    const h10 = heights[iz * count + ix + 1];
    const h01 = heights[(iz + 1) * count + ix];
    const h11 = heights[(iz + 1) * count + ix + 1];
    return (
      h00 * (1 - tx) * (1 - tz) + h10 * tx * (1 - tz) + h01 * (1 - tx) * tz + h11 * tx * tz
    );
  };

  return { heights, size, segments, sample };
}

interface RibbonOptions {
  width: number;
  offset?: number;
  lift: number;
  uvLength?: number;
  closed?: boolean;
}

function ribbonGeometry(
  points: THREE.Vector3[],
  options: RibbonOptions,
): THREE.BufferGeometry {
  const { width, offset = 0, lift } = options;
  const n = points.length;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const tangents: THREE.Vector3[] = [];
  const closed = options.closed ?? false;

  for (let i = 0; i < n; i++) {
    const prev = points[(i - 1 + n) % n];
    const next = points[(i + 1) % n];
    const tangent = new THREE.Vector3().subVectors(next, prev).normalize();
    tangents.push(tangent);
  }

  let distance = 0;
  for (let i = 0; i < n; i++) {
    const p = points[i];
    const tangent = tangents[i];
    const right = new THREE.Vector3().crossVectors(tangent, UP).normalize();
    const cx = p.x + right.x * offset;
    const cz = p.z + right.z * offset;
    const cy = p.y + lift;
    pos.push(cx - right.x * width * 0.5, cy, cz - right.z * width * 0.5);
    pos.push(cx + right.x * width * 0.5, cy, cz + right.z * width * 0.5);
    const v = distance / (options.uvLength ?? 10);
    uv.push(0, v, 1, v);
    if (i > 0) distance += p.distanceTo(points[i - 1]);
  }

  for (let i = 0; i < n - 1; i++) {
    const a = i * 2;
    const b = a + 1;
    const c = a + 2;
    const d = a + 3;
    idx.push(a, b, c, b, d, c);
  }
  if (closed) {
    const a = (n - 1) * 2;
    const b = a + 1;
    idx.push(a, b, 0, b, 1, 0);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geometry.setIndex(idx);
  geometry.computeVertexNormals();
  return geometry;
}

export function buildRoads(scene: THREE.Scene, mats: EnvironmentMaterials): void {
  const dashPositions: number[] = [];
  const dashIndices: number[] = [];
  const dashUvs: number[] = [];

  for (const road of SAMPLED_ROADS) {
    const width = road.def.width;
    const closed = road.def.closed;

    // Road surface.
    const surface = new THREE.Mesh(
      ribbonGeometry(road.points, { width, lift: ROAD_LIFT, closed }),
      mats.asphalt,
    );
    surface.receiveShadow = true;
    surface.name = `road-${road.def.id}`;
    scene.add(surface);

    // Concrete shoulder / sidewalk, slightly lower and wider.
    if (road.def.kind !== 'rural') {
      const shoulder = new THREE.Mesh(
        ribbonGeometry(road.points, {
          width: width + 5,
          lift: ROAD_LIFT - 0.035,
          closed,
          uvLength: 6,
        }),
        mats.concrete,
      );
      shoulder.receiveShadow = true;
      scene.add(shoulder);
    }

    // Solid edge lines.
    for (const side of [-1, 1]) {
      const line = new THREE.Mesh(
        ribbonGeometry(road.points, {
          width: 0.16,
          offset: side * (width * 0.5 - 0.5),
          lift: ROAD_LIFT + 0.008,
          closed,
        }),
        mats.lines,
      );
      line.name = `edge-${road.def.id}`;
      scene.add(line);
    }

    // Dashed centre line.
    const spacing = 14;
    const dashLength = 4.5;
    const points = road.points;
    const count = closed ? points.length : points.length - 1;
    for (let i = 0; i < count; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      const segLength = a.distanceTo(b);
      const steps = Math.max(1, Math.floor(segLength / spacing));
      for (let s = 0; s < steps; s++) {
        const t0 = (s * spacing) / segLength;
        const t1 = Math.min(1, (s * spacing + dashLength) / segLength);
        if (t1 <= t0) continue;
        const dir = new THREE.Vector3().subVectors(b, a).normalize();
        const right = new THREE.Vector3().crossVectors(dir, UP).normalize();
        const p0 = new THREE.Vector3().lerpVectors(a, b, t0);
        const p1 = new THREE.Vector3().lerpVectors(a, b, t1);
        const base = dashPositions.length / 3;
        const y0 = p0.y + ROAD_LIFT + 0.009;
        const y1 = p1.y + ROAD_LIFT + 0.009;
        const hw = 0.09;
        dashPositions.push(
          p0.x - right.x * hw, y0, p0.z - right.z * hw,
          p0.x + right.x * hw, y0, p0.z + right.z * hw,
          p1.x - right.x * hw, y1, p1.z - right.z * hw,
          p1.x + right.x * hw, y1, p1.z + right.z * hw,
        );
        dashUvs.push(0, 0, 1, 0, 0, 1, 1, 1);
        dashIndices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
      }
    }
  }

  if (dashPositions.length > 0) {
    const dashGeo = new THREE.BufferGeometry();
    dashGeo.setAttribute('position', new THREE.Float32BufferAttribute(dashPositions, 3));
    dashGeo.setAttribute('uv', new THREE.Float32BufferAttribute(dashUvs, 2));
    dashGeo.setIndex(dashIndices);
    dashGeo.computeVertexNormals();
    const dashMesh = new THREE.Mesh(dashGeo, mats.lines);
    dashMesh.name = 'centre-line';
    scene.add(dashMesh);
  }

  // Drift pad.
  const pad = new THREE.Mesh(new THREE.PlaneGeometry(DRIFT_PAD.halfX * 2, DRIFT_PAD.halfZ * 2), mats.asphaltPad);
  pad.rotation.x = -Math.PI / 2;
  pad.position.set(DRIFT_PAD.cx, DRIFT_PAD.y + 0.022, DRIFT_PAD.cz);
  pad.receiveShadow = true;
  scene.add(pad);

  const padRing = new THREE.Mesh(new THREE.RingGeometry(16, 16.6, 72), mats.lines);
  padRing.rotation.x = -Math.PI / 2;
  padRing.position.set(DRIFT_PAD.cx, DRIFT_PAD.y + 0.04, DRIFT_PAD.cz);
  scene.add(padRing);

  const padRingInner = new THREE.Mesh(new THREE.RingGeometry(30, 30.6, 96), mats.lines);
  padRingInner.rotation.x = -Math.PI / 2;
  padRingInner.position.set(DRIFT_PAD.cx, DRIFT_PAD.y + 0.04, DRIFT_PAD.cz);
  scene.add(padRingInner);

  // Start / finish line on the ring.
  const startLine = new THREE.Mesh(new THREE.PlaneGeometry(RING.def.width - 0.6, 2.6), mats.checker);
  startLine.rotation.x = -Math.PI / 2;
  startLine.rotation.z = RACE_START.heading;
  startLine.position.set(RACE_START.x, heightAt(RACE_START.x, RACE_START.z) + ROAD_LIFT + 0.012, RACE_START.z);
  scene.add(startLine);
}

export interface RaceGate {
  position: THREE.Vector3;
  heading: number;
  mesh: THREE.Group;
}

export function buildRaceGates(scene: THREE.Scene, mats: EnvironmentMaterials, checkpoints: THREE.Vector3[]): RaceGate[] {
  const gates: RaceGate[] = [];
  const postGeo = new THREE.BoxGeometry(0.22, 4.2, 0.22);
  const beamGeo = new THREE.BoxGeometry(1, 0.2, 0.2);

  for (let i = 0; i < checkpoints.length; i++) {
    const cp = checkpoints[i];
    const next = checkpoints[(i + 1) % checkpoints.length];
    const heading = Math.atan2(-(next.x - cp.x), -(next.z - cp.z));
    const group = new THREE.Group();
    const halfWidth = 6.4;
    const start = i === 0;
    const postMat = start ? mats.checker : mats.gate;

    for (const side of [-1, 1]) {
      const post = new THREE.Mesh(postGeo, postMat);
      post.position.set(side * halfWidth, 2.1, 0);
      post.castShadow = true;
      group.add(post);
    }
    const beam = new THREE.Mesh(beamGeo, mats.gate);
    beam.scale.x = halfWidth * 2;
    beam.position.y = 4.1;
    beam.castShadow = true;
    group.add(beam);

    const banner = new THREE.Mesh(
      new THREE.PlaneGeometry(halfWidth * 2, 0.9),
      new THREE.MeshStandardMaterial({
        color: start ? 0xf25c1f : 0x24323d,
        roughness: 0.7,
        side: THREE.DoubleSide,
      }),
    );
    banner.position.y = 3.55;
    group.add(banner);

    group.position.set(cp.x, heightAt(cp.x, cp.z) + 0.02, cp.z);
    group.rotation.y = heading;
    scene.add(group);
    gates.push({ position: cp.clone(), heading, mesh: group });
  }
  return gates;
}
