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

export function padEdgeDistance(x: number, z: number): number {
  const dx = Math.abs(x - DRIFT_PAD.cx) - DRIFT_PAD.halfX;
  const dz = Math.abs(z - DRIFT_PAD.cz) - DRIFT_PAD.halfZ;
  return Math.max(dx, dz);
}

/** Final terrain height: roads are flat to their own level, pads are level. */
export function heightAt(x: number, z: number): number {
  const base = baseHeight(x, z);
  const road = nearestRoad(x, z);
  const corridor = Math.max(road.dist - road.width * 0.5, 0);
  const hillsMask = smoothstep(8, 90, corridor);
  let h = base + rollingHills(x, z) * hillsMask + edgeRidge(x, z);

  const pad = padEdgeDistance(x, z);
  if (pad < 34) {
    const t = smoothstep(0, 34, pad);
    h = DRIFT_PAD.y * (1 - t) + h * t;
  }
  return h;
}

/** Terrain height without the drift pad blend, used to seed the pad height. */
export function rawHeightAt(x: number, z: number): number {
  const base = baseHeight(x, z);
  const road = nearestRoad(x, z);
  const corridor = Math.max(road.dist - road.width * 0.5, 0);
  return base + rollingHills(x, z) * smoothstep(8, 90, corridor) + edgeRidge(x, z);
}

DRIFT_PAD.y = rawHeightAt(DRIFT_PAD.cx, DRIFT_PAD.cz);

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
