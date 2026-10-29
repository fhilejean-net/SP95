/**
 * L'outillage des boxes : pont élévateur, servante, moteur, chariot, creeper,
 * palan. Les modèles fournis pesaient 70 Mo à eux tous ; ils sont passés par
 * glTF-Transform (simplification, textures WebP 1024, compression meshopt) et
 * font maintenant 3,6 Mo.
 *
 * Chaque modèle est chargé une fois, normalisé (plus grande longueur
 * horizontale ramenée à sa taille réelle, centré, posé au sol), puis *instancié*
 * sur les huit boxes. Un modèle de quatre maillages coûte donc quatre appels de
 * dessin, pas trente-deux, et la géométrie est partagée.
 *
 * Le chargement est asynchrone et facultatif : si un fichier manque, le box
 * reste vide au lieu de casser le circuit.
 */
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { GROUP_WORLD } from '../physics/vehicle.ts';
import { TRACK } from '../world/trackLayout.ts';
import { DRIFT_PAD } from '../world/driftPad.ts';
import {
  GARAGE_FRONT_X,
  PIT_LANE_FROM,
  PIT_LANE_TO,
  PIT_THROATS,
  STALL_COUNT,
  stallCentre,
} from '../world/pitLayout.ts';

/** Même groupe de collision que les murs : la voiture bute sur l'outillage. */
const PROP_GROUP = (GROUP_WORLD << 16) | GROUP_WORLD;
/** Cote de pose des modèles, un cheveu au-dessus de la dalle. */
const FLOOR_Y = 0.06;

const MODEL_ROOT = import.meta.env.BASE_URL;
const PIT_DIR = 'models/pit/';
const Y_AXIS = new THREE.Vector3(0, 1, 0);

interface ModelSpec {
  /** Longueur cible du plus grand côté horizontal, en mètres. */
  length?: number;
  /** Hauteur cible, quand la longueur seule écrase le modèle. */
  height?: number;
  /** Rotation appliquée après normalisation, en radians. */
  yaw?: number;
}

interface PropSpec extends ModelSpec {
  file: string;
}

/**
 * Tailles réelles : un pont fait la longueur d'une voiture, une servante tient
 * contre le mur, un moteur se porte à deux. Une seule cote pilote l'échelle —
 * appliquer une longueur *puis* une hauteur rapetissait les ponts deux fois.
 */
const PROPS = {
  lift: { file: 'hydraulic_car_lift.glb', length: 4.8 },
  elevator: { file: 'car_elevator_free.glb', length: 4.6 },
  chest: { file: 'tool_chest.glb', height: 1.2 },
  engine: { file: 'car_engine.glb', height: 0.9 },
  trolley: { file: 'trolley_jack_lo_poly.glb', length: 1.7, yaw: Math.PI / 2 },
  // Un creeper se glisse sous une voiture : la taille d'un humain allongé.
  creeper: { file: 'mechanic_creeper.glb', length: 1.6 },
  hoist: { file: 'engine_hoist_-_engine_crane.glb', length: 1.7 },
  // Les modèles détaillés ajoutés au dépôt.
  raceFence: { file: 'race_fence.glb', length: 3.4 },
  urbanTree: { file: 'urban_tree.glb', height: 7.5 },
  barrier: { file: 'barrier.glb', length: 2.9 },
  metalBarrier: { file: 'metal_barrier__game_ready__4k.glb', length: 3.1 },
  pitBoard: { file: 'pit_board.glb', height: 1.7 },
} satisfies Record<string, PropSpec>;

type PropName = keyof typeof PROPS;

interface Placement {
  x: number;
  z: number;
  /** Rotation propre à cette pose, ajoutée à celle du modèle. */
  yaw: number;
  /** Hauteur de pose ; par défaut, la dalle. */
  y?: number;
}

/** Positions dans un box : la voie est à droite, le fond à gauche. */
function placements(): Record<PropName, Placement[]> {
  const list: Record<PropName, Placement[]> = {
    lift: [],
    elevator: [],
    chest: [],
    engine: [],
    trolley: [],
    creeper: [],
    hoist: [],
    raceFence: [],
    urbanTree: [],
    barrier: [],
    metalBarrier: [],
    pitBoard: [],
  };
  for (let index = 0; index < STALL_COUNT; index++) {
    const centre = stallCentre(index);
    // Un pont par box, alterné : le pont ciseaux est lourd (23 000 triangles),
    // l'élévateur quatre colonnes en coûte 1 200 et fait le même effet.
    if (index % 2 === 0) list.lift.push({ x: -40.4, z: centre, yaw: 0 });
    else list.elevator.push({ x: -40.4, z: centre, yaw: 0 });
    // Servante et chariot contre la façade, de part et d'autre de la porte.
    list.chest.push({ x: GARAGE_FRONT_X - 0.9, z: centre - 2.9, yaw: 0 });
    list.trolley.push({ x: GARAGE_FRONT_X - 1.2, z: centre + 2.5, yaw: 0 });
    // Moteur au fond dans quatre boxes, creeper sous le pont dans deux autres :
    // chaque box a son outillage propre sans répéter les six modèles huit fois.
    if (index % 4 === 0) list.engine.push({ x: -44.2, z: centre + 2.4, yaw: Math.PI * 0.5 });
    if (index === 1 || index === 5) list.creeper.push({ x: -40.6, z: centre + 2.2, yaw: 0 });
  }
  // Un palan dans deux boxes seulement : c'est un engin, pas un meuble.
  for (const index of [2, 5]) {
    list.hoist.push({ x: -43.4, z: stallCentre(index) - 0.4, yaw: Math.PI * 0.5 });
  }
  // Le paddock derrière les stands : une seule ligne de clôtures anti-
  // spectateurs, face aux garages, et les arbres derrière — plus de clôture
  // au milieu de la dalle ni d'arbre planté dans la voie.
  for (let z = -512; z <= -262; z += 3.6) {
    list.raceFence.push({ x: -51.6, z, yaw: Math.PI / 2 });
  }
  for (let z = -496; z <= -276; z += 27) {
    list.urbanTree.push({ x: -58.5, z, yaw: 0 });
  }
  for (let index = 0; index < STALL_COUNT; index++) {
    list.pitBoard.push({ x: GARAGE_FRONT_X + 0.6, z: stallCentre(index) - 4.4, yaw: 0 });
  }
  return list;
}

export interface PitPropsSummary {
  meshes: number;
  triangles: number;
  models: number;
  colliders: number;
  loadMs: number;
}

/**
 * Le petit mobilier du pack de circuit fourni : neuf familles extraites dans un
 * GLB de 860 Ko (voir `scripts/extract-pit-clutter.mjs`). Il meuble les boxes
 * et les abords de la voie — pneus, cônes, barils, barrières — là où l'atelier
 * en avait besoin pour ne pas ressembler à une dalle vide.
 */
const CLUTTER_FILE = 'clutter.glb';

interface ClutterSpec extends ModelSpec {
  /** Nom du nœud détaché dans `clutter.glb`. */
  node: string;
  /** Vrai si l'objet est assez haut pour arrêter la voiture. */
  solid: boolean;
}

const CLUTTER: Record<string, ClutterSpec> = {
  tyreWall: { node: 'pneuWall', length: 3.2, solid: true },
  tyreStack: { node: '3pneu', length: 1.05, solid: true },
  tyreBlack: { node: '1Bpneu', length: 0.66, solid: false },
  tyreWhite: { node: '1Wpneu', length: 0.66, solid: false },
  cone: { node: 'cone', length: 0.55, solid: false },
  barrelYellow: { node: 'barrelY', length: 0.56, solid: true },
  barrelRed: { node: 'barrelRed', length: 0.56, solid: true },
  barrier: { node: 'barriersSmall', length: 1.9, solid: true },
  startLights: { node: 'startLights', length: 2.4, solid: false },
};

type ClutterName = keyof typeof CLUTTER;

/**
 * Le mobilier se range le long de la façade, jamais dans la voie : un cône au
 * milieu de la voie des stands serait un piège, pas un décor. Les cônes bordent
 * la dalle côté garages, les pneus s'empilent devant les boxes.
 */
function clutterPlacements(): Record<ClutterName, Placement[]> {
  const list: Record<ClutterName, Placement[]> = {
    tyreWall: [],
    tyreStack: [],
    tyreBlack: [],
    tyreWhite: [],
    cone: [],
    barrelYellow: [],
    barrelRed: [],
    barrier: [],
    startLights: [],
  };
  const front = GARAGE_FRONT_X + 1.1;
  for (let index = 0; index < STALL_COUNT; index++) {
    const centre = stallCentre(index);
    // Une pile de pneus par box, et deux pneus libres qui traînent.
    list.tyreStack.push({ x: front, z: centre + 3.2, yaw: 0 });
    list.tyreBlack.push({ x: front + 0.2, z: centre + 2.2, yaw: 0.5 });
    list.tyreWhite.push({ x: front + 0.5, z: centre + 2.05, yaw: 1.2 });
    if (index % 2 === 0) list.barrelYellow.push({ x: front + 0.3, z: centre - 3.1, yaw: 0 });
    else list.barrelRed.push({ x: front + 0.3, z: centre - 3.1, yaw: 0 });
  }
  // Murs de pneus aux deux extrémités de la voie, et barrières aux entrées.
  for (const z of [PIT_LANE_FROM + 8, PIT_LANE_TO - 8]) {
    list.tyreWall.push({ x: front + 0.4, z, yaw: 0 });
  }
  for (const throat of PIT_THROATS) {
    list.barrier.push({ x: front + 0.2, z: throat.from + 1.6, yaw: 0 });
    list.barrier.push({ x: front + 0.2, z: throat.to - 1.6, yaw: 0 });
  }
  // Cônes tous les 24 m, côté garages, hors de la trajectoire.
  for (let z = PIT_LANE_FROM + 26; z < PIT_LANE_TO - 12; z += 24) {
    list.cone.push({ x: front + 1.5, z, yaw: 0 });
  }
  // L'aire de gymkhana : les plots dessinent le slalom et les pneus ferment
  // les cordes. Ils sont posés sur la dalle, donc hors de la voie des stands.
  for (let i = -3; i <= 3; i++) {
    list.cone.push({ x: DRIFT_PAD.cx - 27 + i * 9, z: DRIFT_PAD.cz + 26, yaw: 0 });
  }
  for (let i = 0; i < 14; i++) {
    const angle = (i / 14) * Math.PI * 2;
    list.cone.push({
      x: DRIFT_PAD.cx + Math.cos(angle) * 40,
      z: DRIFT_PAD.cz + Math.sin(angle) * 36,
      yaw: angle,
    });
  }
  for (const [dx, dz] of [[-52, -34], [52, -34], [-52, 34], [52, 34]]) {
    list.tyreStack.push({ x: DRIFT_PAD.cx + dx, z: DRIFT_PAD.cz + dz, yaw: 0 });
  }
  // Le feu de départ, en hauteur au bout de la voie : il ne gêne personne.
  list.startLights.push({ x: -24.2, z: PIT_LANE_TO - 6, y: 4.4, yaw: Math.PI / 2 });
  return list;
}

/**
 * Boîte englobante *robuste* : elle lit les sommets et jette les 0,5 % les
 * plus extrêmes. Les GLB de Sketchfab traînent souvent un sommet perdu à des
 * kilomètres, qui gonfle la Box3 de three : le modèle est alors réduit à une
 * poussière et posé à côté de son support — c'est ce qui rendait les
 * clôtures, les arbres et les ponts minuscules et flottants.
 */
function robustBox(root: THREE.Object3D): THREE.Box3 {
  root.updateMatrixWorld(true);
  const axes: number[][] = [[], [], []];
  const vertex = new THREE.Vector3();
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const position = child.geometry.attributes.position as THREE.BufferAttribute | undefined;
    if (!position) return;
    const step = Math.max(1, Math.floor(position.count / 4000));
    for (let i = 0; i < position.count; i += step) {
      vertex.fromBufferAttribute(position, i).applyMatrix4(child.matrixWorld);
      axes[0].push(vertex.x);
      axes[1].push(vertex.y);
      axes[2].push(vertex.z);
    }
  });
  if (axes[0].length === 0) return new THREE.Box3().setFromObject(root);
  const percentile = (list: number[], p: number): number => {
    list.sort((a, b) => a - b);
    return list[Math.min(list.length - 1, Math.max(0, Math.floor(p * (list.length - 1))))];
  };
  return new THREE.Box3(
    new THREE.Vector3(percentile(axes[0], 0.005), percentile(axes[1], 0.005), percentile(axes[2], 0.005)),
    new THREE.Vector3(percentile(axes[0], 0.995), percentile(axes[1], 0.995), percentile(axes[2], 0.995)),
  );
}

/**
 * Normalise un modèle : plus grande longueur horizontale couchée sur X,
 * centré en X/Z, bas posé à y = 0. Une seule cote pilote l'échelle : la
 * longueur, ou la hauteur quand le modèle est plus haut que long (une
 * servante, un arbre).
 */
function normalize(root: THREE.Object3D, spec: ModelSpec): THREE.Vector3 {
  let box = robustBox(root);
  let size = box.getSize(new THREE.Vector3());
  if (size.z > size.x) {
    root.rotation.y += Math.PI / 2;
    box = robustBox(root);
    box.getSize(size);
  }
  const source = spec.height ? size.y : Math.max(size.x, size.z);
  const target = spec.height ?? spec.length ?? source;
  root.scale.multiplyScalar(target / Math.max(0.001, source));
  root.updateMatrixWorld(true);
  box = robustBox(root);
  size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  root.position.set(-centre.x, -box.min.y, -centre.z);
  root.updateMatrixWorld(true);
  // Cotes après normalisation : elles servent à poser la boîte de collision.
  return size;
}

/**
 * Une boîte de collision par pose. La voiture ne passe plus au travers d'un
 * pont, d'une servante ou d'une pile de pneus ; les objets bas (cônes, pneus
 * couchés) sont laissés traversables, une boîte invisible plus haute qu'eux
 * serait pire que le décor lui-même.
 */
function collide(
  world: RAPIER.World,
  list: Placement[],
  size: THREE.Vector3,
  specYaw: number,
): number {
  if (list.length === 0) return 0;
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const half = { x: Math.max(0.05, size.x / 2), y: Math.max(0.05, size.y / 2), z: Math.max(0.05, size.z / 2) };
  const rotation = new THREE.Quaternion();
  for (const spot of list) {
    rotation.setFromAxisAngle(Y_AXIS, spot.yaw + specYaw);
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z)
        .setTranslation(spot.x, (spot.y ?? FLOOR_Y) + half.y, spot.z)
        .setRotation({ x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w })
        .setFriction(0.8)
        .setRestitution(0.04)
        .setCollisionGroups(PROP_GROUP),
      body,
    );
  }
  return list.length;
}

/** Matériaux : reflets du ciel et filtrage anisotrope, comme les voitures. */
function prepare(root: THREE.Object3D, anisotropy: number): void {
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    child.castShadow = false;
    child.receiveShadow = true;
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) {
      if (material instanceof THREE.MeshStandardMaterial) {
        material.envMapIntensity = 1;
        material.roughness = Math.max(0.25, material.roughness);
      }
      for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap'] as const) {
        const texture = (material as THREE.MeshStandardMaterial)[key];
        if (texture) texture.anisotropy = anisotropy;
      }
      material.needsUpdate = true;
    }
  });
}

/**
 * Instancie un modèle normalisé sur toutes ses poses. On garde la matrice
 * monde de chaque maillage par rapport à la racine (identité au sol) pour que
 * les pièces d'un même modèle restent solidaires.
 */
function instance(
  root: THREE.Object3D,
  list: Placement[],
  spec: ModelSpec,
  scene: THREE.Scene,
  name: string,
): { meshes: number; triangles: number } {
  if (list.length === 0) return { meshes: 0, triangles: 0 };
  root.updateMatrixWorld(true);
  const parts: { geometry: THREE.BufferGeometry; material: THREE.Material | THREE.Material[]; local: THREE.Matrix4 }[] = [];
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh) || (child as THREE.SkinnedMesh).isSkinnedMesh) return;
    parts.push({
      geometry: child.geometry,
      material: child.material,
      local: child.matrixWorld.clone(),
    });
  });

  const place = new THREE.Matrix4();
  const composed = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  let meshes = 0;
  let triangles = 0;
  for (const part of parts) {
    const mesh = new THREE.InstancedMesh(part.geometry, part.material, list.length);
    list.forEach((spot, index) => {
      quaternion.setFromAxisAngle(Y_AXIS, spot.yaw + (spec.yaw ?? 0));
      place.compose(
        new THREE.Vector3(spot.x, spot.y ?? FLOOR_Y, spot.z),
        quaternion,
        new THREE.Vector3(1, 1, 1),
      );
      mesh.setMatrixAt(index, composed.multiplyMatrices(place, part.local));
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.name = `pit-prop-${name}`;
    scene.add(mesh);
    meshes += 1;
    const geometry = part.geometry;
    const count = geometry.index ? geometry.index.count / 3 : geometry.attributes.position.count / 3;
    triangles += Math.round(count * list.length);
  }
  return { meshes, triangles };
}

/**
 * Les portiques de Sketchfab déclarent leurs textures en
 * `KHR_materials_pbrSpecularGlossiness`, une extension que three n'implémente
 * plus : sans ce greffon, les bandeaux sortent gris. On reporte la couleur et
 * la texture diffuse sur un matériau standard, qui est ce que le jeu rend.
 */
class SpecularGlossinessPlugin {
  readonly name = 'KHR_materials_pbrSpecularGlossiness';
  private readonly parser: {
    json: { materials?: { extensions?: Record<string, unknown> }[] };
    assignTexture: (params: object, key: string, value: unknown, space: string) => Promise<unknown>;
  };

  constructor(parser: SpecularGlossinessPlugin['parser']) {
    this.parser = parser;
  }

  getMaterialType(index: number): typeof THREE.MeshStandardMaterial | null {
    const material = this.parser.json.materials?.[index];
    return material?.extensions?.[this.name] ? THREE.MeshStandardMaterial : null;
  }

  extendMaterialParams(index: number, params: Record<string, unknown>): Promise<unknown> {
    const material = this.parser.json.materials?.[index];
    const extension = material?.extensions?.[this.name] as
      | { diffuseFactor?: number[]; diffuseTexture?: unknown }
      | undefined;
    if (!extension) return Promise.resolve();
    params.color = new THREE.Color(1, 1, 1);
    if (Array.isArray(extension.diffuseFactor)) {
      (params.color as THREE.Color).fromArray(extension.diffuseFactor);
      params.opacity = extension.diffuseFactor[3] ?? 1;
    }
    params.metalness = 0.1;
    params.roughness = 0.85;
    if (!extension.diffuseTexture) return Promise.resolve();
    return this.parser.assignTexture(params, 'map', extension.diffuseTexture, THREE.SRGBColorSpace);
  }
}

/** Largeur des portiques : ils traversent la piste d'un dégagement à l'autre. */
const GANTRY_WIDTH = 22;
/** Distance de la ligne de départ, identique à celle du marquage au sol. */
const GANTRY_DISTANCE = 8;

/**
 * Les deux portiques fournis, posés sur la ligne droite. Le bandeau de départ
 * fait face aux voitures qui arrivent ; le portique d'arrivée le suit de
 * quarante-six mètres. **Seuls les mâts** portent une collision : entre les
 * deux, on passe — c'était une boîte pleine qui faisait un mur invisible.
 */
async function buildGantries(
  scene: THREE.Scene,
  world: RAPIER.World,
  anisotropy: number,
): Promise<{ meshes: number; triangles: number; models: number; colliders: number }> {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  loader.register((parser) => new SpecularGlossinessPlugin(parser as never));
  const first = TRACK.samples[0];
  const anchor = {
    x: first.x + first.tx * GANTRY_DISTANCE,
    z: first.z + first.tz * GANTRY_DISTANCE,
  };
  const heading = Math.atan2(first.tx, first.tz);
  const specs = [
    { file: 'starting_line.glb', offset: 0 },
    { file: 'finish_line.glb', offset: 46 },
  ];
  let meshes = 0;
  let triangles = 0;
  let models = 0;
  let colliders = 0;
  for (const spec of specs) {
    try {
      const gltf = await loader.loadAsync(`${MODEL_ROOT}${PIT_DIR}${spec.file}`);
      const root = gltf.scene;
      const size = normalize(root, { length: GANTRY_WIDTH });
      prepare(root, anisotropy);
      root.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) return;
        child.castShadow = false;
        child.receiveShadow = true;
        meshes += 1;
        const geometry = child.geometry;
        triangles += geometry.index ? geometry.index.count / 3 : geometry.attributes.position.count / 3;
      });
      const holder = new THREE.Group();
      holder.add(root);
      holder.position.set(
        anchor.x + first.tx * spec.offset,
        FLOOR_Y,
        anchor.z + first.tz * spec.offset,
      );
      // Le bandeau du modèle regarde +Z : on le retourne vers les voitures.
      holder.rotation.y = heading + Math.PI;
      scene.add(holder);
      models += 1;

      const half = size.x / 2 - 0.4;
      const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
      for (const side of [-1, 1]) {
        world.createCollider(
          RAPIER.ColliderDesc.cuboid(0.45, size.y / 2, 0.45)
            .setTranslation(
              holder.position.x + side * half * Math.cos(holder.rotation.y),
              holder.position.y + size.y / 2,
              holder.position.z - side * half * Math.sin(holder.rotation.y),
            )
            .setFriction(0.7)
            .setRestitution(0.05)
            .setCollisionGroups(PROP_GROUP),
          body,
        );
        colliders += 1;
      }
    } catch (error) {
      console.warn(`Portique manquant : ${spec.file}`, error);
    }
  }
  return { meshes, triangles, models, colliders };
}

export async function buildPitProps(
  scene: THREE.Scene,
  world: RAPIER.World,
  anisotropy: number,
): Promise<PitPropsSummary> {
  const started = performance.now();
  const loader = new GLTFLoader();
  // Les modèles sont compressés en meshopt : sans ce décodeur, la géométrie
  // n'arrive pas et les boxes restent vides.
  loader.setMeshoptDecoder(MeshoptDecoder);
  const spots = placements();
  const names = Object.keys(PROPS) as PropName[];
  const results = await Promise.allSettled([
    ...names.map((name) => loader.loadAsync(`${MODEL_ROOT}${PIT_DIR}${PROPS[name].file}`)),
    loader.loadAsync(`${MODEL_ROOT}${PIT_DIR}${CLUTTER_FILE}`),
  ]);

  let meshes = 0;
  let triangles = 0;
  let models = 0;
  let colliders = 0;
  results.forEach((result, index) => {
    if (index >= names.length) return;
    const name = names[index];
    if (result.status !== 'fulfilled') {
      console.warn(`Prop de stand manquant : ${PROPS[name].file}`, result.reason);
      return;
    }
    const root = result.value.scene;
    // L'arbre urbain arrive avec des matériaux blancs sans texture : on rend
    // le vert au *feuillage* et le brun à l'écorce, par nom de matériau. Teinter
    // tous les matériaux blancs peignait aussi le tronc en vert.
    if (name === 'urbanTree') {
      root.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) return;
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        for (const material of materials) {
          if (!(material instanceof THREE.MeshStandardMaterial) || material.map) continue;
          const label = `${material.name} ${child.name}`.toLowerCase();
          if (/folh|leaf|leav|crown|canop|feuill/.test(label)) {
            material.color.setHex(0x4f7a3a);
            material.roughness = 0.92;
          } else if (/galho|branch|trunk|bark|tronc|wood/.test(label)) {
            material.color.setHex(0x5b4632);
            material.roughness = 0.95;
          }
        }
      });
    }
    const size = normalize(root, PROPS[name]);
    prepare(root, anisotropy);
    const built = instance(root, spots[name], PROPS[name], scene, PROPS[name].file.replace('.glb', ''));
    meshes += built.meshes;
    triangles += built.triangles;
    models += 1;
    // Un objet bas (creeper, caisse à outils couchée) se franchit : une boîte
    // de collision plus haute que lui arrêterait la voiture sur du vide.
    if (size.y >= 0.34) {
      colliders += collide(world, spots[name], size, (PROPS[name] as PropSpec).yaw ?? 0);
    }
  });

  const gantries = await buildGantries(scene, world, anisotropy);
  meshes += gantries.meshes;
  triangles += gantries.triangles;
  models += gantries.models;
  colliders += gantries.colliders;

  const clutter = results[names.length];
  if (clutter?.status === 'fulfilled') {
    const clutterSpots = clutterPlacements();
    for (const name of Object.keys(CLUTTER) as ClutterName[]) {
      const spec = CLUTTER[name];
      const node = clutter.value.scene.getObjectByName(spec.node);
      if (!node) {
        console.warn(`Mobilier de stand absent du GLB : ${spec.node}`);
        continue;
      }
      const holder = new THREE.Group();
      holder.add(node.clone(true));
      const size = normalize(holder, spec);
      prepare(holder, anisotropy);
      const built = instance(holder, clutterSpots[name], spec, scene, spec.node);
      meshes += built.meshes;
      triangles += built.triangles;
      models += 1;
      if (spec.solid) colliders += collide(world, clutterSpots[name], size, spec.yaw ?? 0);
    }
  } else {
    console.warn(`Mobilier de stand manquant : ${CLUTTER_FILE}`, clutter?.reason);
  }

  return { meshes, triangles, models, colliders, loadMs: performance.now() - started };
}
