import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  DIRT_TRACKS,
  DRIFT_PAD,
  FLAT_MAP,
  MOUNTAIN_MAP,
  MOUNTAIN_ROADS,
  RACE_START,
  RING,
  SAMPLED_ROADS,
  SUMMIT,
  TERRAIN_SEGMENTS,
  TERRAIN_SPAN,
  WORLD_SIZE,
  colLaybyWidth,
  heightAt,
} from './layout.ts';
import type { EnvironmentMaterials } from '../render/materials.ts';
import type { GuardrailPlacement } from '../render/guardrailModel.ts';
import { GROUP_GROUND, GROUP_WORLD } from '../physics/vehicle.ts';

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

  // These are multipliers on the photo texture, not the colour of the ground.
  // Ils étaient presque blancs : sous le plein soleil l'herbe lissait en
  // surexposition. On redescend d'un cran, la photo reste lisible.
  const color = new THREE.Color();
  const grass = new THREE.Color(0xa9b78f);
  const dry = new THREE.Color(0xbfa87e);
  const rock = new THREE.Color(0x8e8b84);

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
      // Circuit : l'herbe des dégagements est tondue en bandes de neuf mètres,
      // comme un vrai terrain. Deux teintes très proches suffisent à casser
      // l'aplat vert sans faire de damier.
      const mow = FLAT_MAP ? (Math.sin(x * 0.35) > 0 ? 1.035 : 0.955) : 1;
      colors[i * 3] = color.r * noise * mow;
      colors[i * 3 + 1] = color.g * noise * mow;
      colors[i * 3 + 2] = color.b * noise * mow;
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

  // Start / finish line on the ring. La carte du col n'a pas de ceinture :
  // il n'y a pas de ligne à poser.
  if (RING) {
    const startLine = new THREE.Mesh(new THREE.PlaneGeometry(RING.def.width - 0.6, 2.6), mats.checker);
    startLine.rotation.x = -Math.PI / 2;
    startLine.rotation.z = RACE_START.heading;
    startLine.position.set(
      RACE_START.x,
      heightAt(RACE_START.x, RACE_START.z) + ROAD_LIFT + 0.012,
      RACE_START.z,
    );
    scene.add(startLine);
  }

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
  // La carte du col n'a pas d'aire de drift : sa dalle n'existe pas, et son
  // collider flotterait au-dessus de la forêt.
  if (MOUNTAIN_MAP) return;
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
export function buildGradedRoads(scene: THREE.Scene, mats: EnvironmentMaterials, world?: RAPIER.World): void {
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

    if (MOUNTAIN_MAP && world && road.def.id === 'col') {
      // Une collision fidèle au ruban évite que la grille grossière du terrain
      // ne fasse sauter les roues ou ne les laisse traverser l'asphalte.
      const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
      const addGround = (geometry: THREE.BufferGeometry) => {
        const pos = geometry.getAttribute('position');
        const index = geometry.getIndex();
        if (!index) return;
        world.createCollider(
          RAPIER.ColliderDesc.trimesh(new Float32Array(pos.array), new Uint32Array(index.array))
            .setFriction(0.98).setCollisionGroups(GROUND_GROUP), body,
        );
      };
      addGround(surface.geometry);
      // Les évitements élargissent le bord droit et portent leur propre sol.
      const vertices: number[] = [];
      const indices: number[] = [];
      for (let i = 0; i < road.points.length; i++) {
        const p = road.points[i];
        const prev = road.points[Math.max(0, i - 1)];
        const next = road.points[Math.min(road.points.length - 1, i + 1)];
        const dx = next.x - prev.x, dz = next.z - prev.z;
        const length = Math.hypot(dx, dz) || 1;
        const nx = -dz / length, nz = dx / length;
        const inner = road.def.width * 0.5 - 0.03;
        const outer = inner + colLaybyWidth(road.samples[i].s, road.length);
        vertices.push(p.x + nx * inner, p.y + lift, p.z + nz * inner, p.x + nx * outer, p.y + lift, p.z + nz * outer);
        // Les triangles de largeur nulle font échouer le solveur Rapier.
        if (i > 0 && outer - inner > 0.01 && colLaybyWidth(road.samples[i - 1].s, road.length) > 0.01) {
          const a = (i - 1) * 2;
          indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        }
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
      geometry.setIndex(indices);
      geometry.computeVertexNormals();
      const laybys = new THREE.Mesh(geometry, mats.asphaltPad);
      laybys.name = 'col-laybys';
      laybys.receiveShadow = true;
      scene.add(laybys);
      addGround(geometry);
    }

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
    if (MOUNTAIN_MAP && road.def.id === 'col') {
      // Ligne centrale discontinue : les deux sens restent lisibles de nuit.
      const dashes: THREE.BufferGeometry[] = [];
      for (let i = 5; i + 1 < road.points.length; i += 4) {
        dashes.push(ribbonGeometry(road.points.slice(i, i + 2), { width: 0.13, lift: lift + 0.012 }));
      }
      if (dashes.length) {
        const center = new THREE.Mesh(mergeGeometries(dashes), mats.lines);
        center.name = 'col-centre-line';
        scene.add(center);
      }
    }
  }

  const pad = new THREE.Mesh(new THREE.CircleGeometry(SUMMIT.radius, 72), mats.asphaltPad);
  pad.rotation.x = -Math.PI / 2;
  pad.position.set(SUMMIT.cx, SUMMIT.y + 0.04, SUMMIT.cz);
  pad.receiveShadow = true;
  pad.name = 'summit-pad';
  scene.add(pad);

  // Le parking du col ne porte pas les cercles de l'arène de drift.
  if (MOUNTAIN_MAP) return;
  for (const radius of [SUMMIT.radius - 2.5, 26]) {
    const ring = new THREE.Mesh(new THREE.RingGeometry(radius, radius + 0.55, 96), mats.lines);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(SUMMIT.cx, SUMMIT.y + 0.05, SUMMIT.cz);
    scene.add(ring);
  }
}

/** Longueur d'un tronçon de glissière, en mètres. */
const GUARDRAIL_SEGMENT = 4.7;

export interface GuardrailRun {
  /** Un tronçon tous les `segment` mètres, le long de la corniche. */
  placements: GuardrailPlacement[];
  /** Ruban et poteaux procéduraux, masqués quand le GLB est posé. */
  fallback: THREE.Object3D[];
  segment: number;
}

/**
 * Glissières du col : deux rubans d'acier plantés au bord de la chaussée, un
 * poteau tous les six mètres. Le ruban a sa propre collision : sans elle, la
 * première épingle envoyait la voiture dans le vide, deux cents mètres plus
 * bas, et la montagne ne pardonnait rien.
 */
export function buildGuardrails(scene: THREE.Scene, world: RAPIER.World): GuardrailRun {
  const road = MOUNTAIN_ROADS[0];
  if (!road) return { placements: [], fallback: [], segment: GUARDRAIL_SEGMENT };
  const points = road.points;
  const lift = 0.09;
  const low = 0.45;
  const high = 0.95;
  const half = road.def.width * 0.5 + 0.3;
  const up = new THREE.Vector3(0, 1, 0);
  const tangent = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const posts: THREE.Matrix4[] = [];
  const postQuat = new THREE.Quaternion();
  const postPos = new THREE.Vector3();
  const one = new THREE.Vector3(1, 1, 1);

  // Dans le sens du départ, seul le bord droit surplombe le ravin ; le gauche
  // reste ouvert sur les rochers et la forêt. Le signe correspond à up × tangent.
  for (const side of [-1]) {
    const base = positions.length / 3;
    let run = 0;
    let lastX = 0;
    let lastZ = 0;
    for (let i = 0; i < points.length; i++) {
      const prev = points[Math.max(0, i - 1)];
      const next = points[Math.min(points.length - 1, i + 1)];
      tangent.subVectors(next, prev).setY(0).normalize();
      normal.crossVectors(up, tangent).normalize();
      const reach = half + colLaybyWidth(road.samples[i].s, road.length);
      const x = points[i].x + normal.x * reach * side;
      const z = points[i].z + normal.z * reach * side;
      const y = points[i].y + lift;
      if (i > 0) run += Math.hypot(x - lastX, z - lastZ);
      lastX = x;
      lastZ = z;
      positions.push(x, y + low, z, x, y + high, z);
      normals.push(normal.x, 0, normal.z, normal.x, 0, normal.z);
      uvs.push(run / 4, 0, run / 4, 1);
      // Le parking reste ouvert sur la route, sans rail au milieu du bitume.
      const outsideParking = Math.hypot(points[i].x - SUMMIT.cx, points[i].z - SUMMIT.cz) > SUMMIT.radius + 1;
      const prevOutside = Math.hypot(prev.x - SUMMIT.cx, prev.z - SUMMIT.cz) > SUMMIT.radius + 1;
      if (i > 0 && outsideParking && prevOutside) {
        const a = base + (i - 1) * 2;
        indices.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
      }
      // Un poteau tous les ~6 m : la mémoire d'un poteau, c'est le ruban qui
      // porte la collision, pas lui.
      if (outsideParking && i % 6 === 0) {
        postPos.set(x, y + 0.42, z);
        postQuat.setFromAxisAngle(up, Math.atan2(normal.x, normal.z));
        posts.push(new THREE.Matrix4().compose(postPos, postQuat, one));
      }
    }
  }

  // Le modèle de glissière fait 2 m : on le pose tous les 4,7 m, interpolés sur
  // le tracé, pour qu'il suive les épingles sans laisser de trou.
  const placements: GuardrailPlacement[] = [];
  let travelled = 0;
  let next = 0;
  for (let i = 1; i < points.length; i++) {
    const from = points[i - 1], to = points[i];
    const dx = to.x - from.x, dz = to.z - from.z;
    const step = Math.hypot(dx, dz);
    if (step < 1e-4) continue;
    while (next <= travelled + step) {
      const t = (next - travelled) / step;
      const x = from.x + dx * t, z = from.z + dz * t;
      const y = from.y + (to.y - from.y) * t + lift;
      // Le parking reste ouvert : pas de rail au milieu du bitume.
      if (Math.hypot(x - SUMMIT.cx, z - SUMMIT.cz) > SUMMIT.radius + 1) {
        const nx = -dz / step, nz = dx / step;
        const reach = half + colLaybyWidth(road.samples[i].s, road.length);
        placements.push({
          x: x + nx * reach * -1,
          y,
          z: z + nz * reach * -1,
          yaw: Math.atan2(-dz, dx),
        });
      }
      next += GUARDRAIL_SEGMENT;
    }
    travelled += step;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  const rail = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({
      color: 0xb6bac0,
      metalness: 0.6,
      roughness: 0.45,
      side: THREE.DoubleSide,
    }),
  );
  rail.castShadow = true;
  rail.receiveShadow = true;
  rail.name = 'guardrails';
  scene.add(rail);

  const postMesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.12, 1.05, 0.12),
    new THREE.MeshStandardMaterial({ color: 0x8e9298, metalness: 0.5, roughness: 0.6 }),
    Math.max(1, posts.length),
  );
  postMesh.count = posts.length;
  postMesh.castShadow = true;
  posts.forEach((matrix, i) => postMesh.setMatrixAt(i, matrix));
  postMesh.instanceMatrix.needsUpdate = true;
  postMesh.name = 'guardrail-posts';
  scene.add(postMesh);

  // Rochers irréguliers côté amont, au-delà de l'accotement praticable.
  const rockGeo = new THREE.DodecahedronGeometry(1, 0);
  const rockMat = new THREE.MeshStandardMaterial({ color: 0x77766e, roughness: 1 });
  const rocks = new THREE.InstancedMesh(rockGeo, rockMat, Math.ceil(points.length / 10));
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  let count = 0;
  for (let i = 10; i < points.length - 10; i += 10) {
    const prev = points[i - 1], next = points[i + 1];
    tangent.subVectors(next, prev).setY(0).normalize();
    normal.crossVectors(up, tangent).normalize();
    const offset = 12 + 3 * Math.sin(i * 0.17);
    const x = points[i].x + normal.x * offset;
    const z = points[i].z + normal.z * offset;
    position.set(x, heightAt(x, z) + 0.5, z);
    const size = 1.5 + 0.9 * (0.5 + 0.5 * Math.sin(i * 0.73));
    scale.set(size * 1.4, size, size);
    rotation.setFromAxisAngle(up, i * 0.3);
    rocks.setMatrixAt(count++, matrix.compose(position, rotation, scale));
  }
  rocks.count = count;
  rocks.instanceMatrix.needsUpdate = true;
  rocks.name = 'col-rocks';
  scene.add(rocks);

  const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  world.createCollider(
    RAPIER.ColliderDesc.trimesh(new Float32Array(positions), new Uint32Array(indices))
      .setFriction(0.3)
      .setRestitution(0.1)
      .setCollisionGroups((GROUP_WORLD << 16) | GROUP_WORLD),
    body,
  );
  return { placements, fallback: [rail, postMesh], segment: GUARDRAIL_SEGMENT };
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
