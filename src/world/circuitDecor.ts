/**
 * Règles de placement du décor du circuit plat, sans three ni Rapier.
 *
 * Deux défauts venaient de formules écrites au jugé :
 *
 * - un objet posé à 18 m de l'axe, dans l'intérieur d'un virage de 23 m de
 *   rayon, se retrouve sur une ligne de 5 m de rayon : les panneaux voisins se
 *   chevauchent et se coupent. `offsetFits` refuse ces places ;
 * - un bac à gravier allumé d'un coup au seuil de rayon produit une plaque
 *   rectangulaire collée sur l'herbe. `gravelFill` et `gravelRuns` donnent une
 *   largeur qui pousse avec le serrage du virage, puis s'éteint sur ses extrémités.
 */
import { cornerRadius, type TrackSample } from './trackLayout.ts';

/**
 * Rayon minimal de la ligne d'offset pour qu'un objet plat posé dessus garde une
 * face regardable. En dessous, la ligne se replie : le panneau s'écrase sur son
 * voisin.
 */
export const MIN_OFFSET_RADIUS = 14;

/** Rayon sous lequel un virage mérite un bac à gravier. */
export const GRAVEL_RADIUS = 110;
/** Rayon sous lequel le bac occupe toute la largeur du dégagement. */
export const GRAVEL_FULL_RADIUS = 82;
/** Longueur sur laquelle le bac s'ouvre et se referme, en mètres. */
export const GRAVEL_TAPER = 18;

/** Côté extérieur du virage : +1 à droite de l'axe, -1 à gauche. */
export function outsideOf(sample: TrackSample): 1 | -1 {
  return sample.curvature > 0 ? -1 : 1;
}

/**
 * Vrai si un objet plat posé à cet écart latéral ne se replie pas sur lui-même.
 * Côté extérieur d'un virage la ligne s'ouvre (elle est toujours valide) ;
 * côté intérieur elle se referme, et c'est ce rayon-là qu'on mesure.
 */
export function offsetFits(sample: TrackSample, lateral: number): boolean {
  const radius = cornerRadius(sample);
  if (!Number.isFinite(radius)) return true;
  const side = lateral >= 0 ? 1 : -1;
  // Seul l'intérieur du virage referme la ligne.
  if (Math.sign(sample.curvature) !== side) return true;
  return radius - Math.abs(lateral) >= MIN_OFFSET_RADIUS;
}

/**
 * Remplissage du bac à gravier à cet échantillon, de 0 (pas de bac) à 1 (toute
 * la largeur du dégagement). La largeur suit le serrage : un virage à 110 m n'a
 * qu'un liséré, une épingle l'occupe entièrement.
 */
export function gravelFill(sample: TrackSample): number {
  const radius = cornerRadius(sample);
  if (radius >= GRAVEL_RADIUS) return 0;
  const fill = (GRAVEL_RADIUS - radius) / (GRAVEL_RADIUS - GRAVEL_FULL_RADIUS);
  return Math.min(1, Math.max(0, fill));
}

export interface GravelRun {
  /** Indice du premier échantillon du bac. */
  start: number;
  /** Indice du dernier échantillon du bac. */
  end: number;
  /** Côté du bac : extérieur du virage. */
  side: 1 | -1;
}

/**
 * Portions continues de piste qui portent un bac à gravier, toujours sur
 * l'extérieur du virage. Deux bacs séparés par moins de trois échantillons sont
 * le même bac (une courbe à rayon variable).
 */
export function gravelRuns(samples: TrackSample[]): GravelRun[] {
  const runs: GravelRun[] = [];
  const count = samples.length;
  const isTrap = (index: number): boolean => gravelFill(samples[index]) > 0;
  // On démarre sur un échantillon sans bac pour ne pas couper une portion qui
  // chevauche l'origine de la boucle.
  let first = samples.findIndex((_, index) => !isTrap(index));
  if (first < 0) first = 0;
  for (let step = 0; step < count; step++) {
    const index = (first + step) % count;
    if (!isTrap(index)) continue;
    const previousIndex = (index - 1 + count) % count;
    const last = runs[runs.length - 1];
    // Le sillon précédent finit juste avant : on prolonge.
    if (last && (previousIndex === last.end || (last.end === count - 1 && index === 0))) {
      last.end = index;
      continue;
    }
    runs.push({ start: index, end: index, side: outsideOf(samples[index]) });
  }
  // Les portions d'un même bac que la boucle coupe en deux sont recollées.
  const firstRun = runs[0];
  const lastRun = runs[runs.length - 1];
  if (runs.length > 1 && lastRun && firstRun && lastRun.end === count - 1 && firstRun.start === 0) {
    firstRun.start = lastRun.start;
    runs.pop();
  }
  return runs;
}

/**
 * Remplissage effectif dans un bac : la largeur du rayon, éteinte sur les
 * `GRAVEL_TAPER` premiers et derniers mètres pour que le bord ne soit pas une
 * arête vive au milieu de l'herbe.
 */
export function gravelFillAt(samples: TrackSample[], run: GravelRun, index: number): number {
  const base = gravelFill(samples[index]);
  if (base === 0) return 0;
  const along = index >= run.start ? index - run.start : index + samples.length - run.start;
  const back = index <= run.end ? run.end - index : run.end + samples.length - index;
  // Pas réel entre deux échantillons du bac, pour exprimer la pente en mètres.
  const a = samples[run.start];
  const b = samples[(run.start + 1) % samples.length];
  const step = Math.max(1, Math.hypot(b.x - a.x, b.z - a.z));
  const taperSamples = Math.max(1, Math.round(GRAVEL_TAPER / step));
  const ramp = Math.min(1, Math.min(along, back) / taperSamples);
  // Courbe douce : un bac qui s'ouvre linéairement se lit encore comme un coin.
  return base * ramp * ramp * (3 - 2 * ramp);
}
