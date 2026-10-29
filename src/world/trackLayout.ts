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
/** Épaisseur des murs de bord de piste, en mètres. */
export const WALL_THICK = 0.5;
/** Pas d'échantillonnage de l'axe, en mètres. */
const SAMPLE_STEP = 2.5;
/** Rayon en dessous duquel un virage reçoit des vibreurs. */
const KERB_RADIUS = 160;
/** Rayon minimal toléré pour une voiture de course, en mètres. */
export const MIN_CORNER_RADIUS = 22;

/**
 * Points de contrôle du tour, dans le sens de la course (départ vers +z).
 *
 * Le tracé part d'une boucle fermée régulière, puis chaque point est déplacé le
 * long de la normale par une somme d'harmoniques et de bosses locales. La
 * déformation est pondérée par la distance à l'axe x = 0 : la ligne droite de
 * départ (stands, pit, portique) reste rectiligne, tout le reste du tour casse
 * la symétrie — plus de moitié de tour identique par recopie.
 *
 * Résultat mesuré : huit groupes de virages, quatre à droite et quatre à
 * gauche, rayons de 23 à 240 m, 2 060 m de tour. Deux sections éloignées ne se
 * rapprochent jamais à moins de 110 m : les tribunes et les postes de
 * commissaires tiennent entre les murs sans mordre sur la piste.
 */
export const CONTROL_POINTS: [number, number][] = [
[0.0, -558.0], [0.0, -543.0], [0.0, -528.0], [0.0, -513.0], [0.0, -498.0],
  [0.0, -483.0], [0.0, -467.9], [0.0, -452.9], [0.0, -437.9], [0.0, -422.9],
  [0.0, -407.9], [0.0, -392.9], [0.0, -377.9], [0.0, -362.9], [0.0, -347.9],
  [0.0, -332.9], [0.0, -317.9], [0.0, -302.8], [0.0, -287.8], [0.0, -272.8],
  [0.0, -257.8], [-0.2, -242.8], [0.0, -227.8], [2.1, -212.9], [6.9, -198.8],
  [14.7, -186.0], [25.2, -175.3], [37.9, -167.5], [51.9, -162.8], [66.5, -161.1],
  [81.4, -161.0], [96.4, -161.5], [111.4, -162.0], [126.8, -160.7], [141.9, -156.8],
  [157.5, -151.9], [171.5, -145.7], [183.7, -137.5], [193.6, -127.0], [199.6, -114.3],
  [202.9, -99.6], [206.7, -86.0], [216.8, -74.8], [231.2, -70.3], [246.5, -70.0],
  [261.4, -72.4], [276.2, -74.7], [290.6, -75.6], [304.9, -73.4], [316.0, -63.7],
  [324.9, -50.4], [336.7, -41.9], [352.5, -37.6], [366.5, -34.2], [380.9, -29.2],
  [395.5, -28.5], [409.0, -32.8], [420.3, -41.8], [429.1, -54.3], [435.4, -69.6],
  [441.2, -84.6], [444.9, -98.2], [453.0, -109.8], [461.2, -121.6], [466.2, -135.7],
  [468.1, -150.8], [467.7, -165.8], [467.5, -180.8], [467.4, -195.9], [468.2, -210.9],
  [474.3, -225.9], [479.5, -240.9], [477.7, -255.9], [471.4, -270.9], [468.7, -285.9],
  [469.1, -300.9], [469.6, -315.9], [470.0, -330.9], [470.4, -345.9], [469.0, -361.0],
  [463.2, -376.0], [456.9, -391.0], [454.4, -406.0], [457.5, -421.0], [464.8, -436.0],
  [472.0, -451.0], [475.2, -466.0], [476.2, -481.0], [477.3, -496.1], [478.5, -510.9],
  [478.0, -525.7], [478.3, -541.7], [478.6, -557.5], [473.3, -572.8], [461.5, -582.4],
  [446.1, -585.8], [431.2, -586.3], [414.9, -588.8], [399.7, -590.4], [384.6, -591.3],
  [369.5, -591.9], [354.1, -592.3], [339.6, -592.1], [324.5, -595.3], [311.4, -604.2],
  [303.3, -617.2], [299.0, -632.3], [295.2, -647.9], [287.6, -663.0], [275.8, -672.3],
  [262.0, -677.3], [247.5, -678.7], [231.0, -677.1], [216.2, -673.8], [201.0, -675.1],
  [186.5, -679.7], [171.4, -681.2], [157.1, -681.8], [143.1, -686.4], [131.5, -696.0],
  [120.1, -705.9], [106.4, -714.2], [90.6, -716.2], [76.5, -709.4], [64.7, -698.6],
  [53.2, -689.5], [38.2, -684.0], [25.1, -676.2], [15.1, -664.9], [7.6, -651.9],
  [2.4, -637.9], [0.3, -623.0], [-0.2, -608.0], [0.0, -593.0], [0.0, -578.0],
  [0.0, -563.0],
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
