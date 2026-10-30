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
  /** Demi-largeur réellement mesurée du paquet de sommets, en unités du modèle. */
  halfWidth?: number;
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

/** Positions d'une pièce, déjà cuites en repère voiture. */
export interface WheelPart {
  positions: ArrayLike<number>;
  indices: ArrayLike<number>;
}

/**
 * Retrouve quatre moyeux dans des pièces qui contiennent plusieurs roues.
 *
 * La F1 livre ses quatre jantes dans un maillage par matière : la boîte d'une
 * telle pièce fait la taille de la voiture, et un découpage par quadrant
 * ramassait les demi-arbres avec les roues (des morceaux de deux mètres de
 * long). On regroupe donc les **sommets bas** en quatre paquets (k-means sur
 * x/z, amorcé par les quadrants) : les roues sont les seules masses basses et
 * extérieures, ce qui donne un moyeu par coin.
 *
 * Renvoie `null` si les paquets ne ressemblent pas à quatre roues : mieux vaut
 * des roues procédurales qu'un découpage au hasard.
 */
export function clusterWheels(
  parts: WheelPart[],
  body: Box3Data,
  options: { outboard?: number } = {},
): WheelPick[] | null {
  const outboard = options.outboard ?? 0;
  const size = [0, 1, 2].map((axis) => body.max[axis] - body.min[axis]);
  const length = Math.max(size[0], size[2]);
  const centre = [0, 1, 2].map((axis) => (body.min[axis] + body.max[axis]) / 2);
  if (!(length > 0)) return null;

  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  for (const part of parts) {
    const count = part.indices.length;
    const step = Math.max(1, Math.floor(count / 24000));
    for (let i = 0; i < count; i += step) {
      const vertex = part.indices[i] * 3;
      const x = part.positions[vertex];
      const y = part.positions[vertex + 1];
      const z = part.positions[vertex + 2];
      // Une roue touche le sol : tout ce qui est au-dessus de la ceinture de
      // caisse est un pare-brise, un aileron ou un casque.
      if (!(y <= centre[1])) continue;
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
      // Une roue est une masse *extérieure* et basse. Sans ce filtre, le
      // plancher et le moteur du kart noient les quatre paquets : le
      // regroupement rendait quatre quartiers de châssis, donc aucun moyeu.
      if (outboard > 0 && Math.abs(x - centre[0]) < size[0] * outboard) continue;
      xs.push(x);
      ys.push(y);
      zs.push(z);
    }
  }
  if (xs.length < 200) return null;

  // Amorçage : moyenne de chaque quadrant autour du centre de la caisse.
  const centres = [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ].map(([sx, sz]) => {
    let n = 0;
    let mx = 0;
    let mz = 0;
    for (let i = 0; i < xs.length; i++) {
      if ((xs[i] >= centre[0] ? 1 : -1) !== sx) continue;
      if ((zs[i] >= centre[2] ? 1 : -1) !== sz) continue;
      mx += xs[i];
      mz += zs[i];
      n++;
    }
    return n > 0 ? [mx / n, mz / n] : [centre[0] + sx * length * 0.3, centre[2] + sz * length * 0.3];
  });

  const assignment = new Int8Array(xs.length).fill(-1);
  for (let iteration = 0; iteration < 18; iteration++) {
    let moved = 0;
    for (let i = 0; i < xs.length; i++) {
      let best = 0;
      let bestDistance = Infinity;
      for (let k = 0; k < 4; k++) {
        const dx = xs[i] - centres[k][0];
        const dz = zs[i] - centres[k][1];
        const distance = dx * dx + dz * dz;
        if (distance < bestDistance) {
          bestDistance = distance;
          best = k;
        }
      }
      if (assignment[i] !== best) {
        assignment[i] = best;
        moved++;
      }
    }
    for (let k = 0; k < 4; k++) {
      let n = 0;
      let mx = 0;
      let mz = 0;
      for (let i = 0; i < xs.length; i++) {
        if (assignment[i] !== k) continue;
        mx += xs[i];
        mz += zs[i];
        n++;
      }
      if (n > 0) centres[k] = [mx / n, mz / n];
    }
    if (moved === 0) break;
  }

  const picks: WheelPick[] = [];
  const halfWidths: number[] = [];
  for (let k = 0; k < 4; k++) {
    let n = 0;
    let sumX = 0;
    let sumY = 0;
    let sumZ = 0;
    let minX = Infinity;
    let maxX = -Infinity;
    for (let i = 0; i < xs.length; i++) {
      if (assignment[i] !== k) continue;
      sumX += xs[i];
      sumY += ys[i];
      sumZ += zs[i];
      minX = Math.min(minX, xs[i]);
      maxX = Math.max(maxX, xs[i]);
      n++;
    }
    if (n < 50) return null;
    const hubX = sumX / n;
    const hubY = sumY / n;
    const hubZ = sumZ / n;
    let radius = 0;
    for (let i = 0; i < xs.length; i++) {
      if (assignment[i] !== k) continue;
      // Le rayon se lit dans le plan de la roue (y/z), pas en largeur.
      radius = Math.max(radius, Math.hypot(ys[i] - hubY, zs[i] - hubZ));
    }
    if (!(radius > length * 0.04) || !(radius < length * 0.25)) return null;
    const corner = ((hubX >= centre[0] ? 1 : 0) + (hubZ >= centre[2] ? 2 : 0)) as 0 | 1 | 2 | 3;
    const halfWidth = (maxX - minX) / 2;
    picks.push({ corner, hub: [hubX, hubY, hubZ], radius, halfWidth });
    halfWidths.push(halfWidth);
  }

  // Quatre coins distincts, sinon le regroupement a avalé deux roues ensemble.
  if (new Set(picks.map((pick) => pick.corner)).size !== 4) return null;
  const halfTrack = picks.reduce((sum, pick) => sum + Math.abs(pick.hub[0]), 0) / 4;
  if (!(halfTrack > length * 0.08)) return null;
  return picks.sort((a, b) => a.corner - b.corner);
}

/**
 * Retrouve quatre moyeux par les zones de contact au sol.
 *
 * Un kart n'a aucun nom de roue et ses six objets traversent toute la
 * voiture : ni les noms ni les boîtes ne disent où sont les roues. Ce qui les
 * trahit, c'est le sol — seules les roues y touchent. On prend donc la bande
 * la plus basse du modèle, on la regroupe en quatre paquets (x/z), puis on
 * mesure chaque roue sur la colonne de sommets qui lui correspond : sa hauteur
 * donne le diamètre, sa largeur donne la demi-largeur.
 */
export function contactHubs(parts: WheelPart[], body: Box3Data): WheelPick[] | null {
  const size = [0, 1, 2].map((axis) => body.max[axis] - body.min[axis]);
  const length = Math.max(size[0], size[2]);
  const centre = [0, 1, 2].map((axis) => (body.min[axis] + body.max[axis]) / 2);
  const groundY = body.min[1];
  if (!(length > 0) || !(size[0] > 0)) return null;

  const band = groundY + size[1] * 0.14;
  const xs: number[] = [];
  const zs: number[] = [];
  for (const part of parts) {
    const count = part.indices.length;
    const step = Math.max(1, Math.floor(count / 20000));
    for (let i = 0; i < count; i += step) {
      const vertex = part.indices[i] * 3;
      const y = part.positions[vertex + 1];
      if (!(y <= band)) continue;
      const x = part.positions[vertex];
      const z = part.positions[vertex + 2];
      if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
      xs.push(x);
      zs.push(z);
    }
  }
  if (xs.length < 120) return null;

  const centres = [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ].map(([sx, sz]) => {
    let n = 0;
    let mx = 0;
    let mz = 0;
    for (let i = 0; i < xs.length; i++) {
      if ((xs[i] >= centre[0] ? 1 : -1) !== sx) continue;
      if ((zs[i] >= centre[2] ? 1 : -1) !== sz) continue;
      mx += xs[i];
      mz += zs[i];
      n++;
    }
    return n > 0 ? [mx / n, mz / n] : [centre[0] + sx * length * 0.3, centre[2] + sz * length * 0.3];
  });

  const assignment = new Int8Array(xs.length).fill(-1);
  for (let iteration = 0; iteration < 18; iteration++) {
    let moved = 0;
    for (let i = 0; i < xs.length; i++) {
      let best = 0;
      let bestDistance = Infinity;
      for (let k = 0; k < 4; k++) {
        const dx = xs[i] - centres[k][0];
        const dz = zs[i] - centres[k][1];
        const distance = dx * dx + dz * dz;
        if (distance < bestDistance) {
          bestDistance = distance;
          best = k;
        }
      }
      if (assignment[i] !== best) {
        assignment[i] = best;
        moved++;
      }
    }
    for (let k = 0; k < 4; k++) {
      let n = 0;
      let mx = 0;
      let mz = 0;
      for (let i = 0; i < xs.length; i++) {
        if (assignment[i] !== k) continue;
        mx += xs[i];
        mz += zs[i];
        n++;
      }
      if (n > 0) centres[k] = [mx / n, mz / n];
    }
    if (moved === 0) break;
  }

  const window = Math.max(size[0] * 0.15, length * 0.04);
  const picks: WheelPick[] = [];
  for (let k = 0; k < 4; k++) {
    let n = 0;
    let sumX = 0;
    let sumZ = 0;
    for (let i = 0; i < xs.length; i++) {
      if (assignment[i] !== k) continue;
      sumX += xs[i];
      sumZ += zs[i];
      n++;
    }
    if (n < 20) return null;
    const hubX = sumX / n;
    const hubZ = sumZ / n;

    // La colonne de sommets au-dessus de ce contact : c'est la roue.
    let top = groundY;
    let minX = Infinity;
    let maxX = -Infinity;
    for (const part of parts) {
      const count = part.indices.length;
      const step = Math.max(1, Math.floor(count / 30000));
      for (let i = 0; i < count; i += step) {
        const vertex = part.indices[i] * 3;
        const x = part.positions[vertex];
        const z = part.positions[vertex + 2];
        if (Math.abs(x - hubX) > window || Math.abs(z - hubZ) > window) continue;
        const y = part.positions[vertex + 1];
        if (y > top) top = y;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
    }
    const radius = (top - groundY) / 2;
    const halfWidth = (maxX - minX) / 2;
    if (!(halfWidth > 0)) return null;
    const corner = ((hubX >= centre[0] ? 1 : 0) + (hubZ >= centre[2] ? 2 : 0)) as 0 | 1 | 2 | 3;
    picks.push({ corner, hub: [hubX, groundY + radius, hubZ], radius, halfWidth });
  }
  if (new Set(picks.map((pick) => pick.corner)).size !== 4) return null;

  // Une voiture est symétrique. Sur le kart, la carrosserie au-dessus des
  // roues avant gonflait leur hauteur (rayons 17,8 et 12,5 pour un même pneu) :
  // la médiane des quatre mesures redonne quatre roues identiques et des
  // moyeux alignés, au lieu de suivre le défaut du modèle.
  const radius = median(picks.map((pick) => pick.radius));
  const halfWidth = median(picks.map((pick) => pick.halfWidth ?? radius * 0.5));
  const halfTrack = median(picks.map((pick) => Math.abs(pick.hub[0] - centre[0])));
  const frontZ = median(picks.filter((pick) => pick.corner < 2).map((pick) => pick.hub[2]));
  const rearZ = median(picks.filter((pick) => pick.corner >= 2).map((pick) => pick.hub[2]));
  if (!(radius > length * 0.04) || !(radius < length * 0.25)) return null;
  if (!(halfTrack > length * 0.08)) return null;
  if (!(Math.abs(rearZ - frontZ) > length * 0.15)) return null;

  return picks
    .map((pick) => ({
      corner: pick.corner,
      hub: [
        centre[0] + (pick.corner % 2 === 1 ? halfTrack : -halfTrack),
        groundY + radius,
        pick.corner >= 2 ? rearZ : frontZ,
      ] as [number, number, number],
      radius,
      halfWidth,
    }))
    .sort((a, b) => a.corner - b.corner);
}
