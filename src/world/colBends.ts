/**
 * Virages serrés du col : bandes transversales de guidage et places
 * d'évitement.
 *
 * Sur le terrain, un virage serré porte deux choses que le tracé seul ne donne
 * pas :
 *
 * - des **bandes blanches** perpendiculaires à l'axe, du côté intérieur. Elles
 *   naissent courtes à l'entrée du virage et prennent près d'une demi-voie au
 *   point de corde. C'est le repère que les motards lisent pour ne pas mettre
 *   les roues dans la zone coupée ;
 * - une **place d'évitement**, un élargissement de quelques mètres côté
 *   intérieur, assez long pour garer un véhicule hors de la chaussée.
 *
 * Les deux se déduisent de la courbure du tracé : ni l'un ni l'autre n'est
 * cartographié dans les données OSM du corridor (un seul parking y figure,
 * celui de l'hôtel). Ce module ne touche pas à la scène : il rend des plans en
 * coordonnées monde, que `mollendruz.ts` pose ensuite sur le terrain.
 */

export interface BendPoint {
  s: number;
  x: number;
  y: number;
  z: number;
  width: number;
  bank: number;
}

export interface Bend {
  /** Première abscisse où le rayon passe sous le seuil. */
  startS: number;
  /** Dernière abscisse sous le seuil. */
  endS: number;
  /** Abscisse du point de corde, là où le rayon est le plus court. */
  apexS: number;
  /** Rayon au point de corde, en mètres. */
  radius: number;
  /** +1 : virage à droite dans le sens du tracé, -1 : à gauche. */
  turn: 1 | -1;
}

/** Un point du tracé, avec sa tangente unitaire. */
export interface Station {
  s: number;
  x: number;
  y: number;
  z: number;
  width: number;
  bank: number;
  tx: number;
  tz: number;
}

/** Bande transversale : offsets le long de la normale, du bord vers le centre. */
export interface BendBand {
  s: number;
  /** Offset du pied de la bande, posé sur la rive intérieure. */
  from: number;
  /** Offset de la pointe, vers l'axe. */
  to: number;
}

export interface LaybyPlan {
  bend: Bend;
  /** Emprise au sol, dans le sens du tracé puis en retour. */
  outline: [number, number][];
}

/** Rayon sous lequel un virage compte comme serré. */
export const BEND_RADIUS_M = 45;
/** Deux tronçons du même sens séparés de moins que ça forment un seul virage. */
const BEND_MERGE_M = 35;
/** En dessous, ce n'est pas un virage à marquer mais un pli du relevé. */
const MIN_BEND_LENGTH_M = 6;
/** Pas des bandes le long du virage. */
export const BAND_SPACING_M = 3.2;
/** Longueur d'une bande à l'entrée du virage. */
export const BAND_MIN_M = 0.28;
/** Longueur d'une bande au point de corde : une demi-voie de 3,25 m. */
export const BAND_MAX_M = 1.62;
/** Retrait du pied de bande par rapport à la rive peinte. */
const BAND_INSET_M = 0.28;
/** Seuls les virages plus serrés que ça reçoivent une place d'évitement. */
export const LAYBY_RADIUS_M = 36;
/** Largeur de l'évitement au point de corde, hors chaussée. */
export const LAYBY_WIDTH_M = 3.8;
/** Demi-longueur de l'évitement, raccords compris. */
const LAYBY_HALF_LENGTH_M = 15;
/** Longueur du raccord en entrée et en sortie d'évitement. */
const LAYBY_TAPER_M = 6.5;
/** Pas de découpe du contour de l'évitement. */
const LAYBY_STEP_M = 2;

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Courbure signée en chaque point du tracé, en 1/m. */
export function curvatures(points: BendPoint[]): number[] {
  const heading = points.map((_, i) => {
    const a = points[Math.max(0, i - 1)];
    const b = points[Math.min(points.length - 1, i + 1)];
    return Math.atan2(b.x - a.x, b.z - a.z);
  });
  for (let i = 1; i < heading.length; i++) {
    while (heading[i] - heading[i - 1] > Math.PI) heading[i] -= Math.PI * 2;
    while (heading[i] - heading[i - 1] < -Math.PI) heading[i] += Math.PI * 2;
  }
  return points.map((_, i) => {
    const a = Math.max(0, i - 1);
    const b = Math.min(points.length - 1, i + 1);
    const span = points[b].s - points[a].s;
    return span > 1e-6 ? (heading[b] - heading[a]) / span : 0;
  });
}

/** Virages dont le rayon passe sous `BEND_RADIUS_M`. */
export function findBends(points: BendPoint[]): Bend[] {
  const curvature = curvatures(points);
  const groups: number[][] = [];
  for (let i = 0; i < points.length; i++) {
    if (Math.abs(curvature[i]) <= 1 / BEND_RADIUS_M) continue;
    const last = groups[groups.length - 1];
    const previous = last?.[last.length - 1];
    // Une épingle peut changer de sens sans dépasser le seuil entre deux
    // échantillons : on coupe aussi quand le sens de rotation s'inverse.
    if (
      !last ||
      previous === undefined ||
      points[i].s - points[previous].s > BEND_MERGE_M ||
      (curvature[i] > 0) !== (curvature[previous] > 0)
    ) {
      groups.push([]);
    }
    groups[groups.length - 1].push(i);
  }
  return groups
    .filter((group) => points[group[group.length - 1]].s - points[group[0]].s >= MIN_BEND_LENGTH_M)
    .map((group) => {
      const apex = group.reduce(
        (best, i) => (Math.abs(curvature[i]) > Math.abs(curvature[best]) ? i : best),
        group[0],
      );
      return {
        startS: points[group[0]].s,
        endS: points[group[group.length - 1]].s,
        apexS: points[apex].s,
        radius: 1 / Math.abs(curvature[apex]),
        turn: (curvature[apex] > 0 ? 1 : -1) as 1 | -1,
      };
    });
}

/** Point, largeur et tangente du tracé à l'abscisse `s`. */
export function stationAt(points: BendPoint[], s: number): Station {
  let i = 0;
  while (i < points.length - 2 && points[i + 1].s < s) i++;
  const a = points[i];
  const b = points[i + 1] ?? a;
  const span = b.s - a.s;
  const t = span > 1e-6 ? Math.min(1, Math.max(0, (s - a.s) / span)) : 0;
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const length = Math.hypot(dx, dz) || 1;
  return {
    s,
    x: a.x + dx * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + dz * t,
    width: a.width + (b.width - a.width) * t,
    bank: a.bank + (b.bank - a.bank) * t,
    tx: dx / length,
    tz: dz / length,
  };
}

/** Point du plan décalé de `offset` mètres sur la normale droite du tracé. */
export function offsetPoint(station: Station, offset: number): [number, number] {
  return [station.x + station.tz * offset, station.z - station.tx * offset];
}

/** Courbure lue à une abscisse, interpolée entre deux échantillons. */
function curvatureAt(points: BendPoint[], curvature: number[], s: number): number {
  let i = 0;
  while (i < points.length - 2 && points[i + 1].s < s) i++;
  const a = points[i];
  const b = points[i + 1] ?? a;
  const span = b.s - a.s;
  const t = span > 1e-6 ? Math.min(1, Math.max(0, (s - a.s) / span)) : 0;
  return curvature[i] + ((curvature[i + 1] ?? curvature[i]) - curvature[i]) * t;
}

/**
 * Bandes de guidage de chaque virage : elles partent de la rive intérieure et
 * s'allongent vers l'axe à mesure qu'on approche du point de corde.
 */
export function planBendBands(points: BendPoint[], bends: Bend[]): BendBand[] {
  const curvature = curvatures(points);
  const bands: BendBand[] = [];
  for (const bend of bends) {
    if (bend.endS - bend.startS < 8) continue;
    let peak = 0;
    for (let s = bend.startS; s <= bend.endS; s += 1) {
      peak = Math.max(peak, Math.abs(curvatureAt(points, curvature, s)));
    }
    if (peak <= 0) continue;
    for (let s = bend.startS; s <= bend.endS; s += BAND_SPACING_M) {
      const station = stationAt(points, s);
      const weight = Math.min(1, Math.abs(curvatureAt(points, curvature, s)) / peak);
      const length = BAND_MIN_M + (BAND_MAX_M - BAND_MIN_M) * weight;
      const inner = bend.turn * (station.width / 2 - BAND_INSET_M);
      bands.push({ s, from: inner, to: inner - bend.turn * length });
    }
  }
  return bands;
}

/** Emprise d'une place d'évitement, côté intérieur du virage. */
function laybyOutline(points: BendPoint[], bend: Bend): [number, number][] {
  const inner: [number, number][] = [];
  const outer: [number, number][] = [];
  const from = bend.apexS - LAYBY_HALF_LENGTH_M;
  for (let s = from; s <= bend.apexS + LAYBY_HALF_LENGTH_M + 1e-6; s += LAYBY_STEP_M) {
    const station = stationAt(points, s);
    // Raccord progressif aux deux bouts : la place se referme sur la rive.
    const taper = smoothstep(0, LAYBY_TAPER_M, Math.min(s - from, bend.apexS + LAYBY_HALF_LENGTH_M - s));
    const edge = bend.turn * (station.width / 2 - 0.05);
    inner.push(offsetPoint(station, edge));
    outer.push(offsetPoint(station, bend.turn * (station.width / 2 + LAYBY_WIDTH_M * taper)));
  }
  return [...inner, ...outer.reverse()];
}

/** Places d'évitement des virages les plus serrés. */
export function planLaybys(points: BendPoint[], bends: Bend[]): LaybyPlan[] {
  return bends
    .filter((bend) => bend.radius <= LAYBY_RADIUS_M)
    .map((bend) => ({ bend, outline: laybyOutline(points, bend) }));
}
