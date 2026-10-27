/**
 * Retrouve les quatre roues d'un modèle, sans connaître son authoring.
 *
 * Module pur (ni Three.js, ni Vite) : la détection est ainsi testable hors
 * navigateur, et `carModel.ts` n'a plus qu'à l'appliquer au modèle chargé.
 */

export interface Box3Data {
  min: [number, number, number];
  max: [number, number, number];
}

export interface WheelCandidate {
  /** Nom du nœud (ou de sa chaîne de parents), pour repérer les roues nommées. */
  name: string;
  box: Box3Data;
}

export interface WheelPick {
  /** 0 FL, 1 FR, 2 RL, 3 RR — en repère voiture (nez vers -Z, +X à droite). */
  corner: 0 | 1 | 2 | 3;
  hub: [number, number, number];
  radius: number;
}

/** Un nœud ou un matériau qui sent la roue : jante, pneu, disque, frein. */
export const WHEEL_NAME =
  /wheel|tyre|tire|roue|jante|\brim\b|rims|hub|disk|disc|brake|etrier|étrier/i;

/**
 * D'abord les candidats dont le nom sent la roue (les modèles de Sketchfab en
 * portent souvent : `Wheel1A`, `bone_wheel_BL`, `SM_Hub_RR`, `rims#wheelBL`),
 * sinon tous ceux qui en ont la forme : un objet rond, bas, dans un coin du
 * modèle. Les quatre coins doivent être pourvus, sinon on renvoie null — mieux
 * vaut la voiture de secours qu'une roue fantôme au milieu de la caisse.
 */
export function pickWheels(candidates: WheelCandidate[], body: Box3Data): WheelPick[] | null {
  const size = [0, 1, 2].map((axis) => body.max[axis] - body.min[axis]);
  const length = Math.max(size[0], size[2]);
  const centre = [0, 1, 2].map((axis) => (body.min[axis] + body.max[axis]) / 2);
  const groundY = body.min[1];

  const shaped = candidates
    .map((candidate) => {
      const span = [0, 1, 2].map((axis) => candidate.box.max[axis] - candidate.box.min[axis]);
      const mid = [0, 1, 2].map((axis) => (candidate.box.min[axis] + candidate.box.max[axis]) / 2);
      const diameter = Math.max(span[0], span[1], span[2]);
      const sorted = [...span].sort((a, b) => b - a);
      const box = { name: candidate.name, span, mid, diameter, sorted };
      // Un pneu : rond (les deux grandes cotes se ressemblent), pas épais, bas
      // sur le véhicule et de taille plausible devant la longueur du modèle.
      if (diameter < length * 0.05 || diameter > length * 0.34) return null;
      if (sorted[1] < sorted[0] * 0.45) return null;
      if (sorted[2] > sorted[0] * 0.8) return null;
      if (mid[1] > groundY + size[1] * 0.5) return null;
      return box;
    })
    .filter((box): box is NonNullable<typeof box> => box !== null);

  const named = shaped.filter((box) => WHEEL_NAME.test(box.name));
  const pool = named.length >= 4 ? named : shaped;
  if (pool.length < 4) return null;

  const corners: { corner: 0 | 1 | 2 | 3; boxes: typeof pool }[] = [
    { corner: 0, boxes: [] },
    { corner: 1, boxes: [] },
    { corner: 2, boxes: [] },
    { corner: 3, boxes: [] },
  ];
  for (const box of pool) {
    const right = box.mid[0] >= centre[0];
    const rear = box.mid[2] >= centre[2];
    const corner = (right ? 1 : 0) + (rear ? 2 : 0);
    corners[corner].boxes.push(box);
  }
  if (corners.some((entry) => entry.boxes.length === 0)) return null;

  // Première passe : la plus grosse pièce ronde de chaque coin. Sur certains
  // modèles c'est un garde-boue, un rétroviseur bas ou une pièce de carrosserie
  // — d'où la deuxième passe.
  const first = corners.map(({ boxes }) =>
    boxes.reduce((best, box) => (box.diameter > best.diameter ? box : best), boxes[0]),
  );

  // Deuxième passe : on recale chaque coin sur la géométrie **médiane** des
  // quatre. Une voiture est symétrique : le miroir des trois autres coins dit
  // où est vraiment le quatrième moyeu, et de quel rayon.
  const halfTrack = median(first.map((box) => Math.abs(box.mid[0])));
  const axleZ = [
    median([first[0].mid[2], first[1].mid[2]]),
    median([first[2].mid[2], first[3].mid[2]]),
  ];
  const hubY = median(first.map((box) => box.mid[1]));
  const radius = median(first.map((box) => box.diameter)) / 2;

  const picks: WheelPick[] = corners.map(({ corner, boxes }) => {
    const targetZ = axleZ[corner < 2 ? 0 : 1];
    const targetX = halfTrack * (corner === 1 || corner === 3 ? 1 : -1);
    let best = boxes[0];
    let bestCost = Infinity;
    for (const box of boxes) {
      const cost =
        Math.abs(box.mid[0] - targetX) / Math.max(halfTrack, 1e-3) +
        Math.abs(box.mid[2] - targetZ) / Math.max(length, 1e-3) +
        Math.abs(box.mid[1] - hubY) / Math.max(size[1], 1e-3) +
        Math.abs(box.diameter - radius * 2) / Math.max(radius * 2, 1e-3);
      if (cost < bestCost) {
        bestCost = cost;
        best = box;
      }
    }
    const hub: [number, number, number] = [best.mid[0], best.mid[1], best.mid[2]];
    return { corner, hub, radius };
  });
  return picks.sort((a, b) => a.corner - b.corner);
}

/** Médiane : résiste à un coin aberrant là où la moyenne le suivrait. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
