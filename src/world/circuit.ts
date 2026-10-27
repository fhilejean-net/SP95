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
 * Primitives que le fichier laisse sans la moindre texture et qui se lisent comme
 * un bloc plein posé au bord de la piste — le bloc du panneau stop, sous le
 * pont. Masquées, elles sortent du rendu **et** du collider.
 */
const HIDDEN_PRIMITIVES = new Set(['towerdisplay2']);

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
/** Rayon dont un sommet prend la cote médiane, en mètres. */
const ROAD_SMOOTH_RADIUS = 3;
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
  /** Pente la plus forte entre deux sommets reliés par une arête, en %. */
  maxGrade: number;
}

/**
 * Surface roulable lissée, **dans la topologie du modèle**.
 *
 * Une trame régulière posée sur les carreaux du fichier laissait des trous : une
 * dalle d'asphalte de trente mètres de long n'a aucun sommet dans les cases
 * intermédiaires, leurs quads n'avaient donc pas de coin connu et étaient jetés.
 * Il restait des trous dans le collider — la voiture tombait à travers la piste,
 * sous l'asphalte. Ici chaque triangle d'asphalte reste un triangle du collider :
 * aucune case ne peut manquer sous une roue.
 *
 * Seules les cotes bougent : un sommet prend la médiane de ses voisins à
 * `ROAD_SMOOTH_RADIUS` mètres, sur le même tablier — les deux pistes du
 * croisement en huit se croisent à sept mètres l'une au-dessus de l'autre et ne
 * doivent pas se moyenner. Le dévers et les vibreurs sont moyennés, la montée du
 * tour reste.
 */
export function buildFlatRoad(meshes: THREE.Mesh[]): FlatRoad {
  const point = new THREE.Vector3();
  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  const indices: number[] = [];

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
      for (let i = 0; i < index.count; i++) indices.push(start + index.getX(i));
    } else {
      for (let i = 0; i < positions.count; i++) indices.push(start + i);
    }
  }

  // Voisinage par cases creuses : un sommet ne se compare qu'aux siens au lieu
  // des dizaines de milliers du modèle. La grille est prise dans le monde, donc
  // deux primitives qui partagent un sommet lui trouvent le même voisinage.
  const buckets = new Map<number, number[]>();
  const keyOf = (cx: number, cz: number) => (cx + 100000) * 1000000 + (cz + 100000);
  const cellIndex = (value: number) => Math.floor(value / ROAD_CELL);
  for (let i = 0; i < xs.length; i++) {
    const key = keyOf(cellIndex(xs[i]), cellIndex(zs[i]));
    const list = buckets.get(key);
    if (list) list.push(i);
    else buckets.set(key, [i]);
  }

  const radiusSq = ROAD_SMOOTH_RADIUS * ROAD_SMOOTH_RADIUS;
  const heights = new Float32Array(xs.length);
  const samples: number[] = [];
  for (let i = 0; i < xs.length; i++) {
    const cx = cellIndex(xs[i]);
    const cz = cellIndex(zs[i]);
    samples.length = 0;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const list = buckets.get(keyOf(cx + dx, cz + dz));
        if (!list) continue;
        for (const j of list) {
          // Deux tabliers superposés gardent chacun leur cote.
          if (Math.abs(ys[j] - ys[i]) > ROAD_LEVEL_TOL) continue;
          const ex = xs[j] - xs[i];
          const ez = zs[j] - zs[i];
          if (ex * ex + ez * ez > radiusSq) continue;
          samples.push(ys[j]);
        }
      }
    }
    // Un sommet isolé (bord de piste) garde sa cote.
    if (samples.length === 0) {
      heights[i] = ys[i];
      continue;
    }
    heights[i] = median(samples);
  }

  /*
   * Deuxième passe : la moyenne du voisinage, prise sur les cotes déjà médianées.
   * Un filtre médian seul ne suffit pas — il recopie une alternance, une marche
   * de vibreur sur deux survit telle quelle. La moyenne, elle, l'efface ; et
   * comme la moyenne d'une pente vaut la cote du centre, la montée du tour
   * traverse intacte. C'est le relief court, celui qui secoue la voiture au
   * freinage et la retourne en courbe, qui disparaît.
   */
  const smoothed = new Float32Array(xs.length);
  for (let i = 0; i < xs.length; i++) {
    const cx = cellIndex(xs[i]);
    const cz = cellIndex(zs[i]);
    let sum = 0;
    let count = 0;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const list = buckets.get(keyOf(cx + dx, cz + dz));
        if (!list) continue;
        for (const j of list) {
          if (Math.abs(ys[j] - ys[i]) > ROAD_LEVEL_TOL) continue;
          const ex = xs[j] - xs[i];
          const ez = zs[j] - zs[i];
          if (ex * ex + ez * ez > radiusSq) continue;
          sum += heights[j];
          count++;
        }
      }
    }
    smoothed[i] = count > 0 ? sum / count : heights[i];
  }

  const vertices = new Float32Array(xs.length * 3);
  for (let i = 0; i < xs.length; i++) {
    vertices[i * 3] = xs[i];
    vertices[i * 3 + 1] = smoothed[i];
    vertices[i * 3 + 2] = zs[i];
  }

  let maxGrade = 0;
  for (let i = 0; i + 2 < indices.length; i += 3) {
    for (let edge = 0; edge < 3; edge++) {
      const a = indices[i + edge];
      const b = indices[i + ((edge + 1) % 3)];
      const run = Math.hypot(xs[a] - xs[b], zs[a] - zs[b]);
      if (run < 0.05) continue;
      const grade = (Math.abs(smoothed[a] - smoothed[b]) / run) * 100;
      if (grade > maxGrade) maxGrade = grade;
    }
  }

  return {
    vertices,
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

  // 2b. Piste plate : la surface que lisent les roues est reconstruite sur une
  // trame régulière, indépendamment de la géométrie du modèle (ses positions
  // sont quantifiées, on ne peut pas les réécrire sans casser le rendu).
  const flatRoad = buildFlatRoad(asphaltMeshes);
  console.log(
    `Piste : collider lissé (topologie du modèle), ${flatRoad.triangles} triangles, ` +
      `pente max ${flatRoad.maxGrade.toFixed(1)} % (voisinage ${ROAD_SMOOTH_RADIUS} m)`,
  );
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

  /** Pose la trame plate de la piste comme surface roulable. */
  const appendFlatRoad = (road: FlatRoad, groups: number): number => {
    if (road.triangles === 0) return 0;
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    world.createCollider(
      RAPIER.ColliderDesc.trimesh(road.vertices, road.indices)
        .setFriction(0.95)
        .setRestitution(0.02)
        .setCollisionGroups(groups),
      body,
    );
    return road.triangles;
  };

  // La piste du modèle rejoint le collider plat, pas le brut : ses bosses et son
  // dévers faisaient sauter et retourner la voiture.
  const groundTriangles =
    appendTrimesh(
      [...surfaceMeshes].filter((mesh) => !asphaltMeshes.includes(mesh)),
      GROUND_GROUP,
    ) + appendFlatRoad(flatRoad, GROUND_GROUP);
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
