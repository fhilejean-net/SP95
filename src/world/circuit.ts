/**
 * Le circuit de Suzuka (modèle 2001) posé dans les champs à l'est de la
 * ceinture. Le modèle porte son propre sol : dalles d'herbe, bac à gravier,
 * asphalte, avec ses collines (jusqu'à une quarantaine de mètres entre le point
 * bas et le point haut). Plutôt que d'aplatir le monde autour, on échantillonne
 * cette dalle au chargement et le terrain de jeu la suit, puis un trimesh Rapier
 * la rend praticable.
 *
 * Tout passe par le même balayage de sommets : pas de raycast, une dalle de
 * 1,8 million de triangles répondrait en minutes.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import RAPIER from '@dimforge/rapier3d-compat';
import {
  CIRCUIT,
  CIRCUIT_FADE,
  naturalHeightAt,
  terrainBaseHeight,
  type SurfaceKind,
} from './layout.ts';
import { GROUP_GROUND, GROUP_WORLD } from '../physics/vehicle.ts';
import { createAsphaltTexture } from '../render/materials.ts';

// BASE_URL garde le modèle résolvable sous /SP95/ sur GitHub Pages ; en test
// Node, import.meta.env n'existe pas et le chemin retombe sur la racine.
const BASE = import.meta.env?.BASE_URL ?? '/';
const CIRCUIT_URL = `${BASE}models/tracks/suzuka-2001.glb`;

/** Pas de la grille d'échantillonnage de la dalle, en mètres monde. */
const SAMPLE_STEP = 4;
/**
 * Le terrain de jeu se tient sous la dalle : seule la surface du modèle est
 * visible, et le sol de secours ne doit jamais percer au travers. À 0,3 m il
 * perçait : l'herbe du terrain remontait à travers l'asphalte en plaques qui
 * clignotaient sous les roues et faisaient buter la voiture sur du vide.
 *
 * À 1,2 m la marge creusait une tranchée visible entre la piste et les murs, et
 * la voiture y tombait en se prenant un mur : 0,3 m suffisent, puisque la cote
 * d'une case est déjà le minimum de tout son voisinage.
 */
const GROUND_MARGIN = 0.3;
/**
 * La cote d'une case est aussi prise dans son voisinage : le terrain est
 * échantillonné tous les ~6 m et la dalle tous les 4 m, donc une interpolation
 * entre deux nœuds peut passer au-dessus de la dalle à côté d'une marche
 * (muret, vibreur, escalier de tribune), ou *par-dessus* un passage étroit — les
 * deux pistes du croisement en huit se superposent, et la route du dessus
 * faisait tenir le terrain à son niveau au-dessus de celle du dessous : 3,3 m
 * d'herbe en travers de la piste. Le voisinage doit donc couvrir au moins une
 * maille de terrain de rayon (±2 cases de 4 m pour ~6 m de maille).
 */
const GROUND_WINDOW = 2;
/**
 * Décor à plat posé *sur* la piste : épaisseur et emprise maximales d'une
 * plaque, et hauteur à partir de laquelle elle flotte au-dessus du sol. Une
 * plaque plus épaisse qu'un vibreur est un ouvrage, pas un marquage ; une plaque
 * de plus de 80 m est un revêtement, pas un décor. 0,12 m est l'ordre du défaut
 * de fabrication de ces tuiles photo : en dessous, la plaque et l'asphalte sont
 * à la même cote et il n'y a rien à corriger.
 */
const DECAL_MAX_THICK = 2.5;
const DECAL_MAX_SPAN = 80;
const DECAL_LIFT = 0.12;
/**
 * Passes de comblement : les premières bouchent les trous de la dalle, les
 * suivantes étalent le raccord de CIRCUIT_FADE mètres autour d'elle.
 */
const HOLE_PASSES = 3;
const FADE_PASSES = Math.ceil(CIRCUIT_FADE / SAMPLE_STEP) + HOLE_PASSES;
/**
 * Bande de cases ajoutée *autour* de l'emprise du modèle. Sans elle, le talus
 * de raccord tombait dans la première case du terrain naturel : la grille
 * interpolait d'un coup du niveau de la dalle (plus d'un mètre sous la piste)
 * au relief des collines, et cette pente ressortait à travers le pourtour du
 * circuit.
 */
const CELL_MARGIN = FADE_PASSES + 1;

/** Textures qui portent de l'asphalte roulable. */
const ASPHALT_IMAGES = /^(road0[1-7]|roadx|pitroad|grdr|grdrtop|groove00|skidslong)$/;
/**
 * Tuiles d'asphalte qui font *la piste* — celles qu'on repose en trame unique.
 * Les vibreurs (`grdr`), les bandes de gomme (`groove00`, `skidslong`) et les
 * bacs à gravier gardent leur texture : ce sont des décors, pas du revêtement.
 */
const TRACK_IMAGES = /^(road0[1-7]|roadx|pitroad)$/;
/**
 * Une répétition d'asphalte tous les 10 m. Le grain du carreau se réduit en gris
 * uni à distance ; plus la trame est large, moins l'œil peut compter les
 * répétitions en enfilade sur une ligne droite.
 */
const TRACK_TILE = 10;
/**
 * En dessous de cette image, une grande surface n'est plus une matière : le
 * modèle en a quinze à soixante-quatre pixels étalées sur des centaines de
 * mètres (terrassements, glissières, murs du pont), et à l'échelle réelle elles
 * se lisent comme un bloc vide.
 */
const RETILE_MAX_PIXELS = 128 * 128;
/** Taille au-delà de laquelle une texture de quelques pixels est étirée. */
const RETILE_MIN_SIZE = 8;
/** Répétition des textures retuilées, en mètres. */
const RETILE_METRES = 4;
/** Bac à gravier et terre : ça freine, ça ne tient pas. */
const LOOSE_IMAGES = /^(rf_sand01|rf_sand02|sand|gravel|rmbl)/;
/** Tout ce qui porte le sol du modèle (herbe, eau, sable, asphalte). */
const GROUND_IMAGES = /^(grass|green|sand|rf_|water|rmbl|road0[1-7]|roadx|pitroad|grdr|groove|skid)/;
/**
 * Décors posés à plat par-dessus le dallage photo : la gomme de la trajectoire
 * (`groove00`, `skidslong`) et les traces de pneus (`tyres_add`). Ils étaient
 * écrits pour le dallage d'origine ; sur la piste uniforme ils se lisent comme
 * une texture cassée étalée sur l'asphalte, et leur place dans le collider
 * faisait buter les roues dessus. La piste uniforme les remplace : masqués.
 */
const OVERLAY_IMAGES = /^(groove00|skidslong|tyres_add)/;
/**
 * Primitives que le fichier habille d'une texture de panneau stop ou laisse
 * sans la moindre image et qui se lisent comme des blocs défectueux posés au
 * bord de la piste — le bloc du panneau stop sous le pont, et les coffres de
 * support de la même famille. Masquées, elles sortent du rendu **et** du
 * collider.
 */
const HIDDEN_PRIMITIVES = new Set([
  'towerdisplay2',
  ...Array.from({ length: 11 }, (_, index) => `BOX${String(index + 1).padStart(2, '0')}`),
]);

/** Groupes de collision du terrain : les pneus mordent, la coque ignore. */
const GROUND_GROUP = (GROUP_GROUND << 16) | 0xffff;

/** Pose du départ sur la ligne droite des stands, en repère du modèle. */
const START_LOCAL = { x: 500, z: 430, heading: Math.PI };

/**
 * Cote de la surface visible du circuit (asphalte, herbe, bac à gravier) : le
 * terrain de jeu est plus bas, mais une voiture doit repartir de la piste.
 */
let floorAt: ((x: number, z: number) => number | null) | null = null;

export function circuitFloor(x: number, z: number): number | null {
  return floorAt ? floorAt(x, z) : null;
}

/**
 * Cote de la dalle une fois fondue dans le terrain, à `distance` mètres de son
 * bord : c'est le talus qui raccorde le circuit au reste du monde.
 */
/**
 * UV planaires de la piste, pris dans le repère du monde : une répétition tous
 * les `tile` mètres. Deux primitives voisines partagent donc la même trame, et
 * le raccord entre leurs tuiles photo disparaît.
 */
export function trackUv(x: number, z: number, tile: number): [number, number] {
  return [x / tile, z / tile];
}

export function fadeGround(plate: number, base: number, distance: number): number {
  const t = Math.min(1, Math.max(0, distance) / CIRCUIT_FADE);
  return plate * (1 - t) + base * t;
}

export interface CircuitHandles {
  /** Départ sur la ligne droite des stands, en coordonnées monde. */
  spawn: { x: number; z: number; heading: number };
  meshes: number;
  triangles: number;
  loadMs: number;
  buildMs: number;
}

interface ModelJson {
  materials: { name?: string; pbrMetallicRoughness?: { baseColorTexture?: { index: number } } }[];
  textures: { source?: number; extensions?: { EXT_texture_webp?: { source: number } } }[];
  images: { name?: string }[];
}

/** Nom de la texture de base color de chaque matériau, par nom glTF. */
function imageNames(json: ModelJson): Map<string, string> {
  const out = new Map<string, string>();
  json.materials.forEach((material, index) => {
    const ref = material.pbrMetallicRoughness?.baseColorTexture;
    if (!ref) return;
    const texture = json.textures[ref.index];
    const source = texture?.source ?? texture?.extensions?.EXT_texture_webp?.source;
    out.set(material.name ?? `mat${index}`, json.images[source ?? -1]?.name ?? '');
  });
  return out;
}

/**
 * Teinte de secours des matériaux du circuit qui n'ont aucune texture de couleur
 * dans le fichier (relevé à l'inspection du GLB : DIANTA02, DIANTA03, TREE09,
 * PIT_LOGO_REAR, ZHUANPAN09). Sans ça ils sortent en aplat, blancs pour les
 * arbres, gris clair pour les câbles et leur bloc sous le pont.
 */
type Grain = 'steel' | 'foliage' | 'plate';

const TEXTURELESS_FIX: Record<string, { color: number; roughness: number; grain: Grain }> = {
  DIANTA02: { color: 0x6c7178, roughness: 0.7, grain: 'steel' },
  DIANTA03: { color: 0x262a2f, roughness: 0.8, grain: 'steel' },
  TREE09: { color: 0x53703f, roughness: 0.92, grain: 'foliage' },
  PIT_LOGO_REAR: { color: 0xd9ddd4, roughness: 0.85, grain: 'plate' },
  ZHUANPAN09: { color: 0x1f4b6b, roughness: 0.7, grain: 'plate' },
};

/**
 * Grain procédural pour les matériaux que le fichier laisse sans aucune texture :
 * sans lui ils sortent en aplat, et un aplat gris de plusieurs mètres sous un
 * pont se lit comme un bloc vide. Le motif est projeté sur les UV d'origine de
 * la primitive, donc il suit la forme du maillage.
 */
function grainTexture(grain: Grain, anisotropy: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  const palettes: Record<Grain, [string, string, string]> = {
    steel: ['#71767d', '#82878e', '#5c6168'],
    foliage: ['#3f5c33', '#4f7340', '#2f4a24'],
    plate: ['#c9cec4', '#d9ddd4', '#aeb4aa'],
  };
  const [base, light, dark] = palettes[grain];
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, 128, 128);
  let seed = 12345;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < 2600; i++) {
    ctx.fillStyle = rand() > 0.5 ? light : dark;
    ctx.globalAlpha = 0.25 + rand() * 0.5;
    const size = 1 + rand() * (grain === 'foliage' ? 4 : 2);
    ctx.fillRect(rand() * 128, rand() * 128, size, size);
  }
  ctx.globalAlpha = 1;
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = anisotropy;
  return texture;
}

/**
 * La piste roulable est reconstruite pour la physique, pas pour l'image.
 *
 * Le modèle est un relevé de Suzuka : 51 m de dénivelé, du dévers dans les
 * courbes, des vibreurs en marche et des raccords de tuiles. Les roues sont des
 * raycasts : chaque pli et chaque dévers devient un couple de roulis, d'où la
 * voiture déséquilibrée au freinage et retournée en courbe rapide.
 *
 * La surface est donc lissée : chaque sommet de l'asphalte prend la médiane de
 * son voisinage. L'image garde le modèle, seule la surface que lisent les roues
 * change, et elle suit le bitume à quelques centimètres.
 */
/** Case de la grille de voisinage, en mètres. */
const ROAD_CELL = 3;
/**
 * Écart de cote au-delà duquel deux sommets ne sont pas sur le même tablier : au
 * croisement en huit, la piste du dessus passe sept mètres au-dessus.
 */
const ROAD_LEVEL_TOL = 3;

/** Cote médiane : un vibreur isolé ne tire pas la trame à lui. */
function median(values: number[]): number {
  values.sort((a, b) => a - b);
  return values[values.length >> 1];
}

interface FlatRoad {
  vertices: Float32Array;
  indices: Uint32Array;
  triangles: number;
  /** Pente la plus forte entre deux nœuds reliés par une arête, en %. */
  maxGrade: number;
}

/**
 * Surface roulable : grille dense posée sur les triangles d'asphalte du modèle.
 *
 * Pourquoi tout ce détour : les positions du fichier sont quantifiées et ses
 * dalles sont longues (trente mètres pour quatre sommets). Un collider qui
 * reprend la topologie brute garde les marches de quantification — la voiture
 * décollait sur des « escaliers » —, et une trame posée sur les carreaux du
 * fichier laissait des trous là où une dalle n'a aucun sommet dans ses cases
 * intermédiaires : la voiture tombait à travers la piste. Ici les deux défauts
 * disparaissent : les triangles d'asphalte servent à *couvrir* la grille
 * (chaque nœud prend sa cote par interpolation dans le triangle qui le
 * contient, comme un vrai relevé du sol), puis le relief court est effacé sur
 * la grille même, en deux passes de voisinage (médiane puis moyenne, sur le
 * même tablier — voir `ROAD_LEVEL_TOL`) : la couture entre deux tuiles est
 * accordée, parce que le voisinage lit les maillages voisins. Un quad dont un
 * coin manque emprunte sa cote au maillage voisin de même niveau — c'est ce qui
 * rattrape la case que deux tuilesadjacentes ne couvrent pas toutes deux. La
 * montée du tour traverse le lissage ; les marches et les raccords de tuiles ne
 * la traversent plus.
 */
/**
 * Ramène toutes les surfaces roulantes à une seule cote et renvoie cette cote.
 *
 * Le modèle a des bosses de quantification et des collines que le lissage de la
 * grille ne rattrapait pas : la voiture décollait sur des monticules invisibles.
 * Une table rase supprime le problème à la source — piste, herbe et gravier
 * sont au même niveau, et les normales sont recalculées vers le haut.
 */
export function buildFlatRoad(meshes: THREE.Mesh[]): FlatRoad {
  const point = new THREE.Vector3();
  /** Sommets de tous les maillages, en coordonnées monde. */
  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];

  /* Clé d'un nœud de la grille du monde : (i + 100000) · 10⁶ + (j + 100000). */
  const keyOf = (i: number, j: number) => (i + 100000) * 1000000 + (j + 100000);

  /**
   * Cotes d'origine par maillage : les deux pistes du croisement en huit sont
   * deux maillages distincts qui gardent chacun leur cote.
   */
  const meshNodes: Map<number, number>[] = meshes.map(() => new Map<number, number>());
  /** Clés de nœud portant une cote, par case du monde, pour le voisinage. */
  const cellNodes = new Map<number, number[]>();

  const toGrid = (value: number) => Math.floor(value / ROAD_CELL);
  const cellOfNode = (key: number): [number, number] => [
    Math.floor(key / 1000000) - 100000,
    (key % 1000000) - 100000,
  ];

  // 1. Rasterisation : chaque triangle d'asphalte donne sa cote aux nœuds
  // qu'il contient. Une dalle de trente mètres n'a pas besoin de sommets aux
  // coins de la grille : son plan les porte.
  for (let meshIndex = 0; meshIndex < meshes.length; meshIndex++) {
    const mesh = meshes[meshIndex];
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
    const faces: number[] = [];
    if (index) {
      for (let i = 0; i + 2 < index.count; i += 3) {
        faces.push(index.getX(i), index.getX(i + 1), index.getX(i + 2));
      }
    } else {
      for (let i = 0; i + 2 < positions.count; i += 3) {
        faces.push(i, i + 1, i + 2);
      }
    }

    const nodes = meshNodes[meshIndex];
    for (let f = 0; f < faces.length; f += 3) {
      const a = start + faces[f];
      const b = start + faces[f + 1];
      const c = start + faces[f + 2];
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
      // Nœuds de la grille compris dans la boîte englobante du triangle.
      const i0 = Math.ceil(Math.min(ax, bx, cx) / ROAD_CELL);
      const i1 = Math.floor(Math.max(ax, bx, cx) / ROAD_CELL);
      const j0 = Math.ceil(Math.min(az, bz, cz) / ROAD_CELL);
      const j1 = Math.floor(Math.max(az, bz, cz) / ROAD_CELL);
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const nodeKey = keyOf(i, j);
          if (nodes.has(nodeKey)) continue;
          const px = i * ROAD_CELL;
          const pz = j * ROAD_CELL;
          // P − A = α (B − A) + β (C − A), résolu par la règle de Cramer : la
          // cote se lit barycentriquement, peu importe l'ordre des sommets.
          const alpha = ((pz - az) * (cx - ax) - (px - ax) * (cz - az)) / denom;
          const beta = ((bz - az) * (px - ax) - (bx - ax) * (pz - az)) / denom;
          if (alpha < -1e-6 || beta < -1e-6 || alpha + beta > 1 + 1e-6) continue;
          nodes.set(nodeKey, ay + (by - ay) * alpha + (cy - ay) * beta);
          const cell = keyOf(toGrid(px), toGrid(pz));
          const list = cellNodes.get(cell);
          if (list) list.push(nodeKey);
          else cellNodes.set(cell, [nodeKey]);
        }
      }
    }
  }

  // 2. Lissage, sur la grille même : médiane du voisinage (± 1 nœud) puis
  // moyenne sur ces médianes. Le filtre médian garde les bords et la montée du
  // tour, mais recopie une alternance — une marche sur deux — ; la moyenne
  // l'efface, et la moyenne d'une pente vaut sa cote centrale.
  const buildNeighbours = () => {
    const neighbours: number[] = [];
    return (nodeKey: number, level: number): number[] => {
      neighbours.length = 0;
      const [i, j] = cellOfNode(nodeKey);
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const list = cellNodes.get(keyOf(i + dx, j + dz));
          if (!list) continue;
          for (const other of list) {
            for (const heights of meshNodes) {
              // Tout maillage qui porte ce nœud est un voisin : c'est ce qui
              // accorde la couture entre deux tuiles du même tablier. Parmi les
              // tabliers superposés, le filtre de niveau garde le sien.
              const value = heights.get(other);
              if (value === undefined || Math.abs(value - level) > ROAD_LEVEL_TOL) continue;
              neighbours.push(value);
            }
          }
        }
      }
      return neighbours;
    };
  };

  const medians: Map<number, number>[] = meshNodes.map(() => new Map());
  for (let meshIndex = 0; meshIndex < meshNodes.length; meshIndex++) {
    const gather = buildNeighbours();
    const target = medians[meshIndex];
    for (const [nodeKey, height] of meshNodes[meshIndex]) {
      const samples = gather(nodeKey, height);
      // La médiane d'un échantillon vide ne se produit pas : le nœud lui-même
      // est toujours son premier voisin.
      target.set(nodeKey, median(samples));
    }
  }

  const filtered: Map<number, number>[] = meshNodes.map(() => new Map());
  for (let meshIndex = 0; meshIndex < meshNodes.length; meshIndex++) {
    const gather = buildNeighbours();
    const target = filtered[meshIndex];
    const source = medians[meshIndex];
    for (const [nodeKey, height] of source) {
      const samples = gather(nodeKey, height);
      let sum = 0;
      for (const sample of samples) sum += sample;
      target.set(nodeKey, samples.length > 0 ? sum / samples.length : height);
    }
  }

  // 3. Le collider : une dalle par case couverte aux quatre coins par le même
  // maillage. Chaque maillage bâtit sa surface : les tabliers ne se mélangent
  // pas, et les coutures entre tuiles du même tablier ont reçu la même moyenne.
  const vertices: number[] = [];
  const indices: number[] = [];
  let maxGrade = 0;
  for (let meshIndex = 0; meshIndex < filtered.length; meshIndex++) {
    const heights = filtered[meshIndex];
    const vertexOf = new Map<number, number>();
    /**
     * Emprunte un coin manquant à un maillage de même niveau : deux tuiles d'un
     * même tablier ne couvrent pas les mêmes nœuds de la grille, mais la surface
     * est continue — le quad qui franchit leur couture la garde. Un tablier
     * voisin, sept mètres plus haut au croisement en huit, est rejeté par le
     * filtre de niveau.
     */
    const idOf = (
      i: number,
      j: number,
      reference: number,
    ): { vertex: number; height: number } | null => {
      const nodeKey = keyOf(i, j);
      let height = heights.get(nodeKey);
      if (height === undefined) {
        let best: number | undefined;
        for (const otherHeights of filtered) {
          const value = otherHeights.get(nodeKey);
          if (value === undefined || Math.abs(value - reference) > ROAD_LEVEL_TOL) continue;
          if (best === undefined || Math.abs(value - reference) < Math.abs(best - reference)) {
            best = value;
          }
        }
        if (best === undefined) return null;
        height = best;
      }
      let vertex = vertexOf.get(nodeKey);
      if (vertex === undefined) {
        vertex = vertices.length / 3;
        vertexOf.set(nodeKey, vertex);
        vertices.push(i * ROAD_CELL, height, j * ROAD_CELL);
      }
      return { vertex, height };
    };
    for (const nodeKey of heights.keys()) {
      const [i, j] = cellOfNode(nodeKey);
      // Résolution en deux temps : les coins que ce maillage porte d'abord, la
      // référence de niveau qu'ils donnent ensuite pour les manquants.
      const own = [
        heights.get(keyOf(i, j)),
        heights.get(keyOf(i + 1, j)),
        heights.get(keyOf(i, j + 1)),
        heights.get(keyOf(i + 1, j + 1)),
      ];
      if (own[0] === undefined) continue;
      let sum = 0;
      let count = 0;
      for (const height of own) {
        if (height === undefined) continue;
        sum += height;
        count++;
      }
      const reference = count > 0 ? sum / count : own[0];
      const zero = idOf(i, j, reference);
      const ten = idOf(i + 1, j, reference);
      const zeroOne = idOf(i, j + 1, reference);
      const eleven = idOf(i + 1, j + 1, reference);
      if (!zero || !ten || !zeroOne || !eleven) continue;
      // Deux triangles d'une dalle ; leurs arêtes mesurent la pente réelle
      // restante, celle que liront les rayons des roues.
      indices.push(zero.vertex, zeroOne.vertex, ten.vertex);
      indices.push(ten.vertex, zeroOne.vertex, eleven.vertex);
      for (const [first, second] of [
        [zero, zeroOne],
        [zeroOne, eleven],
        [eleven, ten],
        [ten, zero],
      ]) {
        const run = ROAD_CELL;
        const grade = (Math.abs(first.height - second.height) / run) * 100;
        if (grade > maxGrade) maxGrade = grade;
      }
    }
  }

  return {
    vertices: new Float32Array(vertices),
    indices: new Uint32Array(indices),
    triangles: indices.length / 3,
    maxGrade,
  };
}

/** Vrai si tous les UV du maillage tiennent dans la case [0,1] de sa texture. */
function uvInTile(mesh: THREE.Mesh): boolean {
  const uv = mesh.geometry.attributes.uv;
  if (!uv) return false;
  for (let i = 0; i < uv.count; i++) {
    const u = uv.getX(i);
    const v = uv.getY(i);
    if (u < -0.002 || u > 1.002 || v < -0.002 || v > 1.002) return false;
  }
  return true;
}

export async function buildCircuit(
  scene: THREE.Scene,
  world: RAPIER.World,
  options: { anisotropy: number },
): Promise<CircuitHandles> {
  const loadStarted = performance.now();
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.loadAsync(CIRCUIT_URL);
  const loadMs = performance.now() - loadStarted;

  const root = gltf.scene;
  /** Un grain par famille de matériau sans texture, partagé entre primitives. */
  const grains = new Map<Grain, THREE.CanvasTexture>();
  const imageOf = imageNames((gltf.parser as unknown as { json: ModelJson }).json);
  const nameOf = (mesh: THREE.Mesh): string => {
    const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    return imageOf.get(material?.name ?? '') ?? '';
  };

  // 1. Classement, et hauteur de la dalle dans le repère du modèle, avant pose.
  root.updateMatrixWorld(true);
  const groundMeshes: THREE.Mesh[] = [];
  const asphaltMeshes: THREE.Mesh[] = [];
  const looseMeshes: THREE.Mesh[] = [];
  /** Décors à plat masqués : hors rendu, hors collider, hors cote du sol. */
  const overlayMeshes: THREE.Mesh[] = [];
  /** Primitives sans texture retirées (le bloc sous le pont). */
  const hiddenPrimitives: string[] = [];
  let plateTop = -Infinity;
  let plateBottom = Infinity;
  let triangles = 0;
  let meshes = 0;

  const point = new THREE.Vector3();
  root.traverse((object) => {
    if (!(object as THREE.Mesh).isMesh) return;
    const mesh = object as THREE.Mesh;
    meshes++;
    const geometry = mesh.geometry;
    triangles += (geometry.index ? geometry.index.count : geometry.attributes.position.count) / 3;
    const materialName =
      (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material)?.name ?? '';
    const image = nameOf(mesh);
    if (OVERLAY_IMAGES.test(image) || HIDDEN_PRIMITIVES.has(materialName)) {
      mesh.visible = false;
      overlayMeshes.push(mesh);
      if (HIDDEN_PRIMITIVES.has(materialName)) hiddenPrimitives.push(materialName);
      return;
    }
    if (ASPHALT_IMAGES.test(image)) asphaltMeshes.push(mesh);
    else if (LOOSE_IMAGES.test(image)) looseMeshes.push(mesh);
    if (!GROUND_IMAGES.test(image)) return;
    groundMeshes.push(mesh);
    const positions = geometry.attributes.position;
    for (let i = 0; i < positions.count; i++) {
      point.fromBufferAttribute(positions, i).applyMatrix4(mesh.matrixWorld);
      if (point.y > plateTop) plateTop = point.y;
      if (point.y < plateBottom) plateBottom = point.y;
    }
  });

  // 1b. Les primitives qui regardent le ciel sont des surfaces roulables.
  //
  // Le modèle range la piste, ses vibreurs, ses marquages et ses herbes dans des
  // primitives dont l'image ne porte qu'un numéro : 271 des 308 images du
  // fichier ne disent rien, et tout ce qui n'était reconnu par aucune liste
  // finissait dans le collider des **murs**. Le châssis y cognait les plaques
  // posées à plat sur la piste — la voiture butait sur une dalle à ras
  // l'asphalte et se déséquilibrait, exactement ce qu'on voyait. On classe donc
  // aussi par la géométrie : une primitive dont les normales regardent le ciel
  // est une surface (les roues roulent dessus, la coque l'ignore), une primitive
  // aux normales horizontales reste une structure.
  const normalMatrix = new THREE.Matrix3();
  const sampleNormal = new THREE.Vector3();
  /** Surfaces reconnues par leur nom : elles font foi sous une plaque flottante. */
  const trustedMeshes = [...groundMeshes, ...looseMeshes];
  /** Plaques classées surface par leurs normales, à vérifier contre le sol. */
  const surfaceCandidates: THREE.Mesh[] = [];
  let surfacesAdded = 0;
  root.traverse((object) => {
    if (!(object as THREE.Mesh).isMesh) return;
    const mesh = object as THREE.Mesh;
    if (overlayMeshes.includes(mesh)) return;
    if (asphaltMeshes.includes(mesh) || looseMeshes.includes(mesh) || groundMeshes.includes(mesh)) return;
    const attribute = mesh.geometry.attributes.normal;
    const positions = mesh.geometry.attributes.position;
    if (!attribute || attribute.count !== positions.count) return;
    normalMatrix.getNormalMatrix(mesh.matrixWorld);
    const step = Math.max(1, Math.floor(attribute.count / 240));
    let up = 0;
    let sampled = 0;
    for (let i = 0; i < attribute.count; i += step) {
      sampleNormal.fromBufferAttribute(attribute, i).applyMatrix3(normalMatrix);
      if (sampleNormal.y > 0.55) up++;
      sampled++;
    }
    if (sampled > 0 && up / sampled >= 0.6) {
      // Elle rejoint le sol de secours : c'est la surface que la roue lit.
      groundMeshes.push(mesh);
      surfaceCandidates.push(mesh);
      surfacesAdded++;
    }
  });
  console.log(`Circuit : ${surfacesAdded} primitives classées surfaces par leurs normales`);

  // 2. Pose : la dalle se centre sur le terrain naturel de l'emprise, sans le
  // déplacer de travers (les collines du modèle restent ces collines-là).
  const natural = naturalHeightAt(CIRCUIT.cx, CIRCUIT.cz);
  const centreY = ((plateTop + plateBottom) / 2) * CIRCUIT.scale;
  root.scale.setScalar(CIRCUIT.scale);
  root.rotation.y = CIRCUIT.yaw;
  root.position.set(CIRCUIT.cx, natural - centreY, CIRCUIT.cz);
  root.updateMatrixWorld(true);
  scene.add(root);

  // 2b. Le sol physique est la surface visible elle-même (voir plus bas). Ni
  // grille lissée, ni dalle plate : une dalle à une seule cote plaçait la voiture
  // des dizaines de mètres au-dessus ou sous la piste dès que le tracé montait.
  if (hiddenPrimitives.length) {
    console.log(`Circuit : primitives sans texture retirées (${hiddenPrimitives.join(', ')})`);
  }

  // Tous les maillages passent par ici : le décor (murs, gradins, panneaux) a les
  // mêmes réglages de texture que la piste, sinon il garde un filtrage qui bave
  // à distance et des matériaux sans map qui sortent en aplat.
  root.traverse((object) => {
    if (!(object as THREE.Mesh).isMesh) return;
    const mesh = object as THREE.Mesh;
    mesh.receiveShadow = true;
    // 183 000 triangles dans la passe d'ombres coûteraient plus qu'ils ne rendent.
    mesh.castShadow = false;
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      const standard = material as THREE.MeshStandardMaterial;
      const fix = TEXTURELESS_FIX[standard.name];
      if (fix && !standard.map) {
        standard.color.setHex(fix.color);
        standard.roughness = fix.roughness;
        standard.metalness = 0;
        let grain = grains.get(fix.grain);
        if (!grain) {
          grain = grainTexture(fix.grain, options.anisotropy);
          grains.set(fix.grain, grain);
        }
        standard.map = grain;
      }
      // Le modèle est un atlas de tuiles photo : chaque primitive a ses UV dans
      // la case [0,1]. Une UV qui dépasse d'un cheveu (elles sont quantifiées
      // dans ce fichier) fait répéter la texture et bave d'un bord de tuile sur
      // l'autre — d'où des morceaux de piste qui n'ont pas l'air à leur place.
      // On épingle les textures des primitives dont les UV tiennent dans la case.
      const clamp = uvInTile(mesh);
      for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap']) {
        const texture = standard[key as 'map'];
        if (!texture) continue;
        texture.anisotropy = options.anisotropy;
        if (clamp) texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
      }
      standard.needsUpdate = true;
    }
  });

  // Diagnostic : les matières que le parseur laisse sans image après toutes
  // les retouches. Le relief et la distance font le reste à l'écran, mais une
  // liste courte dit exactement quelle famille retoucher (voir TEXTURELESS_FIX).
  const bareMaterials = new Set<string>();
  root.traverse((object) => {
    if (!(object as THREE.Mesh).isMesh) return;
    const materials = Array.isArray((object as THREE.Mesh).material)
      ? (object as THREE.Mesh).material
      : [(object as THREE.Mesh).material];
    for (const material of materials as THREE.MeshStandardMaterial[]) {
      if (material.map || TEXTURELESS_FIX[material.name] || HIDDEN_PRIMITIVES.has(material.name)) continue;
      bareMaterials.add(material.name);
    }
  });
  if (bareMaterials.size > 0) {
    console.log(
      `Circuit : ${bareMaterials.size} matières restées sans image — ` +
        `${[...bareMaterials].slice(0, 14).join(', ')}${bareMaterials.size > 14 ? '…' : ''}`,
    );
  }

  // 3. Grille d'échantillonnage du sol, en coordonnées modèle puis monde.
  const halfX = CIRCUIT.plateHalfX;
  const halfZ = CIRCUIT.plateHalfZ;
  const columns = Math.ceil((halfX * 2) / (SAMPLE_STEP / CIRCUIT.scale)) + CELL_MARGIN * 2;
  const rows = Math.ceil((halfZ * 2) / (SAMPLE_STEP / CIRCUIT.scale)) + CELL_MARGIN * 2;
  const cells = columns * rows;
  const groundY = new Float32Array(cells).fill(Infinity);
  const surfaceY = new Float32Array(cells).fill(-Infinity);
  const covered = new Uint8Array(cells);
  /** 0 sous la dalle, puis 1, 2, 3… cases plus loin dans le raccord. */
  const ring = new Uint8Array(cells).fill(255);
  const asphaltMask = new Uint8Array(cells);
  const looseMask = new Uint8Array(cells);
  const stepLocal = SAMPLE_STEP / CIRCUIT.scale;
  const cos = Math.cos(CIRCUIT.yaw);
  const sin = Math.sin(CIRCUIT.yaw);

  const cellOf = (x: number, z: number, out: { cx: number; cz: number }): boolean => {
    const dx = x - CIRCUIT.cx;
    const dz = z - CIRCUIT.cz;
    const lx = (dx * cos - dz * sin) / CIRCUIT.scale;
    const lz = (dx * sin + dz * cos) / CIRCUIT.scale;
    out.cx = CELL_MARGIN + Math.floor((lx + halfX) / stepLocal);
    out.cz = CELL_MARGIN + Math.floor((lz + halfZ) / stepLocal);
    return out.cx >= 0 && out.cx < columns && out.cz >= 0 && out.cz < rows;
  };

  /** Vrai dans l'emprise du modèle, pas dans la bande de talus qui l'entoure. */
  const insidePlate = (x: number, z: number): boolean => {
    const dx = x - CIRCUIT.cx;
    const dz = z - CIRCUIT.cz;
    const lx = (dx * cos - dz * sin) / CIRCUIT.scale;
    const lz = (dx * sin + dz * cos) / CIRCUIT.scale;
    return Math.abs(lx) <= halfX && Math.abs(lz) <= halfZ;
  };

  const cell = { cx: 0, cz: 0 };
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();

  /** Cases couvertes par une boîte au sol, bornées à la grille. */
  const cellBounds = (maxX: number, maxZ: number, out: { x1: number; z1: number }): boolean => {
    if (!cellOf(maxX, maxZ, cell)) return false;
    out.x1 = Math.min(columns - 1, Math.max(0, cell.cx));
    out.z1 = Math.min(rows - 1, Math.max(0, cell.cz));
    return true;
  };

  // Le point le plus bas de chaque case : le terrain reste sous l'herbe comme
  // sous l'asphalte, donc il ne peut pas percer la piste par en dessous.
  for (const mesh of groundMeshes) {
    const positions = mesh.geometry.attributes.position;
    for (let i = 0; i < positions.count; i++) {
      point.fromBufferAttribute(positions, i).applyMatrix4(mesh.matrixWorld);
      if (!cellOf(point.x, point.z, cell)) continue;
      const index = cell.cz * columns + cell.cx;
      covered[index] = 1;
      ring[index] = 0;
      if (point.y < groundY[index]) groundY[index] = point.y;
      if (point.y > surfaceY[index]) surfaceY[index] = point.y;
    }
  }

  // Revêtement : on marque la surface couverte par chaque triangle, ce qui suit
  // la piste d'assez près pour que la roue sache où elle roule.
  const mark = (mesh: THREE.Mesh, mask: Uint8Array): void => {
    const positions = mesh.geometry.attributes.position;
    const index = mesh.geometry.index;
    const count = index ? index.count : positions.count;
    for (let i = 0; i < count; i += 3) {
      const ia = index ? index.getX(i) : i;
      const ib = index ? index.getX(i + 1) : i + 1;
      const ic = index ? index.getX(i + 2) : i + 2;
      a.fromBufferAttribute(positions, ia).applyMatrix4(mesh.matrixWorld);
      b.fromBufferAttribute(positions, ib).applyMatrix4(mesh.matrixWorld);
      c.fromBufferAttribute(positions, ic).applyMatrix4(mesh.matrixWorld);
      if (
        !cellOf(
          Math.min(a.x, b.x, c.x),
          Math.min(a.z, b.z, c.z),
          cell,
        )
      ) {
        continue;
      }
      const fromX = Math.max(0, cell.cx);
      const fromZ = Math.max(0, cell.cz);
      if (!cellBounds(Math.max(a.x, b.x, c.x), Math.max(a.z, b.z, c.z), far)) continue;
      for (let cz = fromZ; cz <= far.z1; cz++) {
        for (let cx = fromX; cx <= far.x1; cx++) mask[cz * columns + cx] = 1;
      }
    }
  };
  const far = { x1: 0, z1: 0 };
  for (const mesh of asphaltMeshes) mark(mesh, asphaltMask);
  for (const mesh of looseMeshes) mark(mesh, looseMask);

  // Les cases sans sommet (grands triangles, trous dans la dalle) prennent la
  // cote la plus basse du voisinage : à nouveau, jamais au-dessus de la piste.
  // Les passes suivantes étalent cette cote vers l'extérieur : c'est le talus
  // qui raccorde la dalle au terrain, sinon elle se termine sur une falaise.
  for (let pass = 1; pass <= FADE_PASSES; pass++) {
    const filled = covered.slice();
    for (let cz = 0; cz < rows; cz++) {
      for (let cx = 0; cx < columns; cx++) {
        const index = cz * columns + cx;
        if (covered[index] || ring[index] !== 255) continue;
        let best = Infinity;
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = cx + dx;
            const nz = cz + dz;
            if (nx < 0 || nx >= columns || nz < 0 || nz >= rows) continue;
            const neighbour = nz * columns + nx;
            if (!covered[neighbour]) continue;
            if (groundY[neighbour] < best) best = groundY[neighbour];
          }
        }
        if (best === Infinity) continue;
        groundY[index] = best;
        filled[index] = 1;
        ring[index] = Math.min(255, pass);
      }
    }
    covered.set(filled);
  }

  // La cote de la surface *visible* suit le même chemin, mais avec le maximum du
  // voisinage. Les grandes dalles d'herbe n'ont aucun sommet à l'intérieur de la
  // plupart des cases : sans cette propagation, `surfaceY` resterait vide
  // presque partout, `circuitFloor` ne renverrait rien et la voiture serait
  // posée sur le terrain de secours — plus d'un mètre sous la piste — avant
  // d'être remontée par le collider. Poser un peu haut est sans conséquence
  // (la voiture retombe sur la piste), poser sous l'asphalte ne l'est pas.
  for (let pass = 0; pass < FADE_PASSES; pass++) {
    const known = surfaceY.slice();
    let progressed = false;
    for (let cz = 0; cz < rows; cz++) {
      for (let cx = 0; cx < columns; cx++) {
        const index = cz * columns + cx;
        if (surfaceY[index] !== -Infinity) continue;
        let best = -Infinity;
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = cx + dx;
            const nz = cz + dz;
            if (nx < 0 || nx >= columns || nz < 0 || nz >= rows) continue;
            const value = known[nz * columns + nx];
            if (value > best) best = value;
          }
        }
        if (best !== -Infinity) {
          surfaceY[index] = best;
          progressed = true;
        }
      }
    }
    if (!progressed) break;
  }

  // Cote brute d'une case, relevée avant l'élargissement : elle sert à mesurer
  // la hauteur d'une plaque au-dessus du sol. La grille élargie est descendue de
  // tout son voisinage et fausserait la mesure dès qu'une pente s'en mêle.
  const rawGround = groundY.slice();

  // Le sol de secours passe sous la dalle : la cote de chaque case est ramenée
  // au minimum de son voisinage (voir GROUND_WINDOW).
  const lowered = groundY.slice();
  for (let cz = 0; cz < rows; cz++) {
    for (let cx = 0; cx < columns; cx++) {
      const index = cz * columns + cx;
      let best = groundY[index];
      for (let dz = -GROUND_WINDOW; dz <= GROUND_WINDOW; dz++) {
        for (let dx = -GROUND_WINDOW; dx <= GROUND_WINDOW; dx++) {
          const nx = cx + dx;
          const nz = cz + dz;
          if (nx < 0 || nx >= columns || nz < 0 || nz >= rows) continue;
          const value = groundY[nz * columns + nx];
          if (value < best) best = value;
        }
      }
      lowered[index] = best;
    }
  }
  groundY.set(lowered);

  // 3b. Décors à plat posés *sur* la piste. Le modèle range sous des noms muets
  // des plaques fines — marquages, gomme, raccords de tuile — qui flottent
  // au-dessus du revêtement. Elles passaient dans le collider du sol : la roue
  // prenait leur bord comme une marche, la caisse sautillait et se déséquilibrait
  // en pleine ligne droite, et à l'écran la plaque z-fightait avec l'asphalte,
  // d'où les damiers qui bougent sous la voiture. Une plaque n'est un décor que
  // si une surface reconnue passe *sous* elle : sinon c'est elle le sol.
  const trustedCells = new Uint8Array(cells);
  for (const mesh of trustedMeshes) {
    const positions = mesh.geometry.attributes.position;
    const stride = Math.max(1, Math.floor(positions.count / 8000));
    for (let i = 0; i < positions.count; i += stride) {
      point.fromBufferAttribute(positions, i).applyMatrix4(mesh.matrixWorld);
      if (!cellOf(point.x, point.z, cell)) continue;
      trustedCells[cell.cz * columns + cell.cx] = 1;
    }
  }

  const plateBox = new THREE.Box3();
  const plateSize = new THREE.Vector3();
  const decals: string[] = [];
  for (const mesh of surfaceCandidates) {
    plateBox.setFromObject(mesh);
    plateBox.getSize(plateSize);
    if (plateSize.y > DECAL_MAX_THICK) continue;
    if (Math.max(plateSize.x, plateSize.z) > DECAL_MAX_SPAN) continue;
    const positions = mesh.geometry.attributes.position;
    const stride = Math.max(1, Math.floor(positions.count / 200));
    let sampled = 0;
    let overGround = 0;
    let lifted = 0;
    for (let i = 0; i < positions.count; i += stride) {
      point.fromBufferAttribute(positions, i).applyMatrix4(mesh.matrixWorld);
      if (!cellOf(point.x, point.z, cell)) continue;
      sampled++;
      // La plus basse des surfaces reconnues autour de la case : c'est le sol.
      let level = Infinity;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cell.cx + dx;
          const nz = cell.cz + dz;
          if (nx < 0 || nx >= columns || nz < 0 || nz >= rows) continue;
          const index = nz * columns + nx;
          if (!trustedCells[index]) continue;
          if (rawGround[index] < level) level = rawGround[index];
        }
      }
      if (level === Infinity) continue;
      overGround++;
      if (point.y - level > DECAL_LIFT) lifted++;
    }
    if (sampled < 4 || overGround / sampled < 0.5) continue;
    if (lifted / overGround < 0.5) continue;
    mesh.visible = false;
    overlayMeshes.push(mesh);
    const at = groundMeshes.indexOf(mesh);
    if (at >= 0) groundMeshes.splice(at, 1);
    const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    decals.push(nameOf(mesh) || material?.name || 'sans nom');
  }
  if (decals.length) {
    console.log(`Circuit : ${decals.length} décors à plat retirés du sol (${decals.join(', ')})`);
  }

  CIRCUIT.ground = (x, z) => {
    if (!cellOf(x, z, cell)) return null;
    const index = cell.cz * columns + cell.cx;
    if (!covered[index]) return null;
    const plate = groundY[index] - GROUND_MARGIN;
    // Le raccord ne concerne que le pourtour : dans l'emprise du modèle, la cote
    // reste celle du sol de secours, même loin de tout sommet échantillonné.
    // Sinon le talus remontait vers le relief naturel *à l'intérieur* du
    // circuit — sur la carte du circuit, les collines du bord montent à 50 m, et
    // le terrain traversait la piste à leur niveau (3 m d'herbe en travers de
    // l'asphalte au nord du tracé).
    if (insidePlate(x, z)) return plate;
    const distance = Math.max(0, ring[index] - HOLE_PASSES) * SAMPLE_STEP;
    if (distance <= 0) return plate;
    return fadeGround(plate, terrainBaseHeight(x, z), distance);
  };

  floorAt = (x, z) => {
    // La surface du modèle n'existe que dans son emprise : dans le talus, c'est
    // le terrain qui est la surface du jeu.
    if (!insidePlate(x, z) || !cellOf(x, z, cell)) return null;
    const index = cell.cz * columns + cell.cx;
    if (!covered[index] || surfaceY[index] === -Infinity) return null;
    return surfaceY[index];
  };

  CIRCUIT.surface = (x, z): SurfaceKind | null => {
    if (!insidePlate(x, z) || !cellOf(x, z, cell)) return null;
    const index = cell.cz * columns + cell.cx;
    if (!covered[index]) return null;
    if (asphaltMask[index]) return 'asphalte';
    if (looseMask[index]) return 'terre';
    return 'herbe';
  };

  // 4. Deux trimeshes : le sol (herbe, asphalte, terre) dans le groupe du sol,
  // et tout le reste — murs, glissières, gradins, piliers — dans le groupe des
  // structures. Avant, le modèle entier n'était que dans le premier et le
  // châssis ne collisionne qu'avec le second : les murs n'avaient aucune
  // collision, on les traversait sans rien sentir.
  const buildStarted = performance.now();
  const allMeshes: THREE.Mesh[] = [];
  root.traverse((object) => {
    if (!(object as THREE.Mesh).isMesh) return;
    const mesh = object as THREE.Mesh;
    if (overlayMeshes.includes(mesh)) return;
    allMeshes.push(mesh);
  });
  const surfaceMeshes = new Set<THREE.Mesh>([...groundMeshes, ...asphaltMeshes, ...looseMeshes]);

  const appendTrimesh = (list: THREE.Mesh[], groups: number): number => {
    if (list.length === 0) return 0;
    let vertexTotal = 0;
    let indexTotal = 0;
    for (const mesh of list) {
      vertexTotal += mesh.geometry.attributes.position.count;
      const index = mesh.geometry.index;
      indexTotal += index ? index.count : mesh.geometry.attributes.position.count;
    }
    const vertices = new Float32Array(vertexTotal * 3);
    const indices = new Uint32Array(indexTotal);
    let vertexOffset = 0;
    let indexOffset = 0;
    for (const mesh of list) {
      const positions = mesh.geometry.attributes.position;
      for (let i = 0; i < positions.count; i++) {
        point.fromBufferAttribute(positions, i).applyMatrix4(mesh.matrixWorld);
        vertices[(vertexOffset + i) * 3] = point.x;
        vertices[(vertexOffset + i) * 3 + 1] = point.y;
        vertices[(vertexOffset + i) * 3 + 2] = point.z;
      }
      const index = mesh.geometry.index;
      if (index) {
        for (let i = 0; i < index.count; i++) indices[indexOffset + i] = vertexOffset + index.getX(i);
        indexOffset += index.count;
      } else {
        for (let i = 0; i < positions.count; i++) indices[indexOffset + i] = vertexOffset + i;
        indexOffset += positions.count;
      }
      vertexOffset += positions.count;
    }
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    world.createCollider(
      RAPIER.ColliderDesc.trimesh(vertices, indices)
        .setFriction(0.95)
        .setRestitution(0.02)
        .setCollisionGroups(groups),
      body,
    );
    return indexTotal / 3;
  };

  /**
   * Dalle pleine et plate sous tout le circuit. Le trimesh de la piste avait des
   * trous et des arêtes qui faisaient décoller la voiture ; une dalle ne peut ni
   * manquer ni rebondir : restitution nulle, friction d'asphalte.
   */
  // Le sol que lisent les roues est la surface visible elle-même : les triangles
  // d'asphalte et de gravier du modèle, transformés dans le repère du monde.
  // Pas de grille, pas de dalle, pas de lissage : la voiture ne peut ni flotter
  // au-dessus ni passer sous la piste, et aucune arête inventée ne la fait
  // décoller. La surface du modèle est continue là où le joueur roule.
  const groundTriangles = appendTrimesh([...asphaltMeshes, ...looseMeshes], GROUND_GROUP);
  // Le châssis est membre de GROUP_WORLD et filtre sur GROUP_WORLD (voir
  // CHASSIS_UPRIGHT) : les murs doivent porter exactement ce couple.
  const wallTriangles = appendTrimesh(
    allMeshes.filter((mesh) => !surfaceMeshes.has(mesh)),
    (GROUP_WORLD << 16) | GROUP_WORLD,
  );
  console.log(
    `Circuit : ${Math.round(groundTriangles)} triangles de sol, ` +
      `${Math.round(wallTriangles)} de structures (murs et décor) dans le collider`,
  );

  // 5. Piste uniforme. Le modèle en a une mosaïque de tuiles photo dont les gris
  // ne se raccordent pas : à l'échelle réelle (1 unité = 1 m) ça se lit comme des
  // plaques, et c'est ce que le joueur voit. On repose l'asphalte en UV planaires
  // pris dans le monde sur une seule matière pour toute la piste : plus aucun
  // raccord entre primitives. La pénombre des bords viendra des ombres portées
  // (entrée du backlog), pas de la mosaïque.
  const asphaltMap = createAsphaltTexture();
  asphaltMap.anisotropy = options.anisotropy;
  const trackMaterial = new THREE.MeshStandardMaterial({
    map: asphaltMap,
    roughness: 0.93,
    metalness: 0,
  });
  let trackQuads = 0;
  for (const mesh of asphaltMeshes) {
    if (!TRACK_IMAGES.test(nameOf(mesh))) continue;
    const uv = mesh.geometry.attributes.uv;
    const positions = mesh.geometry.attributes.position;
    if (!uv || uv.count !== positions.count) continue;
    for (let i = 0; i < positions.count; i++) {
      point.fromBufferAttribute(positions, i).applyMatrix4(mesh.matrixWorld);
      const [u, v] = trackUv(point.x, point.z, TRACK_TILE);
      uv.setXY(i, u, v);
    }
    uv.needsUpdate = true;
    mesh.material = trackMaterial;
    trackQuads++;
  }
  console.log(`Piste : asphalte uniforme sur ${trackQuads} maillages (trame de ${TRACK_TILE} m)`);

  // 6. Textures étirées. Terrain, glissières, murs du pont : le modèle porte une
  // image de 16 à 64 px sur des centaines de mètres, ce qui ne se lit plus comme
  // une matière mais comme un aplat — c'est ce qui restait de « blocs sans
  // texture ». On garde leur image et on refait les UV en projection planaire,
  // sur le plan de la face la plus large (déduit de la boîte englobante), avec
  // une répétition tous les RETILE_METRES mètres.
  const box = new THREE.Box3();
  const size = new THREE.Vector3();
  const scratch = new THREE.Vector3();
  let retiled = 0;
  for (const mesh of allMeshes) {
    if (surfaceMeshes.has(mesh)) continue;
    const material = (
      Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
    ) as THREE.MeshStandardMaterial;
    const map = material?.map;
    const image = map?.image as { width?: number; height?: number } | undefined;
    if (!map || !image?.width || !image.height) continue;
    if (image.width * image.height > RETILE_MAX_PIXELS) continue;
    box.setFromObject(mesh);
    box.getSize(size);
    if (Math.max(size.x, size.y, size.z) < RETILE_MIN_SIZE) continue;
    // Une trame ne se pose que sur un mur, une glissière, un talus. Une plaque
    // horizontale — marquage, dalle, gomme — recevait des UV projetés à la
    // verticale et se lisait comme une texture cassée posée sur la piste.
    if (size.y < Math.max(size.x, size.z) * 0.2) continue;
    // L'axe le plus fin est la normale de la face : on projette sur les deux autres.
    const thin = size.x <= size.y && size.x <= size.z ? 0 : size.y <= size.z ? 1 : 2;
    const axisA = thin === 2 ? 0 : thin === 1 ? 0 : 2;
    const axisB = thin === 0 ? 1 : 2;
    const uv = mesh.geometry.attributes.uv;
    const positions = mesh.geometry.attributes.position;
    if (!uv || uv.count !== positions.count) continue;
    for (let i = 0; i < positions.count; i++) {
      scratch.fromBufferAttribute(positions, i).applyMatrix4(mesh.matrixWorld);
      uv.setXY(i, scratch.getComponent(axisA) / RETILE_METRES, scratch.getComponent(axisB) / RETILE_METRES);
    }
    uv.needsUpdate = true;
    map.wrapS = map.wrapT = THREE.RepeatWrapping;
    map.needsUpdate = true;
    retiled++;
  }
  console.log(`Matières : ${retiled} maillages retuiles à ${RETILE_METRES} m (textures étirées)`);

  // 7. Départ : la ligne droite des stands, dans le repère du monde.
  const spawnX = CIRCUIT.cx + (START_LOCAL.x * cos + START_LOCAL.z * sin) * CIRCUIT.scale;
  const spawnZ = CIRCUIT.cz + (-START_LOCAL.x * sin + START_LOCAL.z * cos) * CIRCUIT.scale;
  const spawn = {
    x: spawnX,
    z: spawnZ,
    heading: START_LOCAL.heading + CIRCUIT.yaw,
  };

  // Diagnostic des scripts de test (voir scripts/probe-*.mjs) : le classement
  // des maillages, tel qu'il a servi à bâtir le collider.
  (globalThis as unknown as { __sp95Circuit?: unknown }).__sp95Circuit = {
    root,
    groundMeshes,
    asphaltMeshes,
    looseMeshes,
    overlayMeshes,
  };

  return {
    spawn,
    meshes,
    triangles: Math.round(triangles),
    loadMs: Math.round(loadMs),
    buildMs: Math.round(performance.now() - buildStarted),
  };
}
