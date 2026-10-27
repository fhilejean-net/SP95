import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  DIRT_TRACKS,
  DRIFT_PAD,
  MOUNTAIN_ROADS,
  RACE_START,
  RING,
  SAMPLED_ROADS,
  SUMMIT,
  TERRAIN_SEGMENTS,
  TERRAIN_SPAN,
  WORLD_SIZE,
  heightAt,
} from './layout.ts';
import type { EnvironmentMaterials } from '../render/materials.ts';
import { GROUP_GROUND } from '../physics/vehicle.ts';

/** Static ground: the tires cast into it, the chassis shell ignores it. */
const GROUND_GROUP = (GROUP_GROUND << 16) | 0xffff;

/**
 * The terrain is flattened to just under each road's own level, so this lift is
 * the whole gap between the physics surface and the visible asphalt. Keep it
 * small: the wheels sit on the terrain, not on the ribbon.
 */
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
  // La grille déborde du monde jouable : c'est sur cette bande que monte la
  // barrière du bord (layout.borderHeight), donc du sol partout où on peut
  // arriver — et pas de falaise au bord de la carte.
  const size = TERRAIN_SPAN;
  const step = size / segments;
  const count = segments + 1;
  const heights = new Float32Array(count * count);
  const positions = new Float32Array(count * count * 3);
  const uvs = new Float32Array(count * count * 2);
  const colors = new Float32Array(count * count * 3);
  const indices: number[] = [];
  const half = size / 2;

  // These are multipliers on the photo texture, not the colour of the ground:
  // the old olive values were dark enough to swallow every blade of grass in
  // the albedo, so the landscape read as flat plastic. Near-white tints keep
  // the photograph visible and only shift its hue (dry grass, bare rock).
  const color = new THREE.Color();
  const grass = new THREE.Color(0xd9e0bc);
  const dry = new THREE.Color(0xe2d2a6);
  const rock = new THREE.Color(0xa8a49c);

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
      color.copy(grass).lerp(dry, Math.min(1, t * 0.7 + s * 0.25));
      color.lerp(rock, s * 0.55);
      const noise = 0.96 + 0.08 * Math.sin(x * 0.37) * Math.cos(z * 0.31);
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
      .setRestitution(0.02)
      .setCollisionGroups(GROUND_GROUP),
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

  // `size` reste la taille du monde jouable : la grille, elle, déborde.
  return { heights, size: WORLD_SIZE, segments, sample };
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
    // Only a closed ribbon wraps around. Wrapping an open one took the tangent
    // of its last point from the first, which mirrored the right vector and
    // twisted the final quad into a bow-tie: a culled triangle, and a black
    // sliver of terrain showing through at every dead end.
    const prev = closed ? points[(i - 1 + n) % n] : points[Math.max(0, i - 1)];
    const next = closed ? points[(i + 1) % n] : points[Math.min(n - 1, i + 1)];
    const tangent = new THREE.Vector3().subVectors(next, prev);
    if (tangent.lengthSq() < 1e-9) tangent.set(0, 0, 1);
    tangent.normalize();
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

export interface RoadEnd {
  x: number;
  z: number;
  y: number;
  radius: number;
  /** Unit vector pointing out of the street, past the turning circle. */
  dx: number;
  dz: number;
}

/**
 * Ends of the open streets that finish in open ground. An end that lands on
 * another road is a junction and gets no turning circle.
 */
export function roadEnds(): RoadEnd[] {
  const ends: RoadEnd[] = [];
  for (const road of SAMPLED_ROADS) {
    if (road.def.closed || road.def.surface === 'dirt') continue;
    const first = road.points[0];
    const second = road.points[1];
    const last = road.points[road.points.length - 1];
    const beforeLast = road.points[road.points.length - 2];
    // `out` is measured from the street towards its end, so houses can line
    // the run-up to the turning circle.
    const candidates = [
      { p: first, out: { x: first.x - second.x, z: first.z - second.z } },
      { p: last, out: { x: last.x - beforeLast.x, z: last.z - beforeLast.z } },
    ];
    for (const { p, out } of candidates) {
      const length = Math.hypot(out.x, out.z) || 1;
      const dx = out.x / length;
      const dz = out.z / length;
      let junction = false;
      for (const other of SAMPLED_ROADS) {
        if (other === road) continue;
        const reach = (other.def.width + road.def.width) * 0.5 + 3;
        for (const s of other.samples) {
          if (Math.hypot(s.x - p.x, s.z - p.z) < reach) {
            junction = true;
            break;
          }
        }
        if (junction) break;
      }
      if (junction) continue;
      ends.push({ x: p.x, z: p.z, y: p.y, radius: road.def.width * 0.62 + 3, dx, dz });
    }
  }
  return ends;
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

    // Concrete shoulder / sidewalk, slightly lower and wider. It has to stay
    // above the flattened terrain, otherwise the two surfaces fight for pixels.
    if (road.def.kind !== 'rural') {
      const shoulder = new THREE.Mesh(
        ribbonGeometry(road.points, {
          width: width + 5,
          lift: ROAD_LIFT - 0.018,
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
          lift: ROAD_LIFT + 0.006,
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
        const y0 = p0.y + ROAD_LIFT + 0.007;
        const y1 = p1.y + ROAD_LIFT + 0.007;
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

  const driftArrows = new THREE.Mesh(new THREE.RingGeometry(44, 44.5, 96, 1, 0.4, 2.2), mats.lines);
  driftArrows.rotation.x = -Math.PI / 2;
  driftArrows.position.set(DRIFT_PAD.cx, DRIFT_PAD.y + 0.04, DRIFT_PAD.cz);
  scene.add(driftArrows);

  // Start / finish line on the ring.
  const startLine = new THREE.Mesh(new THREE.PlaneGeometry(RING.def.width - 0.6, 2.6), mats.checker);
  startLine.rotation.x = -Math.PI / 2;
  startLine.rotation.z = RACE_START.heading;
  startLine.position.set(RACE_START.x, heightAt(RACE_START.x, RACE_START.z) + ROAD_LIFT + 0.012, RACE_START.z);
  scene.add(startLine);

  // A street that simply stopped left its asphalt and shoulder hanging over the
  // bank, black underside and all. Each dead end now finishes on a turning
  // circle: the kerb of concrete first, the asphalt bulb on top of it.
  const ends = roadEnds();
  if (ends.length > 0) {
    const disc = new THREE.CircleGeometry(1, 30);
    disc.rotateX(-Math.PI / 2);
    const asphalt: THREE.BufferGeometry[] = [];
    const kerbs: THREE.BufferGeometry[] = [];
    for (const end of ends) {
      const kerb = disc.clone();
      kerb.scale(end.radius + 1.8, 1, end.radius + 1.8);
      kerb.translate(end.x, end.y + ROAD_LIFT - 0.018, end.z);
      kerbs.push(kerb);

      const bulb = disc.clone();
      bulb.scale(end.radius, 1, end.radius);
      bulb.translate(end.x, end.y + ROAD_LIFT, end.z);
      asphalt.push(bulb);
    }
    const kerbMesh = new THREE.Mesh(mergeGeometries(kerbs), mats.concrete);
    kerbMesh.receiveShadow = true;
    kerbMesh.name = 'road-ends-kerb';
    scene.add(kerbMesh);
    const bulbMesh = new THREE.Mesh(mergeGeometries(asphalt), mats.asphalt);
    bulbMesh.receiveShadow = true;
    bulbMesh.name = 'road-ends';
    scene.add(bulbMesh);
  }
}

/**
 * Both arenas are levelled in the terrain, but the terrain collider is a coarse
 * mesh: near their rims a triangle can dip a little below the concrete. A thin
 * slab over each arena gives the concrete its own collision, so a wheel never
 * drops through the surface the player can see.
 */
export function buildArenaPads(world: RAPIER.World): void {
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const HALF = 0.06;
  world.createCollider(
    RAPIER.ColliderDesc.cylinder(HALF, SUMMIT.radius)
      .setTranslation(SUMMIT.cx, SUMMIT.y + 0.04 - HALF, SUMMIT.cz)
      .setFriction(0.98)
      .setCollisionGroups(GROUND_GROUP),
    body,
  );
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(DRIFT_PAD.halfX, HALF, DRIFT_PAD.halfZ)
      .setTranslation(DRIFT_PAD.cx, DRIFT_PAD.y + 0.022 - HALF, DRIFT_PAD.cz)
      .setFriction(0.98)
      .setCollisionGroups(GROUND_GROUP),
    body,
  );
}

/**
 * Every engineered road (the col, the gravel stages) sits on a graded shelf, so
 * the ribbon is laid a few centimetres above it. Dirt roads get a gravel
 * surface and a pair of wheel ruts instead of paint.
 */
export function buildGradedRoads(scene: THREE.Scene, mats: EnvironmentMaterials): void {
  for (const road of [...MOUNTAIN_ROADS, ...DIRT_TRACKS]) {
    const dirt = road.def.surface === 'dirt';
    const lift = dirt ? 0.06 : 0.09;
    const surface = new THREE.Mesh(
      ribbonGeometry(road.points, { width: road.def.width, lift, closed: road.def.closed, uvLength: dirt ? 6 : 10 }),
      dirt ? mats.gravel : mats.asphalt,
    );
    surface.receiveShadow = true;
    surface.name = `road-${road.def.id}`;
    scene.add(surface);

    if (dirt) {
      for (const side of [-1, 1]) {
        const rut = new THREE.Mesh(
          ribbonGeometry(road.points, {
            width: 0.75,
            offset: side * 1.15,
            lift: lift + 0.004,
            closed: road.def.closed,
            uvLength: 2.5,
          }),
          mats.gravelRut,
        );
        rut.receiveShadow = true;
        scene.add(rut);
      }
      // Soft gravel berms on both edges, so the track reads as a cut path.
      for (const side of [-1, 1]) {
        const berm = new THREE.Mesh(
          ribbonGeometry(road.points, {
            width: 1.1,
            offset: side * (road.def.width * 0.5 + 0.1),
            lift: lift - 0.005,
            closed: road.def.closed,
            uvLength: 3,
          }),
          mats.gravelEdge,
        );
        berm.receiveShadow = true;
        scene.add(berm);
      }
      continue;
    }

    for (const side of [-1, 1]) {
      const line = new THREE.Mesh(
        ribbonGeometry(road.points, {
          width: 0.16,
          offset: side * (road.def.width * 0.5 - 0.45),
          lift: lift + 0.01,
          closed: false,
        }),
        mats.lines,
      );
      line.name = `edge-${road.def.id}`;
      scene.add(line);
    }
  }

  const pad = new THREE.Mesh(new THREE.CircleGeometry(SUMMIT.radius, 72), mats.asphaltPad);
  pad.rotation.x = -Math.PI / 2;
  pad.position.set(SUMMIT.cx, SUMMIT.y + 0.04, SUMMIT.cz);
  pad.receiveShadow = true;
  pad.name = 'summit-pad';
  scene.add(pad);

  for (const radius of [SUMMIT.radius - 2.5, 26]) {
    const ring = new THREE.Mesh(new THREE.RingGeometry(radius, radius + 0.55, 96), mats.lines);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(SUMMIT.cx, SUMMIT.y + 0.05, SUMMIT.cz);
    scene.add(ring);
  }
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
