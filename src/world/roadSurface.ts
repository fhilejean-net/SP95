import * as THREE from 'three';

/**
 * Surface roulable du circuit, reconstruite à partir des triangles d'asphalte.
 *
 * Le modèle est un relevé de Suzuka : 51 m de dénivelé, des tabliers qui se
 * croisent en huit, des dalles de trente mètres pour quatre sommets et des cotes
 * quantifiées. Deux défauts en sortaient, tous deux visibles au volant :
 *
 * - Une grille bâtie par *primitive* mélange les tabliers quand un même maillage
 *   porte le pont et la route du dessous. Un quad reliait alors les deux niveaux
 *   par une rampe à 257 % : c'est le monticule invisible qui envoyait la voiture
 *   dans les panneaux, puis la laissait retomber à travers la piste.
 * - Un quad n'était émis que si ses quatre coins appartenaient au maillage : au
 *   bord de l'asphalte, une bande de trois mètres n'avait aucune collision et la
 *   voiture y tombait.
 *
 * Ici les triangles sont d'abord soudés en **tabliers** (composantes connexes
 * par position), puis chaque tablier reçoit sa propre grille, lissée et fermée
 * sur elle-même. Aucun quad ne franchit donc deux niveaux, et la grille est
 * close partout où l'asphalte existe. Un quad dont les coins s'écartent de plus
 * de `MAX_QUAD_SPREAD` reste une anomalie de relevé : il est écarté plutôt que
 * de servir de tremplin.
 */

/** Case de la grille, en mètres. */
const ROAD_CELL = 3;
/**
 * Écart de cote toléré entre les coins d'un quad. Une route de course ne dépasse
 * pas 15 % de pente, soit 0,45 m par case ; 1,6 m laisse passer les raccords de
 * vibreurs et refuse tout ce qui relie deux tabliers.
 */
const MAX_QUAD_SPREAD = 1.6;
/**
 * Écart maximal d'un nœud à la médiane de son voisinage, par passe de
 * limitation. Le lissage médian laisse passer des bosses d'un mètre au raccord
 * de deux tabliers — de quoi envoyer la voiture dans les panneaux ; trois passes
 * à 30 cm ramènent la piste sous 20 % de pente sans toucher aux montées
 * régulières, où la médiane vaut la cote du nœud.
 */
const MAX_STEP = 0.3;
const LIMIT_PASSES = 3;
/** Deux sommets plus proches que ça sont le même point du maillage. */
const WELD = 0.01;
/** Bucket de la requête de cote, en mètres. */
const QUERY_CELL = 8;
/** Épaisseur au-dessus du sol en dessous de laquelle rien ne peut bloquer. */
const PHANTOM_MIN_LIFT = 0.08;
/** Au-delà, ce n'est plus un obstacle posé sur la piste (pont, passerelle). */
const PHANTOM_MAX_LIFT = 3.5;

export interface RoadSurface {
  vertices: Float32Array;
  indices: Uint32Array;
  triangles: number;
  /** Pente la plus forte entre deux nœuds d'un même tablier, en %. */
  maxGrade: number;
  /** Tabliers distincts trouvés dans l'asphalte. */
  decks: number;
  /** Quads écartés parce qu'ils reliaient deux niveaux. */
  dropped: number;
}

function nodeKey(i: number, j: number): number {
  return (i + 100000) * 1000000 + (j + 100000);
}

function nodeCell(key: number): [number, number] {
  return [Math.floor(key / 1000000) - 100000, (key % 1000000) - 100000];
}

/** Cote médiane : un vibreur isolé ne tire pas la trame à lui. */
function median(values: number[]): number {
  values.sort((a, b) => a - b);
  return values[values.length >> 1];
}

export function buildRoadSurface(meshes: THREE.Mesh[]): RoadSurface {
  const point = new THREE.Vector3();
  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  /** Triangles du fichier, en indices globaux de sommet. */
  const faces: number[] = [];

  for (const mesh of meshes) {
    const positions = mesh.geometry.attributes.position;
    if (!positions || positions.count < 3) continue;
    const start = xs.length;
    for (let i = 0; i < positions.count; i++) {
      point.fromBufferAttribute(positions, i).applyMatrix4(mesh.matrixWorld);
      xs.push(point.x);
      ys.push(point.y);
      zs.push(point.z);
    }
    const index = mesh.geometry.index;
    if (index) {
      for (let i = 0; i + 2 < index.count; i += 3) {
        faces.push(start + index.getX(i), start + index.getX(i + 1), start + index.getX(i + 2));
      }
    } else {
      for (let i = 0; i + 2 < positions.count; i += 3) {
        faces.push(start + i, start + i + 1, start + i + 2);
      }
    }
  }

  // 1. Soudure par position : deux primitives voisines partagent la même arête
  // logique sans partager leurs indices, et les tuiles du fichier sont
  // quantifiées. Sans cette soudure, un tablier se couperait à chaque couture.
  const total = xs.length;
  const parent = new Int32Array(total);
  for (let i = 0; i < total; i++) parent[i] = i;
  const find = (value: number): number => {
    let root = value;
    while (parent[root] !== root) root = parent[root];
    while (parent[value] !== root) {
      const next = parent[value];
      parent[value] = root;
      value = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };
  const welded = new Map<string, number>();
  for (let i = 0; i < total; i++) {
    const key = `${Math.round(xs[i] / WELD)}:${Math.round(ys[i] / WELD)}:${Math.round(zs[i] / WELD)}`;
    const other = welded.get(key);
    if (other === undefined) welded.set(key, i);
    else union(other, i);
  }
  welded.clear();

  // 2. Tabliers : les triangles reliés par au moins un sommet soudé.
  const byRoot = new Map<number, number[]>();
  for (let f = 0; f < faces.length; f += 3) {
    union(faces[f], faces[f + 1]);
    union(faces[f + 1], faces[f + 2]);
  }
  for (let f = 0; f < faces.length; f += 3) {
    const root = find(faces[f]);
    const list = byRoot.get(root);
    if (list) list.push(f);
    else byRoot.set(root, [f]);
  }

  const vertices: number[] = [];
  const indices: number[] = [];
  let maxGrade = 0;
  let dropped = 0;
  let decks = 0;

  for (const deckFaces of byRoot.values()) {
    if (deckFaces.length === 0) continue;
    // 3. Rasterisation : chaque nœud de la grille prend la cote du triangle du
    // tablier qui le contient, lue barycentriquement.
    const nodes = new Map<number, number>();
    const cellNodes = new Map<number, number[]>();
    for (const f of deckFaces) {
      const a = faces[f];
      const b = faces[f + 1];
      const c = faces[f + 2];
      const ax = xs[a];
      const bx = xs[b];
      const cx = xs[c];
      const az = zs[a];
      const bz = zs[b];
      const cz = zs[c];
      const ay = ys[a];
      const by = ys[b];
      const cy = ys[c];
      const denom = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
      if (Math.abs(denom) < 1e-9) continue;
      const i0 = Math.ceil(Math.min(ax, bx, cx) / ROAD_CELL);
      const i1 = Math.floor(Math.max(ax, bx, cx) / ROAD_CELL);
      const j0 = Math.ceil(Math.min(az, bz, cz) / ROAD_CELL);
      const j1 = Math.floor(Math.max(az, bz, cz) / ROAD_CELL);
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const key = nodeKey(i, j);
          if (nodes.has(key)) continue;
          const px = i * ROAD_CELL;
          const pz = j * ROAD_CELL;
          const alpha = ((pz - az) * (cx - ax) - (px - ax) * (cz - az)) / denom;
          const beta = ((bz - az) * (px - ax) - (bx - ax) * (pz - az)) / denom;
          if (alpha < -1e-6 || beta < -1e-6 || alpha + beta > 1 + 1e-6) continue;
          nodes.set(key, ay + (by - ay) * alpha + (cy - ay) * beta);
          const cell = nodeKey(Math.floor(px / ROAD_CELL), Math.floor(pz / ROAD_CELL));
          const list = cellNodes.get(cell);
          if (list) list.push(key);
          else cellNodes.set(cell, [key]);
        }
      }
    }
    if (nodes.size === 0) continue;
    decks++;

    /** Voisins d'un nœud dans *ce* tablier, lus dans une carte donnée. */
    const neighbours = (key: number, source: Map<number, number>): number[] => {
      const out: number[] = [];
      const [i, j] = nodeCell(key);
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const list = cellNodes.get(nodeKey(i + dx, j + dz));
          if (!list) continue;
          for (const other of list) {
            const value = source.get(other);
            if (value !== undefined) out.push(value);
          }
        }
      }
      return out;
    };

    // Médiane des nœuds bruts : elle garde les bords et la montée du tour, mais
    // recopie une alternance de marches. La moyenne, calculée sur les médianes,
    // efface cette alternance sans baisser la piste.
    const medians = new Map<number, number>();
    for (const [key, height] of nodes) {
      const samples = neighbours(key, nodes);
      medians.set(key, samples.length > 0 ? median(samples) : height);
    }
    let smoothed = new Map<number, number>();
    for (const [key, height] of medians) {
      const samples = neighbours(key, medians);
      let sum = 0;
      for (const sample of samples) sum += sample;
      smoothed.set(key, samples.length > 0 ? sum / samples.length : height);
    }

    // Limiteur de pente : aucune bosse ne survit plus de trois passes. Il ne
    // touche pas une montée régulière (médiane = cote du nœud), il rabote les
    // picots laissés par les raccords de tuiles et par les deux tabliers.
    for (let pass = 0; pass < LIMIT_PASSES; pass++) {
      const limited = new Map<number, number>();
      for (const [key, height] of smoothed) {
        const samples = neighbours(key, smoothed);
        const middle = samples.length > 0 ? median(samples) : height;
        limited.set(key, Math.max(middle - MAX_STEP, Math.min(middle + MAX_STEP, height)));
      }
      smoothed = limited;
    }

    // 4. Quads : trois coins suffisent, le quatrième prend leur moyenne. Un bord
    // d'asphalte est donc couvert jusqu'à son dernier nœud, sans trou de trois
    // mètres où la voiture tombait.
    const vertexOf = new Map<number, number>();
    for (const [key] of smoothed) {
      const [i, j] = nodeCell(key);
      const grid = [
        { key: nodeKey(i, j), x: i * ROAD_CELL, z: j * ROAD_CELL },
        { key: nodeKey(i + 1, j), x: (i + 1) * ROAD_CELL, z: j * ROAD_CELL },
        { key: nodeKey(i, j + 1), x: i * ROAD_CELL, z: (j + 1) * ROAD_CELL },
        { key: nodeKey(i + 1, j + 1), x: (i + 1) * ROAD_CELL, z: (j + 1) * ROAD_CELL },
      ];
      const corners: { vertex: number; height: number }[] = [];
      let known = 0;
      let sum = 0;
      for (const corner of grid) {
        const height = smoothed.get(corner.key);
        if (height === undefined) continue;
        known++;
        sum += height;
      }
      if (known < 3) continue;
      const fill = sum / known;
      for (const corner of grid) {
        const height = smoothed.get(corner.key) ?? fill;
        const id = vertexOf.get(corner.key);
        if (id !== undefined) {
          corners.push({ vertex: id, height });
          continue;
        }
        const vertex = vertices.length / 3;
        vertexOf.set(corner.key, vertex);
        vertices.push(corner.x, height, corner.z);
        corners.push({ vertex, height });
      }
      const heights = corners.map((corner) => corner.height);
      const spread = Math.max(...heights) - Math.min(...heights);
      if (spread > MAX_QUAD_SPREAD) {
        dropped++;
        continue;
      }
      indices.push(corners[0].vertex, corners[2].vertex, corners[1].vertex);
      indices.push(corners[1].vertex, corners[2].vertex, corners[3].vertex);
      for (const [first, second] of [
        [corners[0], corners[2]],
        [corners[2], corners[3]],
        [corners[3], corners[1]],
        [corners[1], corners[0]],
      ]) {
        const grade = (Math.abs(first.height - second.height) / ROAD_CELL) * 100;
        if (grade > maxGrade) maxGrade = grade;
      }
    }
  }

  return {
    vertices: new Float32Array(vertices),
    indices: new Uint32Array(indices),
    triangles: indices.length / 3,
    maxGrade,
    decks,
    dropped,
  };
}

export type RoadQuery = (x: number, z: number, reference?: number) => number | null;

/**
 * Cote de la piste sous un point, lue sur la trame de collision elle-même.
 *
 * `reference` est la cote de ce qui interroge — le moyeu d'une roue. Seule une
 * surface à sa hauteur ou en dessous est retenue : sous le pont, la roue lit le
 * tablier bas, et sur le pont le tablier haut. Sans cette référence, une carte
 * unique mélangeait les deux niveaux et renvoyait 25 m d'écart d'un échantillon
 * au suivant.
 */
export function createRoadQuery(surface: RoadSurface): RoadQuery {
  const { vertices, indices } = surface;
  const buckets = new Map<number, number[]>();
  const keyOf = (i: number, j: number): number => (i + 100000) * 1000000 + (j + 100000);
  for (let t = 0; t < surface.triangles; t++) {
    const a = indices[t * 3];
    const b = indices[t * 3 + 1];
    const c = indices[t * 3 + 2];
    const minX = Math.min(vertices[a * 3], vertices[b * 3], vertices[c * 3]);
    const maxX = Math.max(vertices[a * 3], vertices[b * 3], vertices[c * 3]);
    const minZ = Math.min(vertices[a * 3 + 2], vertices[b * 3 + 2], vertices[c * 3 + 2]);
    const maxZ = Math.max(vertices[a * 3 + 2], vertices[b * 3 + 2], vertices[c * 3 + 2]);
    for (let gx = Math.floor(minX / QUERY_CELL); gx <= Math.floor(maxX / QUERY_CELL); gx++) {
      for (let gz = Math.floor(minZ / QUERY_CELL); gz <= Math.floor(maxZ / QUERY_CELL); gz++) {
        const key = keyOf(gx, gz);
        const list = buckets.get(key);
        if (list) list.push(t);
        else buckets.set(key, [t]);
      }
    }
  }

  return (x, z, reference) => {
    const list = buckets.get(keyOf(Math.floor(x / QUERY_CELL), Math.floor(z / QUERY_CELL)));
    if (!list) return null;
    const ceiling = reference === undefined ? Infinity : reference + 0.05;
    let best = -Infinity;
    for (const t of list) {
      const a = indices[t * 3];
      const b = indices[t * 3 + 1];
      const c = indices[t * 3 + 2];
      const ax = vertices[a * 3];
      const ay = vertices[a * 3 + 1];
      const az = vertices[a * 3 + 2];
      const bx = vertices[b * 3];
      const by = vertices[b * 3 + 1];
      const bz = vertices[b * 3 + 2];
      const cx = vertices[c * 3];
      const cy = vertices[c * 3 + 1];
      const cz = vertices[c * 3 + 2];
      const denom = (bz - cz) * (bx - ax) - (bx - cx) * (bz - az);
      if (Math.abs(denom) < 1e-9) continue;
      const alpha = ((z - bz) * (bx - ax) - (x - ax) * (bx - cx)) / denom;
      const beta = ((cz - bz) * (x - ax) - (cx - bx) * (z - bz)) / denom;
      if (alpha < -1e-4 || beta < -1e-4 || alpha + beta > 1 + 1e-4) continue;
      const height = ay + (by - ay) * alpha + (cy - ay) * beta;
      if (height <= ceiling && height > best) best = height;
    }
    return best === -Infinity ? null : best;
  };
}

export interface TrimmedMesh {
  material: string;
  triangles: number;
}

/**
 * Retire du décor les triangles qui se dressent **sur** la piste.
 *
 * Le bloc sans texture sous le pont n'est pas une primitive à part : c'est un
 * morceau d'un très gros maillage, donc aucune liste de matériaux ne pouvait
 * l'attraper. On le prend par la géométrie : un triangle de structure dont le
 * centre tombe sur l'asphalte, entre 8 cm et 3,5 m au-dessus de lui, traverse la
 * piste. Il sort du rendu *et* du collider — c'est ce qui débloquait le passage
 * sous le pont, et ce qui faisait buter la caisse sur des dalles invisibles.
 */
export function trimPhantoms(
  meshes: THREE.Mesh[],
  query: RoadQuery,
  keep: Set<THREE.Mesh>,
): TrimmedMesh[] {
  const trimmed: TrimmedMesh[] = [];
  const center = new THREE.Vector3();
  for (const mesh of meshes) {
    if (keep.has(mesh)) continue;
    const geometry = mesh.geometry;
    const positions = geometry.attributes.position;
    if (!positions) continue;
    const index = geometry.index;
    const count = index ? index.count : positions.count;
    const kept: number[] = [];
    let removed = 0;
    for (let i = 0; i + 2 < count; i += 3) {
      const ia = index ? index.getX(i) : i;
      const ib = index ? index.getX(i + 1) : i + 1;
      const ic = index ? index.getX(i + 2) : i + 2;
      center.set(0, 0, 0);
      center.x = (positions.getX(ia) + positions.getX(ib) + positions.getX(ic)) / 3;
      center.y = (positions.getY(ia) + positions.getY(ib) + positions.getY(ic)) / 3;
      center.z = (positions.getZ(ia) + positions.getZ(ib) + positions.getZ(ic)) / 3;
      center.applyMatrix4(mesh.matrixWorld);
      const level = query(center.x, center.z, center.y);
      const lift = level === null ? null : center.y - level;
      if (lift !== null && lift > PHANTOM_MIN_LIFT && lift < PHANTOM_MAX_LIFT) {
        removed++;
        continue;
      }
      kept.push(ia, ib, ic);
    }
    if (removed === 0) continue;
    geometry.setIndex(kept);
    const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    trimmed.push({ material: material?.name || mesh.name || '?', triangles: removed });
  }
  return trimmed;
}
