/**
 * Le tracé du circuit SP95, dessiné à la main et **entièrement plat**.
 *
 * Suzuka apportait son propre relevé : 51 m de dénivelé, deux tabliers qui se
 * croisent, des cotes quantifiées et un collider reconstruit après coup. Ici il
 * n'y a rien à reconstruire : la piste est une bande de largeur constante posée
 * à la cote zéro, le sol est un seul plan à la même cote, et les murs sont des
 * boîtes. Aucune bosse ne peut donc sortir de nulle part, et aucune roue ne peut
 * tomber entre deux couches de sol.
 *
 * Ce module ne dépend ni de three ni de Rapier : il ne produit que de la
 * géométrie de référence (échantillons, tangentes, courbure, revêtement). Les
 * tests l'appellent directement, le rendu s'en sert pour bâtir le maillage.
 */

export type TrackSurfaceKind = 'asphalte' | 'herbe';

export interface TrackSample {
  x: number;
  z: number;
  /** Tangente unitaire dans le sens de la course. */
  tx: number;
  tz: number;
  /** Distance parcourue depuis la ligne, en mètres. */
  distance: number;
  /** Courbure signée, en 1/m (positive = virage à droite). */
  curvature: number;
}

export interface TrackData {
  samples: TrackSample[];
  /** Longueur du tour, en mètres. */
  length: number;
  halfWidth: number;
  /** Écart latéral du mur par rapport à l'axe, en mètres. */
  wallOffset: number;
  /** Position de départ, sur l'axe, juste après la ligne. */
  spawn: { x: number; z: number; heading: number };
}

/** Largeur de l'asphalte, vibreurs exclus. */
export const TRACK_WIDTH = 14;
export const HALF_WIDTH = TRACK_WIDTH / 2;
/** Largeur d'un vibreur, de chaque côté. */
export const KERB_WIDTH = 1.7;
/** Dégagement entre le vibreur et le mur. */
export const RUNOFF = 10;
/** Écart latéral du mur : au-delà du vibreur, après le dégagement. */
export const WALL_OFFSET = HALF_WIDTH + KERB_WIDTH + RUNOFF;
/** Cote du sol physique : le terrain plat, une seule couche. */
export const GROUND_LEVEL = 0;
/** Épaisseur du revêtement visible au-dessus du sol. */
export const ROAD_LIFT = 0.02;
/** Pas d'échantillonnage de l'axe, en mètres. */
const SAMPLE_STEP = 2.5;
/** Rayon en dessous duquel un virage reçoit des vibreurs. */
const KERB_RADIUS = 160;
/** Rayon minimal toléré pour une voiture de course, en mètres. */
export const MIN_CORNER_RADIUS = 22;

/**
 * Points de contrôle du tour, dans le sens de la course (départ vers +z).
 *
 * Le tracé n'est pas un ovale : il est engendré par une **demi-boucle** de
 * lignes droites et d'arcs qui tourne de 180° pile, puis recopiée par symétrie
 * centrale autour de son milieu. La copie repart exactement du point d'arrivée
 * avec le bon cap : la boucle est fermée par construction, pas par réglage.
 *
 * La demi-boucle enchaîne quatre droites et deux gauches (90, 60, 70, 50, 80 et
 * 50°) séparés par de courtes lignes droites. Le tour complet compte douze
 * virages — huit à droite, quatre à gauche — de 38 à 69 m de rayon, sur 2 031 m.
 */
export const CONTROL_POINTS: [number, number][] = [
  [0, -558], [0, -536], [0, -514], [0, -492], [0, -470], [0, -448],
  [0, -426], [0, -404], [0, -382], [0, -360], [0, -338], [0, -316],
  [0, -294], [0, -272], [0, -250], [0, -228],
  [4.4, -204.5], [16.4, -183.9], [33, -169.6], [53.2, -161],
  [75, -159], [97, -159], [119, -158.9], [140.4, -154.2],
  [159, -142.7], [173.8, -123.9], [184.8, -104.9], [198.8, -85.6],
  [217.5, -74.3], [239.2, -71], [262.9, -74.8], [286.6, -78.4],
  [308.4, -76], [328.4, -67.2], [347.1, -52.2], [365.5, -36.8],
  [385.3, -27.7], [407, -29.2], [427.2, -41.9], [445.6, -57.3],
  [463.2, -73.6], [475.5, -94], [480.7, -115.3], [481, -137.3],
  [481, -159.3], [481, -181.3], [481, -205.3], [481, -227.3],
  [481, -249.3], [481, -271.3], [481, -293.3], [481, -315.3],
  [481, -337.3], [481, -359.3], [481, -381.3], [481, -403.3],
  [481, -425.3], [481, -447.3], [481, -469.3], [481, -491.3],
  [481, -513.3], [476.6, -536.8], [464.6, -557.4], [446.3, -572.8],
  [425.9, -580.8], [404, -582.4], [382, -582.4], [360, -582.5],
  [336.9, -588.7], [319.1, -601.4], [305.2, -620.9], [294.2, -639.9],
  [279.1, -658.3], [259.6, -668.3], [237.9, -670], [214.2, -665.9],
  [190.4, -662.9], [168.8, -666.4], [147.7, -677.6], [129.3, -693],
  [110.6, -708], [89.7, -714.3], [66.6, -709], [47.7, -694.3],
  [29.3, -678.9], [13, -661.4], [2.9, -639.7], [0, -618],
  [0, -596], [0, -574],
];

function catmull(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}

/** Échantillonne la boucle fermée, sans doublon, à pas constant. */
export function buildTrack(points: [number, number][] = CONTROL_POINTS): TrackData {
  const count = points.length;
  const raw: { x: number; z: number }[] = [];
  for (let i = 0; i < count; i++) {
    const p0 = points[(i - 1 + count) % count];
    const p1 = points[i];
    const p2 = points[(i + 1) % count];
    const p3 = points[(i + 2) % count];
    const span = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const steps = Math.max(2, Math.round(span / SAMPLE_STEP));
    // Le dernier pas est exclu : le point suivant ouvrira le segment d'après.
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      raw.push({
        x: catmull(p0[0], p1[0], p2[0], p3[0], t),
        z: catmull(p0[1], p1[1], p2[1], p3[1], t),
      });
    }
  }

  const total = raw.length;
  const rough: TrackSample[] = [];
  let distance = 0;
  for (let i = 0; i < total; i++) {
    const prev = raw[(i - 1 + total) % total];
    const next = raw[(i + 1) % total];
    const tx = next.x - prev.x;
    const tz = next.z - prev.z;
    const norm = Math.hypot(tx, tz) || 1;
    if (i > 0) distance += Math.hypot(raw[i].x - raw[i - 1].x, raw[i].z - raw[i - 1].z);
    rough.push({
      x: raw[i].x,
      z: raw[i].z,
      tx: tx / norm,
      tz: tz / norm,
      distance,
      curvature: 0,
    });
  }
  // La boucle se referme entre le dernier point et le premier.
  const loop = Math.hypot(rough[0].x - rough[total - 1].x, rough[0].z - rough[total - 1].z);
  const length = distance + loop;

  // Pas constant : une courbe de Catmull-Rom accélère dans les virages et ses
  // échantillons s'y espacent (jusqu'à 4 m mesurés). On rééchantillonne par
  // longueur d'arc : l'asphalte, les vibreurs et les murs gardent la même
  // finesse partout, et aucune couture ne peut laisser de fente.
  const uniformCount = Math.max(16, Math.round(length / SAMPLE_STEP));
  const uniformStep = length / uniformCount;
  const samples: TrackSample[] = [];
  let cursor = 0;
  for (let k = 0; k < uniformCount; k++) {
    const target = k * uniformStep;
    while (cursor + 1 < total && rough[cursor + 1].distance <= target) cursor++;
    const a = rough[cursor];
    const b = rough[(cursor + 1) % total];
    const end = b.distance <= a.distance ? b.distance + length : b.distance;
    const t = Math.min(1, Math.max(0, (target - a.distance) / Math.max(1e-6, end - a.distance)));
    samples.push({
      x: a.x + (b.x - a.x) * t,
      z: a.z + (b.z - a.z) * t,
      tx: 0,
      tz: 0,
      distance: target,
      curvature: 0,
    });
  }

  // Tangentes par différence centrale sur les points rééchantillonnés.
  for (let i = 0; i < samples.length; i++) {
    const prev = samples[(i - 1 + samples.length) % samples.length];
    const next = samples[(i + 1) % samples.length];
    const tx = next.x - prev.x;
    const tz = next.z - prev.z;
    const norm = Math.hypot(tx, tz) || 1;
    samples[i].tx = tx / norm;
    samples[i].tz = tz / norm;
  }

  // Courbure par différence de cap sur un voisinage : un virage lissé reste
  // reconnu, un simple changement de cap d'un échantillon ne fait pas un vibreur.
  const wrap = (value: number): number => {
    while (value > Math.PI) value -= Math.PI * 2;
    while (value < -Math.PI) value += Math.PI * 2;
    return value;
  };
  const curvatureRun = 6 * uniformStep;
  for (let i = 0; i < samples.length; i++) {
    const before = samples[(i - 3 + samples.length) % samples.length];
    const after = samples[(i + 3) % samples.length];
    const a0 = Math.atan2(before.tz, before.tx);
    const a1 = Math.atan2(after.tz, after.tx);
    samples[i].curvature = wrap(a1 - a0) / curvatureRun;
  }

  const start = samples[0];
  return {
    samples,
    length,
    halfWidth: HALF_WIDTH,
    wallOffset: WALL_OFFSET,
    spawn: { x: start.x, z: start.z, heading: Math.atan2(-start.tx, -start.tz) },
  };
}

export const TRACK: TrackData = buildTrack();

/** Rayon du virage à un échantillon ; `Infinity` en ligne droite. */
export function cornerRadius(sample: TrackSample): number {
  const curvature = Math.abs(sample.curvature);
  return curvature < 1e-6 ? Infinity : 1 / curvature;
}

/** Vrai si le virage est assez serré pour mériter un vibreur. */
export function hasKerb(sample: TrackSample): boolean {
  return cornerRadius(sample) < KERB_RADIUS;
}

// --- Revêtement ------------------------------------------------------------

/**
 * Grille de voisinage : la physique demande la surface à chaque roue et à
 * chaque pas (4 × 120 fois par seconde). Une recherche sur 1 000 échantillons
 * serait trop lente ; trois cases de 24 m suffisent à trouver l'axe.
 */
const QUERY_CELL = 24;
let buckets: Map<number, number[]> | null = null;

const keyOf = (i: number, j: number): number => (i + 10000) * 100000 + (j + 10000);

function ensureBuckets(track: TrackData): Map<number, number[]> {
  if (buckets) return buckets;
  const grid = new Map<number, number[]>();
  track.samples.forEach((sample, index) => {
    const key = keyOf(Math.floor(sample.x / QUERY_CELL), Math.floor(sample.z / QUERY_CELL));
    const list = grid.get(key);
    if (list) list.push(index);
    else grid.set(key, [index]);
  });
  buckets = grid;
  return grid;
}

/** Distance signée du point à l'axe : positive à droite du sens de course. */
export function lateralOffset(x: number, z: number, track: TrackData = TRACK): number {
  const grid = ensureBuckets(track);
  const total = track.samples.length;
  const cellX = Math.floor(x / QUERY_CELL);
  const cellZ = Math.floor(z / QUERY_CELL);
  let best = Infinity;
  let signed = Infinity;
  for (let dz = -2; dz <= 2; dz++) {
    for (let dx = -2; dx <= 2; dx++) {
      const list = grid.get(keyOf(cellX + dx, cellZ + dz));
      if (!list) continue;
      for (const index of list) {
        const a = track.samples[index];
        const b = track.samples[(index + 1) % total];
        const ex = b.x - a.x;
        const ez = b.z - a.z;
        const lengthSq = ex * ex + ez * ez || 1;
        const t = Math.min(1, Math.max(0, ((x - a.x) * ex + (z - a.z) * ez) / lengthSq));
        const px = a.x + ex * t;
        const pz = a.z + ez * t;
        const dist = Math.hypot(x - px, z - pz);
        if (dist < best) {
          best = dist;
          // Produit vectoriel tangente × point : positif à droite.
          signed = (ex * (z - a.z) - ez * (x - a.x)) / Math.sqrt(lengthSq);
        }
      }
    }
  }
  // Aucune case voisine remplie : on est loin du circuit.
  if (best === Infinity) return Infinity;
  return signed < 0 ? -best : best;
}

/** Revêtement sous une roue : l'asphalte jusqu'au bord des vibreurs. */
export function trackSurfaceAt(x: number, z: number, track: TrackData = TRACK): TrackSurfaceKind {
  return Math.abs(lateralOffset(x, z, track)) <= track.halfWidth + KERB_WIDTH ? 'asphalte' : 'herbe';
}
