/**
 * La voie des stands, *derrière* le muret.
 *
 * La première version la peignait entre la piste et le muret : le joueur
 * roulait dessus en pleine ligne droite et, comme le sol physique ne connaît
 * que l'asphalte de la piste, il y glissait comme sur l'herbe. Ici la voie est
 * du bon côté — le muret la sépare de la piste, les garages la bordent — et
 * `insidePit` dit à la physique que tout cet espace est du bitume.
 *
 * Module pur : ni three ni Rapier, pour que les tests puissent vérifier que les
 * trous du muret tombent exactement sur les raccordements.
 */
import { WALL_OFFSET, WALL_THICK } from './trackLayout.ts';

/** Axe de la voie, en coordonnées monde (la ligne droite est à x = 0). */
export const PIT_LANE_X = -24.2;
/** Demi-largeur de la voie. */
export const PIT_LANE_HALF = 4.3;
/** Étendue de la voie le long de la ligne droite. */
export const PIT_LANE_FROM = -515;
export const PIT_LANE_TO = -265;
/** Face intérieure du muret (côté piste) et face extérieure (côté stands). */
export const PIT_WALL_X = -WALL_OFFSET;
export const PIT_WALL_OUTER = -(WALL_OFFSET + WALL_THICK / 2);
/** Façade des garages, et profondeur des boxes vers l'extérieur. */
export const GARAGE_FRONT_X = -32.4;
export const GARAGE_DEPTH = 14;
/** Emplacements : huit boxes, un toutes les 13,2 m. */
export const STALL_FIRST_Z = -474;
export const STALL_PITCH = 13.2;
export const STALL_COUNT = 8;
/** Longueur d'un box le long de la voie. */
export const STALL_LENGTH = 8.4;
/** Dalle de la voie et des garages, un peu plus longue que la voie peinte. */
export const PIT_APRON_FROM = -522;
export const PIT_APRON_TO = -258;

/**
 * Raccordements piste ↔ stands : deux ouvertures dans le muret. La première
 * sert d'entrée juste après la ligne, la seconde de sortie avant le premier
 * virage. Elles traversent le dégagement herbeux, qui devient du bitume.
 */
export const PIT_THROATS = [
  { from: -522, to: -498 },
  { from: -282, to: -258 },
] as const;
/** Bord intérieur d'un raccordement : le bord extérieur des vibreurs. */
export const PIT_THROAT_INNER_X = -6;

export interface PitRect {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

/** Toutes les surfaces roulables des stands, en rectangles monde. */
export function pitPavedRects(): PitRect[] {
  const rects: PitRect[] = [
    // La dalle des stands : de la façade des garages au muret.
    { x0: GARAGE_FRONT_X, x1: PIT_WALL_OUTER, z0: PIT_APRON_FROM, z1: PIT_APRON_TO },
  ];
  for (const throat of PIT_THROATS) {
    rects.push({
      x0: PIT_THROAT_INNER_X,
      x1: PIT_WALL_OUTER,
      z0: throat.from,
      z1: throat.to,
    });
  }
  return rects;
}

function inRect(x: number, z: number, rect: PitRect): boolean {
  // Les rectangles sont écrits dans le sens de lecture de chacun : les deux
  // bornes sont donc triées ici, sinon une traversée notée de la voie vers la
  // piste ne contiendrait aucun point.
  return (
    x >= Math.min(rect.x0, rect.x1) &&
    x <= Math.max(rect.x0, rect.x1) &&
    z >= Math.min(rect.z0, rect.z1) &&
    z <= Math.max(rect.z0, rect.z1)
  );
}

/** Vrai si ce point est du bitume de stands (voie, dalle ou raccordement). */
export function insidePit(x: number, z: number): boolean {
  for (const rect of pitPavedRects()) {
    if (inRect(x, z, rect)) return true;
  }
  return false;
}

/**
 * Vrai si le segment de muret qui va de `az` à `bz` doit être supprimé : une
 * ouverture de raccordement sur la ligne droite, côté gauche. Le test porte sur
 * les deux extrémités pour ne pas laisser un moignon de mur au milieu du
 * passage.
 */
export function pitWallGap(axisX: number, az: number, bz: number): boolean {
  // Seule la ligne droite est concernée : ailleurs, la voie n'existe pas.
  if (axisX < -6 || axisX > 6) return false;
  const low = Math.min(az, bz);
  const high = Math.max(az, bz);
  for (const throat of PIT_THROATS) {
    if (low >= throat.from && high <= throat.to) return true;
  }
  return false;
}

/** Centre d'un box, en z. */
export function stallCentre(index: number): number {
  return STALL_FIRST_Z + index * STALL_PITCH;
}

/** Largeur du couloir de ravitaillement, côté garages. */
export function stallInnerX(): number {
  return GARAGE_FRONT_X + 0.6;
}

/** Largeur de la voie rapide, côté muret. */
export function pitFastLaneX(): number {
  return PIT_LANE_X + PIT_LANE_HALF - 1.55;
}
