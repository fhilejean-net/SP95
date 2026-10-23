import * as THREE from 'three';

export const WORLD_SIZE = 2000;
export const TERRAIN_SEGMENTS = 220;

export interface RoadDef {
  id: string;
  name: string;
  /** X/Z control points, world meters. */
  points: [number, number][];
  closed: boolean;
  width: number;
  kind: 'city' | 'rural' | 'avenue';
}

export const ROADS: RoadDef[] = [
  {
    id: 'ring',
    name: 'Route de ceinture',
    points: [
      [-403, -29],
      [-374, 144],
      [-288, 274],
      [-130, 338],
      [58, 338],
      [238, 288],
      [367, 173],
      [403, 29],
      [374, -130],
      [274, -252],
      [115, -324],
      [-58, -338],
      [-238, -302],
      [-360, -187],
    ],
    closed: true,
    width: 13,
    kind: 'rural',
  },
  // City grid, three north-south and three east-west streets.
  { id: 'city-ns-1', name: 'Rue de la Gare', points: [[-260, -200], [-260, 90]], closed: false, width: 10, kind: 'city' },
  { id: 'city-ns-2', name: 'Rue Centrale', points: [[-160, -200], [-160, 90]], closed: false, width: 10, kind: 'city' },
  { id: 'city-ns-3', name: 'Rue des Ateliers', points: [[-60, -200], [-60, 90]], closed: false, width: 10, kind: 'city' },
  { id: 'city-ns-4', name: 'Boulevard Est', points: [[40, -200], [40, 90]], closed: false, width: 11, kind: 'city' },
  { id: 'city-ew-1', name: 'Rue du Port', points: [[-300, -160], [70, -160]], closed: false, width: 10, kind: 'city' },
  { id: 'city-ew-2', name: 'Avenue de la République', points: [[-300, -60], [70, -60]], closed: false, width: 12, kind: 'city' },
  { id: 'city-ew-3', name: 'Rue des Tilleuls', points: [[-300, 40], [70, 40]], closed: false, width: 10, kind: 'city' },
  {
    id: 'avenue',
    name: 'Route du Lac',
    points: [
      [40, 40],
      [110, 130],
      [138, 240],
      [90, 310],
      [58, 338],
    ],
    closed: false,
    width: 12,
    kind: 'avenue',
  },
  {
    id: 'pad-access',
    name: "Impasse de l'Usine",
    points: [
      [40, -60],
      [88, -20],
      [100, 70],
      [100, 120],
    ],
    closed: false,
    width: 10,
    kind: 'city',
  },
  {
    id: 'quay',
    name: 'Quai Sud',
    points: [
      [100, 200],
      [180, 220],
      [280, 252],
      [367, 173],
    ],
    closed: false,
    width: 11,
    kind: 'avenue',
  },
];

/**
 * The col: a massif in the south-west corner, climbed by a spiral road that
 * ends on a flat summit where the drift sessions happen.
 */
export const MASSIF = { cx: -480, cz: -420, radius: 240, height: 70 };

/** Height added by the massif alone, before any terrain mixing. */
export function massifHeight(x: number, z: number): number {
  const r = Math.hypot(x - MASSIF.cx, z - MASSIF.cz) / MASSIF.radius;
  if (r >= 1) return 0;
  const t = 1 - r;
  return MASSIF.height * t * t * (3 - 2 * t);
}

export const DRIFT_PAD = {
  cx: 176,
  cz: 132,
  halfX: 76,
  halfZ: 52,
  y: 0,
};

export const CITY = {
  minX: -310,
  maxX: 80,
  minZ: -205,
  maxZ: 90,
};

export const SPAWN = { x: -60, z: 62, heading: 0 };

/** Race start sits on the widest, straightest part of the ring. */
export const RACE_START_INDEX_FRACTION = 0.02;

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Smooth road-level ground height, no hills, no flattening. */
export function baseHeight(x: number, z: number): number {
  return (
    4.2 * Math.sin(x * 0.0021) +
    3.4 * Math.cos(z * 0.0024) +
    1.8 * Math.sin((x + z) * 0.0043) +
    0.9 * Math.sin(x * 0.0081 + 1.7) * Math.cos(z * 0.0073)
  );
}

function rollingHills(x: number, z: number): number {
  return (
    13 * Math.sin(x * 0.0113 + 2.1) * Math.cos(z * 0.0092) +
    6.5 * Math.sin(x * 0.0231 + 0.4) * Math.cos(z * 0.0187 + 1.3) +
    2.5 * Math.sin(x * 0.051 + z * 0.043)
  );
}

// Spiral up the massif: the radius drops as the road turns, so every metre
// forward buys a few centimetres of altitude.
const COL_POINTS: [number, number][] = (() => {
  const points: [number, number][] = [
    [-238, -302],
    [-252, -310],
    [-266, -316],
  ];
  const turns = 1.35;
  const startX = -273;
  const startZ = -319;
  const startAngle = Math.atan2(startZ - MASSIF.cz, startX - MASSIF.cx);
  const startRadius = Math.hypot(startX - MASSIF.cx, startZ - MASSIF.cz);
  const endRadius = 26;
  const steps = Math.round(turns * 24);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const angle = startAngle - t * turns * Math.PI * 2;
    const radius = startRadius + (endRadius - startRadius) * t;
    points.push([
      MASSIF.cx + Math.cos(angle) * radius,
      MASSIF.cz + Math.sin(angle) * radius,
    ]);
  }
  return points;
})();

export const COL_ROAD: RoadDef = {
  id: 'col',
  name: 'Route du Col',
  points: COL_POINTS,
  closed: false,
  width: 11,
  kind: 'rural',
};

function edgeRidge(x: number, z: number): number {
  const r = Math.max(Math.abs(x), Math.abs(z));
  const t = smoothstep(640, 980, r);
  if (t <= 0) return 0;
  return t * (34 + 22 * Math.sin(x * 0.006) * Math.cos(z * 0.007));
}

export interface RoadSample {
  x: number;
  z: number;
  y: number;
  width: number;
  roadId: string;
  s: number;
}

export interface SampledRoad {
  def: RoadDef;
  points: THREE.Vector3[];
  samples: RoadSample[];
  length: number;
}

function curveFor(def: RoadDef): THREE.CatmullRomCurve3 {
  const pts = def.points.map(([x, z]) => new THREE.Vector3(x, 0, z));
  return new THREE.CatmullRomCurve3(pts, def.closed, 'catmullrom', 0.35);
}

function sampleRoad(def: RoadDef, spacing = 4): SampledRoad {
  const curve = curveFor(def);
  const approxLength = curve.getLength();
  const count = Math.max(8, Math.ceil(approxLength / spacing));
  const points: THREE.Vector3[] = [];
  const samples: RoadSample[] = [];
  for (let i = 0; i < count; i++) {
    const t = i / count;
    const p = curve.getPointAt(t);
    const y = baseHeight(p.x, p.z);
    points.push(new THREE.Vector3(p.x, y, p.z));
    samples.push({
      x: p.x,
      z: p.z,
      y,
      width: def.width,
      roadId: def.id,
      s: t * approxLength,
    });
  }
  return { def, points, samples, length: approxLength };
}

export const SAMPLED_ROADS: SampledRoad[] = ROADS.map((r) => sampleRoad(r));

// --- Nearest-road acceleration structure -----------------------------------

const CELL = 24;
const roadGrid = new Map<string, RoadSample[]>();

for (const road of SAMPLED_ROADS) {
  for (const s of road.samples) {
    const key = `${Math.floor(s.x / CELL)},${Math.floor(s.z / CELL)}`;
    const bucket = roadGrid.get(key);
    if (bucket) bucket.push(s);
    else roadGrid.set(key, [s]);
  }
}

const DEFAULT_NEAREST = { dist: 9999, width: 10, x: 0, z: 0, y: 0 };

/** Distance to the nearest road centre line, searching a 3x3 cell window. */
export function nearestRoad(x: number, z: number): { dist: number; width: number; x: number; z: number; y: number } {
  const cx = Math.floor(x / CELL);
  const cz = Math.floor(z / CELL);
  let best = DEFAULT_NEAREST;
  let bestD2 = Infinity;
  for (let ix = -1; ix <= 1; ix++) {
    for (let iz = -1; iz <= 1; iz++) {
      const bucket = roadGrid.get(`${cx + ix},${cz + iz}`);
      if (!bucket) continue;
      for (let i = 0; i < bucket.length; i++) {
        const s = bucket[i];
        const dx = x - s.x;
        const dz = z - s.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < bestD2) {
          bestD2 = d2;
          best = { dist: Math.sqrt(d2), width: s.width, x: s.x, z: s.z, y: s.y };
        }
      }
    }
  }
  return best;
}

// --- Mountain road ---------------------------------------------------------

export const MOUNTAIN_SHELF_FLAT = 11;
export const MOUNTAIN_SHELF_BLEND = 42;
const MOUNTAIN_DROP = 0.06;

/** Terrain as the mountain road finds it, before the road is cut into it. */
export function naturalHeightAt(x: number, z: number): number {
  const base = baseHeight(x, z);
  const road = nearestRoad(x, z);
  const corridor = Math.max(road.dist - road.width * 0.5, 0);
  // The border ridge and the rolling hills would otherwise cut through the
  // massif and leave the road tunnelling behind walls of rock, so both fade out
  // where the cone rises: the col is one clean, drivable slope.
  const fromMassif = Math.hypot(x - MASSIF.cx, z - MASSIF.cz) / MASSIF.radius;
  const outside = smoothstep(0.55, 1.3, fromMassif);
  const ridge = edgeRidge(x, z) * outside;
  const hills = rollingHills(x, z) * smoothstep(8, 90, corridor) * (0.35 + 0.65 * outside);
  return base + hills + ridge + massifHeight(x, z);
}

/**
 * Fits a drivable profile to the hillside: smooth, inside a maximum grade, and
 * still ending on the summit. Both ends are pinned to the terrain so the road
 * joins the lowlands and the top without a step.
 */
function fitRoadProfile(points: THREE.Vector3[], target: number[], maxGrade: number): number[] {
  const n = target.length;
  const y = target.slice();
  const start = target[0];
  const steps: number[] = [];
  for (let i = 1; i < n; i++) steps.push(Math.max(points[i].distanceTo(points[i - 1]), 0.01));

  for (let iter = 0; iter < 240; iter++) {
    for (let i = 1; i < n - 1; i++) {
      y[i] = (y[i - 1] + 2 * y[i] + y[i + 1]) * 0.25;
    }
    for (let i = 1; i < n; i++) {
      const limit = maxGrade * steps[i - 1];
      const delta = y[i] - y[i - 1];
      if (delta > limit) y[i] = y[i - 1] + limit;
      else if (delta < -limit) y[i] = y[i - 1] - limit;
    }
    for (let i = n - 2; i >= 0; i--) {
      const limit = maxGrade * steps[i];
      const delta = y[i] - y[i + 1];
      if (delta > limit) y[i] = y[i + 1] + limit;
      else if (delta < -limit) y[i] = y[i + 1] - limit;
    }
    y[0] = start;
  }
  return y;
}

const MOUNTAIN_CELL = 24;
const mountainGrid = new Map<string, RoadSample[]>();
const MOUNTAIN_NONE = { dist: 9999, y: 0, width: 10, x: 0, z: 0 };

function buildMountainRoad(def: RoadDef): SampledRoad {
  const curve = curveFor(def);
  const length = curve.getLength();
  const count = Math.max(8, Math.ceil(length / 4));
  const points: THREE.Vector3[] = [];
  for (let i = 0; i <= count; i++) {
    const p = curve.getPointAt(Math.min(1, i / count));
    points.push(new THREE.Vector3(p.x, 0, p.z));
  }

  const target = points.map((p) => naturalHeightAt(p.x, p.z));
  const heights = fitRoadProfile(points, target, 0.16);
  // The junction has to meet the ring road at its own surface level, or the
  // graded shelf pokes up through the ring asphalt.
  const junction = 16;
  for (let i = 0; i < junction && i < heights.length; i++) {
    const t = smoothstep(0, junction, i);
    heights[i] = (baseHeight(points[i].x, points[i].z) - 0.03) * (1 - t) + heights[i] * t;
  }
  for (let i = 0; i < points.length; i++) points[i].y = heights[i];

  const samples: RoadSample[] = points.map((p, i) => ({
    x: p.x,
    z: p.z,
    y: p.y,
    width: def.width,
    roadId: def.id,
    s: i * 4,
  }));
  for (const s of samples) {
    const key = `${Math.floor(s.x / MOUNTAIN_CELL)},${Math.floor(s.z / MOUNTAIN_CELL)}`;
    const bucket = mountainGrid.get(key);
    if (bucket) bucket.push(s);
    else mountainGrid.set(key, [s]);
  }
  return { def, points, samples, length };
}

export const MOUNTAIN_ROADS: SampledRoad[] = [buildMountainRoad(COL_ROAD)];

export function nearestMountain(x: number, z: number): { dist: number; y: number; width: number; x: number; z: number } {
  const cx = Math.floor(x / MOUNTAIN_CELL);
  const cz = Math.floor(z / MOUNTAIN_CELL);
  let best = MOUNTAIN_NONE;
  let bestD2 = Infinity;
  for (let ix = -2; ix <= 2; ix++) {
    for (let iz = -2; iz <= 2; iz++) {
      const bucket = mountainGrid.get(`${cx + ix},${cz + iz}`);
      if (!bucket) continue;
      for (const s of bucket) {
        const dx = x - s.x;
        const dz = z - s.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < bestD2) {
          bestD2 = d2;
          best = { dist: Math.sqrt(d2), y: s.y, width: s.width, x: s.x, z: s.z };
        }
      }
    }
  }
  return best;
}

/** Distance to the closest road of any kind, for scenery placement. */
export function roadClearance(x: number, z: number): number {
  return Math.min(nearestRoad(x, z).dist, nearestMountain(x, z).dist);
}

/** Flat summit where the road ends: the drift arena at the top of the col. */
export const SUMMIT = (() => {
  const road = MOUNTAIN_ROADS[0];
  const last = road.samples[road.samples.length - 1];
  return { cx: MASSIF.cx, cz: MASSIF.cz, y: last.y, radius: 52, blend: 86 };
})();

export function padEdgeDistance(x: number, z: number): number {
  const dx = Math.abs(x - DRIFT_PAD.cx) - DRIFT_PAD.halfX;
  const dz = Math.abs(z - DRIFT_PAD.cz) - DRIFT_PAD.halfZ;
  return Math.max(dx, dz);
}

/** Final terrain height: roads are flat to their own level, pads are level. */
export function heightAt(x: number, z: number): number {
  let h = naturalHeightAt(x, z);

  // The mountain road is cut into the slope: a flat shelf two lanes wide, then
  // an embankment that fades back into the hillside.
  const mountain = nearestMountain(x, z);
  if (mountain.dist < MOUNTAIN_SHELF_BLEND) {
    const t = smoothstep(MOUNTAIN_SHELF_FLAT, MOUNTAIN_SHELF_BLEND, mountain.dist);
    h = (mountain.y - MOUNTAIN_DROP) * (1 - t) + h * t;
  }

  const summit = Math.hypot(x - SUMMIT.cx, z - SUMMIT.cz);
  if (summit < SUMMIT.blend) {
    const t = smoothstep(SUMMIT.radius, SUMMIT.blend, summit);
    h = SUMMIT.y * (1 - t) + h * t;
  }

  const pad = padEdgeDistance(x, z);
  if (pad < 34) {
    const t = smoothstep(0, 34, pad);
    h = DRIFT_PAD.y * (1 - t) + h * t;
  }
  return h;
}

/** Terrain height without the drift pad blend, used to seed the pad height. */
export function rawHeightAt(x: number, z: number): number {
  return naturalHeightAt(x, z);
}

DRIFT_PAD.y = rawHeightAt(DRIFT_PAD.cx, DRIFT_PAD.cz);

/** Foot of the climb, where the col joins the ring road. */
export const COL_START = (() => {
  const road = MOUNTAIN_ROADS[0];
  const p = road.points[2];
  const next = road.points[3];
  return { x: p.x, z: p.z, heading: Math.atan2(-(next.x - p.x), -(next.z - p.z)) };
})();

export function roadHeadingAt(road: SampledRoad, index: number): number {
  const a = road.points[index % road.points.length];
  const b = road.points[(index + 1) % road.points.length];
  return Math.atan2(a.x - b.x, a.z - b.z);
}

export const RING: SampledRoad = SAMPLED_ROADS.find((r) => r.def.id === 'ring')!;

export function ringPoseAt(t: number): { x: number; z: number; heading: number } {
  const n = RING.points.length;
  const idx = Math.floor(t * n) % n;
  const p = RING.points[idx];
  const next = RING.points[(idx + 1) % n];
  return { x: p.x, z: p.z, heading: Math.atan2(-(next.x - p.x), -(next.z - p.z)) };
}

/** 12 evenly spaced checkpoints around the ring, starting at the start line. */
export function buildRaceCheckpoints(count = 12): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (let i = 0; i < count; i++) {
    const t = (RACE_START_INDEX_FRACTION + i / count) % 1;
    const pose = ringPoseAt(t);
    out.push(new THREE.Vector3(pose.x, baseHeight(pose.x, pose.z), pose.z));
  }
  return out;
}

export const RACE_START = ringPoseAt(RACE_START_INDEX_FRACTION);
