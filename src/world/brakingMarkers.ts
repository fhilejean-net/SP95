/**
 * Panneaux de freinage : 150, 100 et 50 m avant chaque entrée de virage.
 *
 * Le circuit plat a des vibreurs et des bacs à gravier, mais aucun repère pour
 * freiner : on devine. Ces panneaux se posent dans le dégagement, entre le
 * vibreur et le mur, face à la voiture qui arrive — donc lisibles dans le sens
 * de la course, jamais à l'envers.
 *
 * Ce module ne dépend ni de three ni de Rapier : il ne calcule que le plan
 * (positions, caps, valeurs). Le rendu est dans `src/render/brakingBoards.ts`,
 * les tests lisent ce plan directement.
 */
import {
  HALF_WIDTH,
  KERB_WIDTH,
  TRACK,
  cornerRadius,
  type TrackSample,
} from './trackLayout.ts';

/** Valeurs annoncées avant une entrée de virage, en mètres. */
export const BRAKING_DISTANCES = [150, 100, 50] as const;
export type BrakingDistance = (typeof BRAKING_DISTANCES)[number];
/**
 * Rayon sous lequel un échantillon appartient au virage lui-même. 160 m est le
 * seuil des vibreurs ; pour freiner, on ne compte que la partie vraiment
 * courbe, sinon la moitié du tour serait « en virage » et presque aucune
 * annonce ne trouverait sa ligne droite.
 */
export const CORNER_RADIUS = 80;
/**
 * Deux portions courbes séparées par moins de cette distance sont le même
 * virage : une courbe à rayon variable ne doit pas recevoir deux jeux de
 * panneaux.
 */
export const CORNER_MERGE_GAP = 25;
/** Marge entre le panneau et l'entrée du virage, en mètres. */
export const MARKER_MARGIN = 12;
/** Ligne droite minimale pour qu'une entrée mérite au moins une annonce. */
export const MIN_STRAIGHT =
  BRAKING_DISTANCES[BRAKING_DISTANCES.length - 1] + MARKER_MARGIN;
/** Écart latéral des panneaux : dans le dégagement, après le vibreur. */
export const MARKER_LATERAL = HALF_WIDTH + KERB_WIDTH + 1.8;
/** Le panneau doit rester à cette distance de la face intérieure du mur. */
export const WALL_CLEARANCE = 1;

export interface BrakingMarker {
  x: number;
  z: number;
  /** Cap unitaire de la face du panneau : elle regarde la voiture qui arrive. */
  fx: number;
  fz: number;
  /** Valeur annoncée, en mètres. */
  value: BrakingDistance;
  /** Distance du panneau au départ, le long de l'axe. */
  distance: number;
  /** Distance de l'entrée du virage annoncé. */
  cornerDistance: number;
  /** Sens du virage annoncé : -1 à gauche, +1 à droite. */
  direction: -1 | 1;
  /** -1 à gauche de l'axe, +1 à droite. */
  side: -1 | 1;
  /** Décalage latéral signé, en mètres. */
  lateral: number;
}

export interface CornerEntry {
  /** Distance de l'entrée du virage, le long de l'axe. */
  distance: number;
  /** Longueur de ligne droite qui la précède, en mètres. */
  straight: number;
  /** Signe de la courbure : +1 le virage tourne à droite. */
  direction: -1 | 1;
}

function isCorner(sample: TrackSample): boolean {
  return cornerRadius(sample) < CORNER_RADIUS;
}

/**
 * Entrées de virage qui méritent des panneaux : une portion courbe précédée
 * d'assez de ligne droite pour que la plus longue annonce tombe dessus. Une
 * entrée collée à la sortie du virage précédent est ignorée — un panneau planté
 * au milieu d'une courbe annoncerait la mauvaise distance.
 */
export function cornerEntries(
  samples: TrackSample[] = TRACK.samples,
  total: number = TRACK.length,
): CornerEntry[] {
  const count = samples.length;
  if (count === 0) return [];
  // Le tableau commence sur une ligne droite : ainsi aucun virage ne chevauche
  // l'origine et les distances restent croissantes.
  const firstStraight = samples.findIndex((sample) => !isCorner(sample));
  const ordered =
    firstStraight > 0 ? [...samples.slice(firstStraight), ...samples.slice(0, firstStraight)] : samples;
  // Distance croissante depuis le premier échantillon, sans le saut de boucle.
  const along = ordered.map((sample, index) =>
    index === 0 ? 0 : (sample.distance - ordered[0].distance + total) % total,
  );

  const runs: { start: number; end: number }[] = [];
  for (let i = 0; i < count; i++) {
    if (!isCorner(ordered[i])) continue;
    const last = runs[runs.length - 1];
    if (last && i === last.end + 1) last.end = i;
    else runs.push({ start: i, end: i });
  }

  // Fusion des portions courbes voisines : un virage à rayon variable.
  const merged: { start: number; end: number }[] = [];
  for (const run of runs) {
    const previous = merged[merged.length - 1];
    if (previous && along[run.start] - along[previous.end] < CORNER_MERGE_GAP) {
      previous.end = run.end;
      continue;
    }
    merged.push({ ...run });
  }

  const entries: CornerEntry[] = [];
  let straightFrom = 0;
  for (const run of merged) {
    const entry = along[run.start];
    const straight = entry - straightFrom;
    if (straight >= MIN_STRAIGHT) {
      entries.push({
        distance: ordered[run.start].distance,
        straight,
        direction: ordered[run.start].curvature >= 0 ? 1 : -1,
      });
    }
    straightFrom = along[run.end];
  }
  return entries;
}

/** Échantillon interpolé à une distance donnée le long de l'axe. */
export function sampleAtDistance(
  distance: number,
  samples: TrackSample[] = TRACK.samples,
  total: number = TRACK.length,
): TrackSample {
  const wrapped = ((distance % total) + total) % total;
  let low = 0;
  let high = samples.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (samples[middle].distance <= wrapped) low = middle;
    else high = middle - 1;
  }
  const a = samples[low];
  const b = samples[(low + 1) % samples.length];
  const end = b.distance <= a.distance ? b.distance + total : b.distance;
  const span = Math.max(1e-6, end - a.distance);
  const t = Math.min(1, Math.max(0, (wrapped - a.distance) / span));
  const tx = a.tx + (b.tx - a.tx) * t;
  const tz = a.tz + (b.tz - a.tz) * t;
  const norm = Math.hypot(tx, tz) || 1;
  return {
    x: a.x + (b.x - a.x) * t,
    z: a.z + (b.z - a.z) * t,
    tx: tx / norm,
    tz: tz / norm,
    distance: wrapped,
    curvature: a.curvature + (b.curvature - a.curvature) * t,
  };
}

/**
 * Plan complet : pour chaque entrée retenue et chaque distance, un panneau de
 * part et d'autre de la piste, tourné vers la voiture qui approche et indiquant
 * le sens du virage annoncé.
 */
export function brakingMarkers(
  entries: CornerEntry[] = cornerEntries(),
  samples: TrackSample[] = TRACK.samples,
  total: number = TRACK.length,
): BrakingMarker[] {
  const markers: BrakingMarker[] = [];
  for (const entry of entries) {
    for (const value of BRAKING_DISTANCES) {
      // Une annonce qui tomberait dans le virage précédent est plus nuisible
      // qu'utile : on ne pose que celles que la ligne droite porte.
      if (value + MARKER_MARGIN > entry.straight) continue;
      const distance = (((entry.distance - value) % total) + total) % total;
      const sample = sampleAtDistance(distance, samples, total);
      // La face regarde *contre* la tangente : c'est le sens d'où l'on vient.
      const fx = -sample.tx;
      const fz = -sample.tz;
      for (const side of [-1, 1] as const) {
        markers.push({
          x: sample.x - sample.tz * MARKER_LATERAL * side,
          z: sample.z + sample.tx * MARKER_LATERAL * side,
          fx,
          fz,
          value,
          distance,
          cornerDistance: entry.distance,
          direction: entry.direction,
          side,
          lateral: MARKER_LATERAL * side,
        });
      }
    }
  }
  return markers;
}
