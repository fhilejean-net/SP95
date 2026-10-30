/**
 * Le choc avec le cerf, isolé du rendu et de Rapier pour rester testable.
 *
 * Un cerf de cent kilos ne peut pas arrêter une caisse de une tonne trois, mais
 * l'impact doit se sentir : la voiture perd un peu moins de la moitié de sa
 * vitesse, et ne repart jamais en arrière.
 */

/** Part de la vitesse conservée après avoir fauché la bête. */
export const DEER_IMPACT_KEEP = 0.55;

/** Demi-largeur et demi-longueur de la caisse, élargies du corps de la bête. */
const HIT_HALF_WIDTH = 1.6;
const HIT_HALF_LENGTH = 3.4;

export interface DeerHit {
  /** Vecteur voiture → cerf, en mètres, à plat. */
  dx: number;
  dz: number;
  /** Cap de la voiture, normalisé. */
  forwardX: number;
  forwardZ: number;
}

/** Vrai quand le cerf est dans l'empreinte de la caisse, pas juste à côté. */
export function deerWithinCarFootprint(hit: DeerHit): boolean {
  const lateral = hit.dx * -hit.forwardZ + hit.dz * hit.forwardX;
  const along = hit.dx * hit.forwardX + hit.dz * hit.forwardZ;
  return Math.abs(lateral) <= HIT_HALF_WIDTH && Math.abs(along) <= HIT_HALF_LENGTH;
}

/** Vitesse restante (m/s) après le choc, jamais négative. */
export function speedAfterDeerImpact(speed: number): number {
  return Math.max(0, speed) * DEER_IMPACT_KEEP;
}
