/**
 * L'aire de gymkhana, au centre du circuit.
 *
 * Une dalle de bitume posée dans l'infield, reliée à la ligne droite des stands
 * par un raccordement qui traverse le muret intérieur. Tout est à la cote du
 * sol : aucune bosse, aucune pente — on y glisse exactement comme sur la piste.
 *
 * Module pur : ni three ni Rapier, pour que le rendu et la physique partagent
 * la même géométrie et que les tests puissent vérifier le raccordement.
 */

export const DRIFT_PAD = {
  cx: 118,
  cz: -420,
  halfX: 64,
  halfZ: 50,
} as const;

/**
 * Le raccordement : une allée de vingt mètres qui part du bord intérieur de la
 * piste (x = 6,5, après le vibreur) et rejoint le bord ouest de la dalle.
 * C'est là que le muret s'ouvre.
 */
export const DRIFT_ACCESS = {
  fromX: 6.5,
  toX: DRIFT_PAD.cx - DRIFT_PAD.halfX,
  z0: -432,
  z1: -412,
} as const;

/** Rectangle de bitume de l'aire, en coordonnées monde. */
export interface DriftRect {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

export function driftPavedRects(): DriftRect[] {
  return [
    {
      x0: DRIFT_PAD.cx - DRIFT_PAD.halfX,
      x1: DRIFT_PAD.cx + DRIFT_PAD.halfX,
      z0: DRIFT_PAD.cz - DRIFT_PAD.halfZ,
      z1: DRIFT_PAD.cz + DRIFT_PAD.halfZ,
    },
    {
      x0: DRIFT_ACCESS.fromX,
      x1: DRIFT_ACCESS.toX + 1,
      z0: DRIFT_ACCESS.z0,
      z1: DRIFT_ACCESS.z1,
    },
  ];
}

/** Vrai si ce point est du bitume de gymkhana (dalle ou raccordement). */
export function insideDriftPad(x: number, z: number): boolean {
  for (const rect of driftPavedRects()) {
    if (x >= rect.x0 && x <= rect.x1 && z >= rect.z0 && z <= rect.z1) return true;
  }
  return false;
}

/**
 * Vrai si le segment de muret va de `az` à `bz` sur la ligne droite et tombe
 * dans l'ouverture du raccordement. Même principe que les trous de la voie des
 * stands : on teste les deux extrémités pour ne pas laisser de moignon.
 */
export function driftWallGap(axisX: number, az: number, bz: number): boolean {
  if (axisX < -6 || axisX > 6) return false;
  const low = Math.min(az, bz);
  const high = Math.max(az, bz);
  return low >= DRIFT_ACCESS.z0 && high <= DRIFT_ACCESS.z1;
}
