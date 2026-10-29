/**
 * La voie des stands, *derrière* le muret.
 *
 * La première version la peignait entre la piste et le muret : le joueur
 * roulait dessus en pleine ligne droite et, comme le sol physique ne connaît
 * que l'asphalte de la piste, il y glissait comme sur l'herbe. Ici la voie est
 * du bon côté — le muret la sépare de la piste, les garages la bordent — et
 * `insidePit` dit à la physique que tout cet espace est du bitume.
 *
 * Les raccordements sont **en biais**, comme sur un vrai circuit : un
 * raccordement perpendiculaire obligeait à s'arrêter presque net pour entrer
 * dans la voie. Chaque raccordement est un quadrilatère dont le bord côté piste
 * est décalé vers l'avant par rapport au bord côté voie ; on le prend donc en
 * accélérant, et on ressort sans casser la trajectoire.
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
export const PIT_LANE_FROM = -524;
export const PIT_LANE_TO = -258;
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
export const PIT_APRON_FROM = -540;
export const PIT_APRON_TO = -240;

/**
 * Un raccordement piste ↔ stands, en quadrilatère.
 *
 * La voiture roule vers les z croissants sur la ligne droite. Le bord côté piste
 * est donc **en avance** à l'entrée (on ouvre devant soi) et **en retard** à la
 * sortie (on se rabat devant soi). Autrement dit : à l'entrée, `outer` est plus
 * grand que `inner` ; à la sortie, c'est l'inverse. Les deux raccordements font
 * 22 m de large et se décalent de 22 m sur les 13 m qui séparent la piste de la
 * voie — soit une pente à 30°, qu'on prend sans lever le pied.
 */
export interface PitThroat {
  /** Bord du raccordement côté piste (x = PIT_THROAT_INNER_X). */
  innerFrom: number;
  innerTo: number;
  /** Bord du raccordement côté voie (x = PIT_WALL_OUTER). */
  outerFrom: number;
  outerTo: number;
}

export const PIT_THROATS: readonly PitThroat[] = [
  // Entrée, juste après la ligne : on ouvre devant la voiture.
  { innerFrom: -534, innerTo: -512, outerFrom: -512, outerTo: -490 },
  // Sortie, avant le premier virage : on se rabat devant la voiture.
  { innerFrom: -266, innerTo: -244, outerFrom: -288, outerTo: -266 },
];

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
      z0: Math.min(throat.innerFrom, throat.outerFrom),
      z1: Math.max(throat.innerTo, throat.outerTo),
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

/** Sommets d'un raccordement, dans l'ordre du pourtour. */
export function throatCorners(throat: PitThroat): { x: number; z: number }[] {
  return [
    { x: PIT_THROAT_INNER_X, z: throat.innerFrom },
    { x: PIT_WALL_OUTER, z: throat.outerFrom },
    { x: PIT_WALL_OUTER, z: throat.outerTo },
    { x: PIT_THROAT_INNER_X, z: throat.innerTo },
  ];
}

/** Vrai si le point est dans le quadrilatère (convexe), quel que soit le sens. */
function inQuad(x: number, z: number, corners: { x: number; z: number }[]): boolean {
  let positive = 0;
  let negative = 0;
  for (let index = 0; index < corners.length; index++) {
    const a = corners[index];
    const b = corners[(index + 1) % corners.length];
    const cross = (b.x - a.x) * (z - a.z) - (b.z - a.z) * (x - a.x);
    if (cross > 1e-9) positive += 1;
    else if (cross < -1e-9) negative += 1;
  }
  return positive === 0 || negative === 0;
}

/** Vrai si ce point est du bitume de stands (voie, dalle ou raccordement). */
export function insidePit(x: number, z: number): boolean {
  for (const rect of pitPavedRects()) {
    if (inRect(x, z, rect)) return true;
  }
  for (const throat of PIT_THROATS) {
    if (inQuad(x, z, throatCorners(throat))) return true;
  }
  return false;
}

/**
 * Vrai si le segment de muret qui va de `az` à `bz` doit être supprimé.
 *
 * Le muret est à x = PIT_WALL_OUTER, c'est-à-dire sur le bord *voie* du
 * raccordement : c'est donc la plage `outer` qui décide de l'ouverture. On
 * élargit de deux mètres pour ne pas laisser un moignon de mur au droit du
 * raccordement — le maillage avance par pas de trois mètres.
 */
export function pitWallGap(axisX: number, az: number, bz: number): boolean {
  // Seule la ligne droite est concernée : ailleurs, la voie n'existe pas.
  if (axisX < -6 || axisX > 6) return false;
  const low = Math.min(az, bz);
  const high = Math.max(az, bz);
  for (const throat of PIT_THROATS) {
    const from = Math.min(throat.outerFrom, throat.outerTo) - 2;
    const to = Math.max(throat.outerFrom, throat.outerTo) + 2;
    if (low >= from && high <= to) return true;
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
