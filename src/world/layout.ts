import * as THREE from 'three';
import { MAP_ID, type MapId } from '../game/maps.ts';

/** La ville d'origine : 2 km de côté. */
const VILLAGE_WORLD_SIZE = 2000;
/** La carte du circuit est calée sur sa dalle : 2,4 km de côté. */
const SUZUKA_WORLD_SIZE = 2400;
/** Le circuit SP95 tient dans 1,6 km : sa piste fait 1,5 km de tour. */
const FLAT_WORLD_SIZE = 2000;

/** Taille du monde de chaque carte. */
export function worldSizeFor(map: MapId): number {
  if (map === 'suzuka') return SUZUKA_WORLD_SIZE;
  if (map === 'sp95') return FLAT_WORLD_SIZE;
  return VILLAGE_WORLD_SIZE;
}

/** ~7 m de maille sur la ville, ~6 m sur la dalle de Suzuka, 8 m à plat. */
export function terrainSegmentsFor(map: MapId): number {
  if (map === 'suzuka') return 420;
  if (map === 'sp95') return 250;
  return 300;
}

export const WORLD_SIZE = worldSizeFor(MAP_ID);
export const TERRAIN_SEGMENTS = terrainSegmentsFor(MAP_ID);

/**
 * Bande de terrain qui déborde du monde jouable, en mètres. La barrière du bord
 * en a besoin : sans elle, le sol s'arrêterait net au bord de la grille.
 */
export const WORLD_BORDER = 80;
/** Hauteur de la barrière au bord de la grille, en mètres. */
export const WORLD_BORDER_HEIGHT = 95;
/** Emprise de la grille de terrain : le monde jouable plus sa barrière. */
export const TERRAIN_SPAN = WORLD_SIZE + WORLD_BORDER * 2;

/**
 * Barrière du bord du monde : nulle dans le monde jouable, puis une rampe à
 * ~50° qui monte jusqu'au bord de la grille. Un mur-collider ne marche pas ici
 * (mesuré en jeu : il ne retenait rien) : la coque ne collisionne qu'avec le
 * groupe `WORLD`, et les roues lisent le sol au rayon sur le groupe `GROUND`.
 * Cette barrière est le trimesh du terrain lui-même, donc de la vraie montée,
 * et l'herbe n'a pas le grip pour la grimper.
 */
export function borderHeight(x: number, z: number): number {
  // Le circuit SP95 est clos par ses murs : aucun rempart de terrain ne doit
  // dresser une falaise sombre à l'horizon de la carte plate.
  if (FLAT_MAP) return 0;
  const half = WORLD_SIZE / 2;
  const r = Math.max(Math.abs(x), Math.abs(z));
  if (r <= half) return 0;
  return Math.min(1, (r - half) / WORLD_BORDER) * WORLD_BORDER_HEIGHT;
}

/**
 * La carte de la ville : rues encaissées, col et piste rallye. La carte du
 * circuit n'a rien de tout ça — sa seule route est la sienne.
 */
export function villageFeaturesOn(map: MapId): boolean {
  return map === 'ville';
}

export const VILLAGE_MAP = villageFeaturesOn(MAP_ID);
/**
 * La carte au sol strictement plat : le circuit SP95. Son relief vaut zéro
 * partout, donc aucune pente ne peut sortir du terrain et la piste n'a pas
 * besoin d'une seconde couche de collision.
 */
export const FLAT_MAP = MAP_ID === 'sp95';

export type SurfaceKind = 'asphalte' | 'terre' | 'herbe';

export interface RoadDef {
  id: string;
  name: string;
  /** X/Z control points, world meters. */
  points: [number, number][];
  closed: boolean;
  width: number;
  kind: 'city' | 'rural' | 'avenue' | 'dirt';
  /** Defaults to asphalt. Dirt roads get gravel, no markings and a soft edge. */
  surface?: 'asphalt' | 'dirt';
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
 * The col: a massif in the south-west corner, climbed by a switchback road
 * that ends on a flat summit where the drift sessions happen.
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

/** Demi-emprise de la dalle du modèle Suzuka, en unités du modèle (mètres). */
export const PLATE_HALF_X = 580;
export const PLATE_HALF_Z = 1094;

export interface CircuitPlacement {
  /** Faux sur la carte de la ville : ni dalle, ni revêtement de piste. */
  active: boolean;
  cx: number;
  cz: number;
  /** Rotation autour de Y, radians. */
  yaw: number;
  scale: number;
  plateHalfX: number;
  plateHalfZ: number;
  /**
   * Hauteur du sol du circuit, posée par le module circuit avant la génération
   * du terrain. Sans elle, le terrain naturel reste seul en place.
   */
  ground: ((x: number, z: number) => number | null) | null;
  /** Revêtement sous la roue (asphalte de piste, bac à gravier, pelouse). */
  surface: ((x: number, z: number) => SurfaceKind | null) | null;
}

/**
 * Place du circuit sur chaque carte. La ville n'a plus le sien : le modèle a sa
 * propre carte, centrée sur sa dalle, à **l'échelle du modèle** — 1 unité = 1 m,
 * soit une piste de ~8 m de large et un tour de 1,6 km. Toute échelle plus
 * petite rétrécit la piste sous la voiture et fait percer le terrain de secours.
 */
export function circuitPlacement(map: MapId): CircuitPlacement {
  const suzuka = map === 'suzuka';
  return {
    active: suzuka,
    cx: 0,
    cz: 0,
    yaw: 0,
    scale: suzuka ? 1 : 0.45,
    plateHalfX: suzuka ? PLATE_HALF_X : 0,
    plateHalfZ: suzuka ? PLATE_HALF_Z : 0,
    ground: null,
    surface: null,
  };
}

export const CIRCUIT: CircuitPlacement = circuitPlacement(MAP_ID);

/** Distance au bord de l'emprise du circuit, négative à l'intérieur. */
export function circuitEdgeDistance(x: number, z: number): number {
  // La carte de la ville n'a pas de dalle : il n'y a rien à contourner.
  if (!CIRCUIT.active) return Infinity;
  const dx = x - CIRCUIT.cx;
  const dz = z - CIRCUIT.cz;
  const c = Math.cos(CIRCUIT.yaw);
  const s = Math.sin(CIRCUIT.yaw);
  // Rotation inverse : on ramène le point dans le repère du modèle.
  const lx = dx * c - dz * s;
  const lz = dx * s + dz * c;
  const ex = Math.abs(lx) - CIRCUIT.plateHalfX * CIRCUIT.scale;
  const ez = Math.abs(lz) - CIRCUIT.plateHalfZ * CIRCUIT.scale;
  return Math.max(ex, ez);
}

/**
 * Longueur de la pente qui raccorde la dalle du circuit au terrain : elle se
 * construit hors de la dalle, dans le module circuit.
 */
export const CIRCUIT_FADE = 45;

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

// --- Mountain road ---------------------------------------------------------
//
// A switchback, not a spiral: the road traverses the south-east face, then a
// hairpin turns it back on itself one shelf higher, over and over. The hairpin
// keeps the same polar angle as the end of the traverse, so consecutive legs
// stack like the lacets of a real col.

interface Leg {
  /** Radius at the start of the traverse. */
  r0: number;
  /** Radius at its far end (the road drifts inward as it climbs). */
  r1: number;
  /** Angle reached by the hairpin at the far end. */
  r2: number;
}

const COL_LEGS: Leg[] = [
  { r0: 238, r1: 224, r2: 196 },
  { r0: 196, r1: 182, r2: 154 },
  { r0: 154, r1: 140, r2: 112 },
  { r0: 112, r1: 99, r2: 76 },
  { r0: 76, r1: 66, r2: 60 },
];

const COL_SWEEP = 1.3;

const COL_POINTS: [number, number][] = (() => {
  const points: [number, number][] = [];
  const push = (x: number, z: number) => points.push([x, z]);
  const a0 = 0.45;
  const at = (angle: number, radius: number): [number, number] => [
    MASSIF.cx + Math.cos(angle) * radius,
    MASSIF.cz + Math.sin(angle) * radius,
  ];

  // Approach: leave the ring road and run up to the foot of the first leg.
  // The leg is entered a little way along its sweep so the two directions line
  // up: a tighter join than that kinks the road into a 3 m radius hairpin.
  const firstAngle = a0 - 0.22;
  const first = at(firstAngle, COL_LEGS[0].r0);
  push(-238, -302);
  push((-238 + first[0]) / 2, (-302 + first[1]) / 2);

  let angle = firstAngle;
  let dir = -1;
  for (let i = 0; i < COL_LEGS.length; i++) {
    const leg = COL_LEGS[i];
    // The first leg already gave up its opening 0.22 rad to the approach.
    const sweep = dir * (COL_SWEEP - (i === 0 ? 0.22 : 0));
    const steps = Math.max(10, Math.round((leg.r0 * COL_SWEEP) / 9));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const a = angle + sweep * t;
      const r = leg.r0 + (leg.r1 - leg.r0) * t;
      push(...at(a, r));
    }

    const centreAngle = angle + sweep;
    const last = i === COL_LEGS.length - 1;
    if (last) {
      // Final approach: a gentle arc onto the summit pad.
      const finalSteps = 14;
      for (let s = 1; s <= finalSteps; s++) {
        const t = s / finalSteps;
        const a = centreAngle + dir * 0.55 * t;
        const r = leg.r1 - 8 * t;
        push(...at(a, r));
      }
      break;
    }

    // Hairpin: a semicircle that turns the car 180° and lifts the road by one
    // shelf. `h` is half the radius step.
    const h = (leg.r1 - leg.r2) / 2;
    const hairSteps = Math.max(6, Math.round((Math.PI * h) / 6));
    for (let s = 1; s <= hairSteps; s++) {
      const phi = (s / hairSteps) * Math.PI;
      const rc = leg.r1 - h;
      const radial: [number, number] = [Math.cos(centreAngle), Math.sin(centreAngle)];
      const tangent: [number, number] = [-Math.sin(centreAngle), Math.cos(centreAngle)];
      const px = MASSIF.cx + radial[0] * rc + radial[0] * Math.cos(phi) * h;
      const pz = MASSIF.cz + radial[1] * rc + radial[1] * Math.cos(phi) * h;
      const side = dir * h * Math.sin(phi);
      push(px + tangent[0] * side, pz + tangent[1] * side);
    }

    angle = centreAngle;
    dir = -dir;
  }
  return points;
})();

export const COL_ROAD: RoadDef = {
  id: 'col',
  name: 'Route du Col',
  points: COL_POINTS,
  closed: false,
  width: 10.5,
  kind: 'rural',
};

// --- Dirt ------------------------------------------------------------------

/** A rally stage in the south-east hills: closed, narrow, no markings. */
export const RALLY_LOOP: RoadDef = {
  id: 'rally',
  name: 'Boucle Rallye',
  points: [
    [356, -196],
    [404, -172],
    [452, -178],
    [480, -206],
    [468, -234],
    [428, -242],
    [398, -264],
    [412, -294],
    [458, -302],
    [492, -332],
    [468, -366],
    [418, -384],
    [364, -384],
    [316, -364],
    [292, -332],
    [302, -298],
    [332, -280],
    [356, -258],
    [348, -226],
  ],
  closed: true,
  width: 8,
  kind: 'dirt',
  surface: 'dirt',
};

/** Gravel link from the ring road to the rally loop. */
export const RALLY_LINK: RoadDef = {
  id: 'rally-link',
  name: 'Piste du Bois',
  points: [
    [274, -252],
    [306, -238],
    [336, -222],
    [356, -210],
    [356, -196],
  ],
  closed: false,
  width: 7,
  kind: 'dirt',
  surface: 'dirt',
};

export const DIRT_ROADS: RoadDef[] = [RALLY_LOOP, RALLY_LINK];

function edgeRidge(x: number, z: number): number {
  const r = Math.max(Math.abs(x), Math.abs(z));
  // La ceinture suit la taille du monde : elle doit rester au bord, pas se
  // retrouver au milieu maintenant que le monde s'est élargi à l'est.
  const t = smoothstep(WORLD_SIZE * 0.32, WORLD_SIZE * 0.49, r);
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
interface IndexedSample extends RoadSample {
  index: number;
  road: SampledRoad;
}
const roadGrid = new Map<string, IndexedSample[]>();

for (const road of SAMPLED_ROADS) {
  road.samples.forEach((s, index) => {
    const entry: IndexedSample = { ...s, index, road };
    const key = `${Math.floor(s.x / CELL)},${Math.floor(s.z / CELL)}`;
    const bucket = roadGrid.get(key);
    if (bucket) bucket.push(entry);
    else roadGrid.set(key, [entry]);
  });
}

const DEFAULT_NEAREST = { dist: 9999, width: 10, x: 0, z: 0, y: 0 };

/**
 * Distance to the nearest road centre line, searching a 3x3 cell window.
 * The height is interpolated along the segment, not taken from the nearest
 * sample: on a climb a 4 m step along the road is a 40 cm height step, and
 * using it as a plateau pushed the hillside up through the asphalt at bends.
 */
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
        const samples = s.road.samples;
        const last = s.index === samples.length - 1;
        const open = !s.road.def.closed;
        const from = last && open ? samples[s.index - 1] : s;
        const next = last && open ? samples[s.index] : samples[(s.index + 1) % samples.length];
        const hit = segmentHit(x, z, from.x, from.z, next.x, next.z);
        const d2 = hit.dist * hit.dist;
        if (d2 < bestD2) {
          bestD2 = d2;
          const y = from.y + (next.y - from.y) * hit.t;
          best = {
            dist: hit.dist,
            width: s.width,
            x: from.x + (next.x - from.x) * hit.t,
            z: from.z + (next.z - from.z) * hit.t,
            y,
          };
        }
      }
    }
  }
  return best;
}

/** Point-to-segment distance and the projection parameter. */
function segmentHit(
  x: number,
  z: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): { dist: number; t: number } {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  let t = len2 > 1e-9 ? ((x - ax) * dx + (z - az) * dz) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const px = ax + dx * t;
  const pz = az + dz * t;
  return { dist: Math.hypot(x - px, z - pz), t };
}

/** Terrain as the mountain road finds it, before the road is cut into it. */
export function naturalHeightAt(x: number, z: number): number {
  // Le circuit SP95 est plat par contrat : pas de collines, pas de bord relevé
  // dans le monde jouable. Le seul relief est la barrière du bord, très loin.
  if (FLAT_MAP) return 0;
  const base = baseHeight(x, z);
  // La carte du circuit n'a ni route à longer, ni massif à contourner : son
  // relief se réduit aux collines et à la ceinture de montagnes du bord.
  if (!VILLAGE_MAP) return base + rollingHills(x, z) + edgeRidge(x, z);
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

// --- Graded roads (the col and the dirt tracks) -----------------------------
//
// Both need an engineered profile: a smooth longitudinal curve, inside a grade
// limit, cut into the terrain as a flat shelf. One builder serves both.

export interface GradedOptions {
  maxGrade: number;
  /** Fully flat half-width of the shelf, m. */
  flat: number;
  /** Distance at which the embankment has faded into the hillside, m. */
  blend: number;
  /** How far the shelf sits below the road surface, m. */
  drop: number;
  /** Pins the first samples to the terrain so the road meets the junction. */
  junction?: number;
}

interface GradedRoad extends SampledRoad {
  options: GradedOptions;
  dirt: boolean;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

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

const graded: GradedRoad[] = [];

function buildGraded(def: RoadDef, options: GradedOptions): GradedRoad {
  const curve = curveFor(def);
  const length = curve.getLength();
  const count = Math.max(8, Math.ceil(length / 4));
  const points: THREE.Vector3[] = [];
  for (let i = 0; i <= count; i++) {
    const p = curve.getPointAt(Math.min(1, i / count));
    points.push(new THREE.Vector3(p.x, 0, p.z));
  }
  // Closed splines repeat their first point at t = 1: drop it, the seam is
  // implicit and a zero-length segment breaks the grade fitter.
  if (def.closed && points.length > 2 && points[0].distanceTo(points[points.length - 1]) < 0.5) {
    points.pop();
  }

  const target = points.map((p) => naturalHeightAt(p.x, p.z));
  const heights = fitRoadProfile(points, target, options.maxGrade);
  // The junction has to meet the ring road at its own surface level, or the
  // graded shelf pokes up through the ring asphalt.
  const junction = options.junction ?? 0;
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
    s: (i / Math.max(1, points.length - 1)) * length,
  }));

  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z);
    maxZ = Math.max(maxZ, p.z);
  }

  const road: GradedRoad = {
    def,
    points,
    samples,
    length,
    options,
    dirt: def.surface === 'dirt',
    minX,
    maxX,
    minZ,
    maxZ,
  };
  graded.push(road);
  return road;
}

export const MOUNTAIN_ROADS: SampledRoad[] = [
  buildGraded(COL_ROAD, { maxGrade: 0.145, flat: 7.6, blend: 32, drop: 0.03, junction: 16 }),
];

export const DIRT_TRACKS: SampledRoad[] = DIRT_ROADS.map((def) =>
  buildGraded(def, {
    maxGrade: 0.2,
    // The terrain grid is 6.7 m; a narrower flat band lets a triangle from
    // inside the lane to the hillside poke through the gravel, so the shelf has
    // to be a good cell wider than the driving surface.
    flat: def.width * 0.5 + 2.2,
    blend: def.width * 0.5 + 20,
    drop: 0.02,
    junction: def.closed ? 0 : 8,
  }),
);

const GRADED_CELL = 24;
interface GradedEntry {
  road: GradedRoad;
  index: number;
}
const gradedGrid = new Map<string, GradedEntry[]>();

for (const road of graded) {
  road.samples.forEach((s, index) => {
    const key = `${Math.floor(s.x / GRADED_CELL)},${Math.floor(s.z / GRADED_CELL)}`;
    const bucket = gradedGrid.get(key);
    if (bucket) bucket.push({ road, index });
    else gradedGrid.set(key, [{ road, index }]);
  });
}

export interface GradedHit {
  dist: number;
  y: number;
  width: number;
  x: number;
  z: number;
  road: GradedRoad;
}

/**
 * Nearest sample of any engineered road. The sample grid is coarse, so this
 * walks a 5x5 cell window; the bbox test in front keeps the terrain build fast.
 */
export function nearestGraded(x: number, z: number): GradedHit | null {
  const cx = Math.floor(x / GRADED_CELL);
  const cz = Math.floor(z / GRADED_CELL);
  let best: GradedHit | null = null;
  let bestD2 = Infinity;
  for (let ix = -2; ix <= 2; ix++) {
    for (let iz = -2; iz <= 2; iz++) {
      const bucket = gradedGrid.get(`${cx + ix},${cz + iz}`);
      if (!bucket) continue;
      for (const entry of bucket) {
        const road = entry.road;
        if (
          x < road.minX - 60 ||
          x > road.maxX + 60 ||
          z < road.minZ - 60 ||
          z > road.maxZ + 60
        ) {
          continue;
        }
        const samples = road.samples;
        const last = entry.index === samples.length - 1;
        const open = !road.def.closed;
        const from = last && open ? samples[entry.index - 1] : samples[entry.index];
        const to = last && open ? samples[entry.index] : samples[(entry.index + 1) % samples.length];
        const hit = segmentHit(x, z, from.x, from.z, to.x, to.z);
        const d2 = hit.dist * hit.dist;
        if (d2 < bestD2) {
          bestD2 = d2;
          best = {
            dist: hit.dist,
            y: from.y + (to.y - from.y) * hit.t,
            width: from.width,
            x: from.x + (to.x - from.x) * hit.t,
            z: from.z + (to.z - from.z) * hit.t,
            road,
          };
        }
      }
    }
  }
  return best;
}

export function nearestMountain(x: number, z: number): { dist: number; y: number; width: number; x: number; z: number } {
  const hit = nearestGraded(x, z);
  if (!hit) return { dist: 9999, y: 0, width: 10, x: 0, z: 0 };
  return { dist: hit.dist, y: hit.y, width: hit.width, x: hit.x, z: hit.z };
}

/** Distance to the closest road of any kind, for scenery placement. */
export function roadClearance(x: number, z: number): number {
  return Math.min(nearestRoad(x, z).dist, nearestGraded(x, z)?.dist ?? 9999);
}

/** Flat summit where the road ends: the drift arena at the top of the col. */
export const SUMMIT = (() => {
  const road = MOUNTAIN_ROADS[0];
  const last = road.samples[road.samples.length - 1];
  return { cx: MASSIF.cx, cz: MASSIF.cz, y: last.y, radius: 54, blend: 66 };
})();

export function padEdgeDistance(x: number, z: number): number {
  const dx = Math.abs(x - DRIFT_PAD.cx) - DRIFT_PAD.halfX;
  const dz = Math.abs(z - DRIFT_PAD.cz) - DRIFT_PAD.halfZ;
  return Math.max(dx, dz);
}

// --- Surface ---------------------------------------------------------------

export interface SurfaceInfo {
  kind: SurfaceKind;
  /** Multiplier on tire friction. */
  grip: number;
  /** Multiplier on the tire's peak slip angle. */
  peak: number;
  /** Multiplier on rolling resistance. */
  rolling: number;
  /** 0..1 how much the ground rumbles. */
  roughness: number;
}

export const SURFACES: Record<SurfaceKind, SurfaceInfo> = {
  asphalte: { kind: 'asphalte', grip: 1, peak: 1, rolling: 1, roughness: 0 },
  terre: { kind: 'terre', grip: 0.62, peak: 1.3, rolling: 2.6, roughness: 0.72 },
  herbe: { kind: 'herbe', grip: 0.47, peak: 1.45, rolling: 3.8, roughness: 1 },
};

/** Route mouillée : état global, désactivé par défaut (sec). */
let wetRoad = false;
/** Facteur de grip sur toute surface quand la route est mouillée. */
export const WET_GRIP = 0.7;

/**
 * Variantes mouillées, calculées une fois. La physique demande la surface à
 * chaque contact de roue (120 Hz × 4 roues) : elle doit recevoir une référence
 * stable, jamais un objet neuf à chaque appel.
 */
const WET_SURFACES: Record<SurfaceKind, SurfaceInfo> = {
  asphalte: { ...SURFACES.asphalte, grip: SURFACES.asphalte.grip * WET_GRIP },
  terre: { ...SURFACES.terre, grip: SURFACES.terre.grip * WET_GRIP },
  herbe: { ...SURFACES.herbe, grip: SURFACES.herbe.grip * WET_GRIP },
};

export function isWetRoad(): boolean {
  return wetRoad;
}

export function setWetRoad(wet: boolean): void {
  wetRoad = wet;
}

/** Le spray arrière ne sort que d'un pneu au contact, en mouvement, sur route mouillée. */
export function sprayActive(speed: number, contact: boolean): boolean {
  return wetRoad && contact && speed > 1.5;
}

/** Which surface a wheel is rolling on, wet or dry. Sharp edges, no grid blurring. */
export function surfaceAt(x: number, z: number): SurfaceInfo {
  const info = drySurfaceAt(x, z);
  return wetRoad ? WET_SURFACES[info.kind] : info;
}

/**
 * Revêtement fourni par une piste dessinée par le jeu (le circuit SP95).
 *
 * `surfaceAt` appartient à ce module mais la piste vit dans le sien : sans ce
 * point d'entrée, la grille devrait connaître chaque tracé. Il est posé après
 * la construction de la piste, avant le premier pas de physique.
 */
let trackSurfaceSource: ((x: number, z: number) => SurfaceKind | null) | null = null;

export function setTrackSurface(
  source: ((x: number, z: number) => SurfaceKind | null) | null,
): void {
  trackSurfaceSource = source;
}

function drySurfaceAt(x: number, z: number): SurfaceInfo {
  // Le circuit a son propre revêtement : bac à gravier compris, il n'y a pas de
  // rayon à tirer dans les cailloux pour savoir si la roue accroche.
  const circuit = CIRCUIT.active ? CIRCUIT.surface?.(x, z) : null;
  if (circuit) return SURFACES[circuit];
  const authored = trackSurfaceSource?.(x, z);
  if (authored) return SURFACES[authored];
  // Sa carte n'a pas d'autre route : hors dalle, c'est l'herbe, où que la ville
  // aurait posé son bitume.
  if (!VILLAGE_MAP) return SURFACES.herbe;
  const engineered = nearestGraded(x, z);
  if (engineered && engineered.dist <= engineered.width * 0.5 + 0.4) {
    return engineered.road.dirt ? SURFACES.terre : SURFACES.asphalte;
  }
  const road = nearestRoad(x, z);
  if (road.dist <= road.width * 0.5 + 0.4) return SURFACES.asphalte;
  if (padEdgeDistance(x, z) < 0) return SURFACES.asphalte;
  if (Math.hypot(x - SUMMIT.cx, z - SUMMIT.cz) < SUMMIT.radius) return SURFACES.asphalte;
  return SURFACES.herbe;
}

// --- Final terrain ---------------------------------------------------------

/** Final terrain height: roads are flat to their own level, pads are level. */
export function heightAt(x: number, z: number): number {
  // La dalle du circuit porte son propre relief : elle s'impose là où elle
  // existe. Son pourtour est déjà fondu dans le terrain par l'échantillonnage.
  // Une cote non finie est ignorée : un seul sommet cassé creuserait un trou
  // dans la grille que le collider recopie.
  const circuitGround = CIRCUIT.active ? CIRCUIT.ground?.(x, z) : null;
  const base =
    circuitGround != null && Number.isFinite(circuitGround)
      ? circuitGround
      : terrainBaseHeight(x, z);
  // La barrière du bord s'ajoute à tout : elle est hors du monde jouable.
  return base + borderHeight(x, z);
}

/**
 * Terrain de jeu sans le circuit : relief naturel, routes encaissées et aires
 * planes. C'est aussi la cible du raccord de la dalle du circuit, qui a besoin
 * de la hauteur définitive et pas du seul relief naturel.
 */
export function terrainBaseHeight(x: number, z: number): number {
  // La carte du circuit n'a ni rues encaissées, ni col, ni aire de drift : son
  // seul relief artificiel est la dalle du modèle, posée plus haut par heightAt.
  if (!VILLAGE_MAP) return naturalHeightAt(x, z);
  let h = naturalHeightAt(x, z);

  // The two arenas are levelled first: a road cut must be able to win over the
  // plateau it runs into, otherwise the summit disc buries the last switchback.
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

  // Every engineered road (the col, the dirt stages) is cut in as a flat shelf,
  // then an embankment fades back into the hillside.
  const engineered = nearestGraded(x, z);
  if (engineered && engineered.dist < engineered.road.options.blend) {
    const { blend, drop } = engineered.road.options;
    const t = smoothstep(engineered.width * 0.5 + 0.6, blend, engineered.dist);
    h = (engineered.y - drop) * (1 - t) + h * t;
  }

  // Ordinary streets: flatten the terrain to the asphalt level as well. Without
  // it the coarse terrain triangles poke through the road ribbon on any slope,
  // which is what made the surfaces flicker and overlap.
  const road = nearestRoad(x, z);
  const flat = road.width * 0.5 + 2.5;
  if (road.dist < flat + 8) {
    const t = smoothstep(flat, flat + 8, road.dist);
    h = (road.y - 0.012) * (1 - t) + h * t;
  }

  // The arena is re-floored after the cuts. The col is a stack of switchbacks:
  // a lower leg passes some twenty metres underneath the summit, and its 32 m
  // embankment blend was pulling the ground 2 to 5 m below the concrete disc.
  // The disc then had no collider under it and the car dropped through onto the
  // hillside. Inside the disc nothing may sit below the concrete; over the next
  // ten metres the floor eases back to whatever the road cuts left, so the rim
  // is a bank rather than a cliff. Where a road runs above the plateau (the
  // final switchback) the max keeps the road shelf, so the arena never buries
  // the road that leads to it.
  if (summit < SUMMIT.radius + 10) {
    const t = smoothstep(SUMMIT.radius, SUMMIT.radius + 10, summit);
    h = Math.max(h, SUMMIT.y * (1 - t) + h * t);
  }

  // Whatever the pads lift, the asphalt always wins: the floor above lifts the
  // last metres of the col to the arena level, and without this the road that
  // leads to the arena would end up under its own shoulder.
  if (engineered && engineered.dist < engineered.width * 0.5 + 1.2) {
    h = Math.min(h, engineered.y - 0.02);
  }

  return h;
}

/**
 * The pad is level with the streets that reach it, not with the hilltop under
 * it. Seeded from the natural ground it sat four metres above the avenue and
 * the access road, which then tunnelled under a floating slab of concrete.
 */
DRIFT_PAD.y = nearestRoad(DRIFT_PAD.cx - DRIFT_PAD.halfX + 6, DRIFT_PAD.cz).y;

/** Foot of the climb, where the col joins the ring road. */
export const COL_START = (() => {
  const road = MOUNTAIN_ROADS[0];
  const p = road.points[2];
  const next = road.points[3];
  return { x: p.x, z: p.z, heading: Math.atan2(-(next.x - p.x), -(next.z - p.z)) };
})();

/** Start line of the rally stage, on the gravel loop. */
export const RALLY_START = (() => {
  const loop = DIRT_TRACKS[0];
  const i = Math.floor(loop.points.length * 0.02);
  const p = loop.points[i];
  const next = loop.points[(i + 1) % loop.points.length];
  return { x: p.x, z: p.z, heading: Math.atan2(-(next.x - p.x), -(next.z - p.z)) };
})();

export const SUMMIT_START = (() => {
  const angle = 2.4;
  const r = SUMMIT.radius * 0.55;
  return {
    x: SUMMIT.cx + Math.cos(angle) * r,
    z: SUMMIT.cz + Math.sin(angle) * r,
    heading: angle + Math.PI / 2 + Math.PI,
  };
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
