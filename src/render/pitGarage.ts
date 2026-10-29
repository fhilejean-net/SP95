/**
 * Les boxes des stands : une façade ouverte, huit cellules, un toit.
 *
 * La version précédente était une boîte pleine posée derrière le muret : on
 * voyait une façade lisse, et les portes étaient des rectangles sombres collés
 * dessus. Ici le bâtiment est un *bâtiment* : murs, cloisons entre boxes, toit,
 * dalle intérieure, encadrements de porte, luminaires. Il est ouvert côté voie,
 * donc on voit l'intérieur de chaque box depuis la voiture — c'est là que les
 * props (pont élévateur, servante, moteur) prennent place.
 *
 * Les murs sont fusionnés par matière : sept appels de dessin pour tout le
 * bâtiment, quel que soit le nombre de boxes. Les collisions se limitent au
 * fond, aux pignons et aux cloisons — la façade reste ouverte.
 */
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { GROUP_WORLD } from '../physics/vehicle.ts';
import { createConcreteTexture } from './materials.ts';
import {
  GARAGE_DEPTH,
  GARAGE_FRONT_X,
  STALL_COUNT,
  STALL_LENGTH,
  STALL_PITCH,
  stallCentre,
} from '../world/pitLayout.ts';

const WALL_GROUP = (GROUP_WORLD << 16) | GROUP_WORLD;
/** Hauteur libre sous le toit, en mètres. */
const CLEAR_HEIGHT = 5.2;
const ROOF_THICK = 0.46;
/** Épaisseur des murs et des cloisons. */
const SHELL = 0.42;
/** Bande d'écurie au-dessus de chaque porte, reprise de la voie. */
const TEAM_COLOURS = [0xb3131b, 0x1d8f6f, 0x2b57a8, 0xe2a119];
const BACK_X = GARAGE_FRONT_X - GARAGE_DEPTH;
/** Bord du bâtiment, un peu au-delà du premier et du dernier box. */
const Z0 = stallCentre(0) - STALL_LENGTH / 2 - 1.1;
const Z1 = stallCentre(STALL_COUNT - 1) + STALL_LENGTH / 2 + 1.1;
const CENTRE_Z = (Z0 + Z1) / 2;
const BUILDING_LENGTH = Z1 - Z0;
const CENTRE_X = (GARAGE_FRONT_X + BACK_X) / 2;

export interface PitGarageBuild {
  triangles: number;
  meshes: number;
}

interface Sink {
  material: THREE.Material;
  geometries: THREE.BufferGeometry[];
}

/**
 * Un box vu depuis la voie : encadrement sombre, linteau, rideau métallique
 * remonté, seuil jaune et noir. Le tout est bâti en boîtes, comme le reste.
 */
function doorFrame(
  solid: THREE.BufferGeometry[],
  dark: THREE.BufferGeometry[],
  trim: THREE.BufferGeometry[],
  yellow: THREE.BufferGeometry[],
  centre: number,
): void {
  const half = STALL_LENGTH / 2;
  const doorWidth = STALL_LENGTH - 1.1;
  const push = (
    list: THREE.BufferGeometry[],
    width: number,
    height: number,
    depth: number,
    x: number,
    y: number,
    z: number,
  ): void => {
    const geometry = new THREE.BoxGeometry(width, height, depth);
    geometry.translate(x, y, z);
    list.push(geometry);
  };
  // Montants, de la dalle au linteau.
  for (const side of [-1, 1]) {
    push(dark, 0.55, CLEAR_HEIGHT, 0.34, GARAGE_FRONT_X, CLEAR_HEIGHT / 2, centre + side * half);
    push(trim, 0.7, 0.5, 0.5, GARAGE_FRONT_X, CLEAR_HEIGHT / 2, centre + side * half);
  }
  // Linteau au-dessus de l'ouverture, et rideau remonté contre lui.
  push(solid, 0.7, 0.62, doorWidth + 0.6, GARAGE_FRONT_X, CLEAR_HEIGHT - 0.31, centre);
  push(dark, 0.42, 0.44, doorWidth, GARAGE_FRONT_X + 0.12, CLEAR_HEIGHT - 0.82, centre);
  // Seuil peint, jaune et noir : la limite de l'atelier se lit au sol.
  for (let stripe = 0; stripe < 7; stripe++) {
    const z = centre - doorWidth / 2 + (stripe + 0.5) * (doorWidth / 7);
    push(yellow, 0.9, 0.03, doorWidth / 15, GARAGE_FRONT_X + 0.4, 0.032, z);
  }
}

export function buildPitGarage(
  scene: THREE.Scene,
  world: RAPIER.World,
  anisotropy: number,
): PitGarageBuild {
  const concrete = createConcreteTexture();
  concrete.repeat.set(5, 3);
  concrete.anisotropy = anisotropy;
  const concreteMat = new THREE.MeshStandardMaterial({
    map: concrete,
    color: 0xd7d3c9,
    roughness: 0.9,
    metalness: 0.03,
  });
  const beigeMat = new THREE.MeshStandardMaterial({
    map: concrete,
    color: 0xc3bdb0,
    roughness: 0.88,
    metalness: 0.03,
  });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x24272b, roughness: 0.68 });
  const trimMat = new THREE.MeshStandardMaterial({ color: 0xe8e4d9, roughness: 0.62 });
  const yellowMat = new THREE.MeshStandardMaterial({ color: 0xd8b233, roughness: 0.72 });
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x3a3e44, roughness: 0.82 });
  const lampMat = new THREE.MeshStandardMaterial({
    color: 0xf6f1e2,
    emissive: 0xfff0cf,
    emissiveIntensity: 1.35,
    roughness: 0.5,
  });

  const concreteParts: THREE.BufferGeometry[] = [];
  const beigeParts: THREE.BufferGeometry[] = [];
  const darkParts: THREE.BufferGeometry[] = [];
  const trimParts: THREE.BufferGeometry[] = [];
  const yellowParts: THREE.BufferGeometry[] = [];
  const roofParts: THREE.BufferGeometry[] = [];
  const lampParts: THREE.BufferGeometry[] = [];
  const equipmentParts: THREE.BufferGeometry[] = [];
  const accentParts: THREE.BufferGeometry[][] = TEAM_COLOURS.map(() => []);

  const push = (
    list: THREE.BufferGeometry[],
    width: number,
    height: number,
    depth: number,
    x: number,
    y: number,
    z: number,
  ): void => {
    const geometry = new THREE.BoxGeometry(width, height, depth);
    geometry.translate(x, y, z);
    list.push(geometry);
  };

  // --- Dalle, fond, pignons, toit -----------------------------------------
  push(concreteParts, GARAGE_DEPTH + 1.6, 0.08, BUILDING_LENGTH + 1.6, CENTRE_X, 0.04, CENTRE_Z);
  push(concreteParts, SHELL, CLEAR_HEIGHT, BUILDING_LENGTH + SHELL, BACK_X + SHELL / 2, CLEAR_HEIGHT / 2, CENTRE_Z);
  for (const z of [Z0, Z1]) {
    push(concreteParts, GARAGE_DEPTH, CLEAR_HEIGHT, SHELL, CENTRE_X, CLEAR_HEIGHT / 2, z);
  }
  // Cloisons entre les boxes : c'est ce qui fait lire huit cellules et non un
  // hangar. Elles s'arrêtent au nu de la façade pour former les montants.
  for (let index = 1; index < STALL_COUNT; index++) {
    const z = stallCentre(index) - STALL_PITCH / 2;
    push(beigeParts, GARAGE_DEPTH, CLEAR_HEIGHT, 0.24, CENTRE_X, CLEAR_HEIGHT / 2, z);
  }
  // Toit, acrotère et éclairage de façade.
  push(roofParts, GARAGE_DEPTH + 1.9, ROOF_THICK, BUILDING_LENGTH + 1.9, CENTRE_X, CLEAR_HEIGHT + ROOF_THICK / 2, CENTRE_Z);
  push(trimParts, 0.3, 0.5, BUILDING_LENGTH + 1.9, GARAGE_FRONT_X - 0.15, CLEAR_HEIGHT + ROOF_THICK + 0.25, CENTRE_Z);
  push(trimParts, GARAGE_DEPTH + 1.9, 0.5, 0.3, CENTRE_X, CLEAR_HEIGHT + ROOF_THICK + 0.25, Z0 - 0.8);
  push(trimParts, GARAGE_DEPTH + 1.9, 0.5, 0.3, CENTRE_X, CLEAR_HEIGHT + ROOF_THICK + 0.25, Z1 + 0.8);

  // --- Les huit boxes ------------------------------------------------------
  for (let index = 0; index < STALL_COUNT; index++) {
    const centre = stallCentre(index);
    doorFrame(concreteParts, darkParts, trimParts, yellowParts, centre);
    // Bandeau d'écurie au-dessus de la porte, sous le linteau.
    push(
      accentParts[index % accentParts.length],
      0.22,
      0.42,
      STALL_LENGTH - 1.6,
      GARAGE_FRONT_X - 0.02,
      CLEAR_HEIGHT - 0.32,
      centre,
    );
    // Luminaire intérieur : deux réglettes, une par rangée de travail.
    for (const x of [CENTRE_X - 1.6, CENTRE_X + 2.4]) {
      push(lampParts, 2.6, 0.1, 0.22, x, CLEAR_HEIGHT - 0.18, centre);
    }
    // Panneau d'écurie au fond du box, au-dessus de l'établi.
    push(
      accentParts[index % accentParts.length],
      0.08,
      0.9,
      4.6,
      BACK_X + 0.26,
      2.5,
      centre,
    );
    // Établi contre le fond, avec son plateau et ses pieds.
    push(trimParts, 0.9, 0.08, 4.4, BACK_X + 0.9, 0.92, centre - 1.4);
    for (const z of [-1, 1]) {
      push(darkParts, 0.08, 0.9, 0.08, BACK_X + 0.55, 0.45, centre - 1.4 + z * 2);
      push(darkParts, 0.08, 0.9, 0.08, BACK_X + 1.25, 0.45, centre - 1.4 + z * 2);
    }
    // Armoire électrique, extincteur et poubelle près de la porte.
    push(darkParts, 0.3, 0.7, 0.5, GARAGE_FRONT_X - 1.1, 1.55, centre + STALL_LENGTH / 2 - 0.9);
    push(
      accentParts[0],
      0.24,
      0.62,
      0.24,
      GARAGE_FRONT_X - 1.2,
      1.0,
      centre - STALL_LENGTH / 2 + 0.8,
    );
    // Bandeau lumineux au-dessus de la porte, côté voie.
    push(lampParts, 0.3, 0.12, STALL_LENGTH - 2.2, GARAGE_FRONT_X + 0.06, CLEAR_HEIGHT - 0.05, centre);
  }

  // --- Toiture technique : caissons, lanterneaux, garde-corps -------------
  // Les caissons étaient des pavés sombres sans matière : on les habille en
  // centrale de traitement d'air — capot clair, grilles, pieds — pour qu'ils
  // se lisent comme du matériel et non comme un bloc oublié.
  for (const z of [stallCentre(1), stallCentre(4), stallCentre(6)]) {
    const x = CENTRE_X - 2.5;
    const y = CLEAR_HEIGHT + ROOF_THICK + 0.45;
    push(equipmentParts, 2.4, 0.9, 3.2, x, y, z);
    push(trimParts, 2.6, 0.12, 3.4, x, y + 0.5, z);
    for (let slat = 0; slat < 6; slat++) {
      push(darkParts, 1.9, 0.06, 0.06, x, y - 0.3 + slat * 0.12, z - 1.62);
      push(darkParts, 1.9, 0.06, 0.06, x, y - 0.3 + slat * 0.12, z + 1.62);
    }
    for (const dx of [-0.9, 0.9]) {
      for (const dz of [-1.3, 1.3]) push(darkParts, 0.18, 0.35, 0.18, x + dx, y - 0.62, z + dz);
    }
  }
  for (let z = Z0 + 2; z <= Z1 - 2; z += 3.4) {
    push(darkParts, 0.06, 0.9, 0.06, GARAGE_FRONT_X - 0.5, CLEAR_HEIGHT + ROOF_THICK + 0.45, z);
  }
  push(trimParts, 0.07, 0.07, BUILDING_LENGTH, GARAGE_FRONT_X - 0.5, CLEAR_HEIGHT + ROOF_THICK + 0.9, CENTRE_Z);
  // Descentes d'eau, tous les deux boxes.
  for (const index of [0, 2, 4, 6]) {
    const z = stallCentre(index) - STALL_PITCH / 2 + 0.4;
    push(trimParts, 0.14, CLEAR_HEIGHT, 0.14, GARAGE_FRONT_X - 0.2, CLEAR_HEIGHT / 2, z);
  }

  // --- Enseigne du bâtiment ------------------------------------------------
  const signCanvas = document.createElement('canvas');
  signCanvas.width = 768;
  signCanvas.height = 128;
  const ctx = signCanvas.getContext('2d')!;
  ctx.fillStyle = '#a3141c';
  ctx.fillRect(0, 0, 768, 128);
  ctx.fillStyle = '#f4f1e8';
  ctx.font = 'bold 92px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('SP95', 384, 70);
  const signTexture = new THREE.CanvasTexture(signCanvas);
  signTexture.colorSpace = THREE.SRGBColorSpace;
  signTexture.anisotropy = anisotropy;
  const sign = new THREE.Mesh(
    new THREE.PlaneGeometry(17, 2.8),
    new THREE.MeshBasicMaterial({ map: signTexture }),
  );
  sign.position.set(GARAGE_FRONT_X + 0.04, CLEAR_HEIGHT + ROOF_THICK + 1.5, CENTRE_Z);
  sign.rotation.y = Math.PI / 2;
  scene.add(sign);

  // --- Fusion et pose ------------------------------------------------------
  const sinks: Sink[] = [
    { material: concreteMat, geometries: concreteParts },
    { material: beigeMat, geometries: beigeParts },
    { material: darkMat, geometries: darkParts },
    { material: trimMat, geometries: trimParts },
    { material: yellowMat, geometries: yellowParts },
    { material: roofMat, geometries: roofParts },
    { material: lampMat, geometries: lampParts },
    {
      material: new THREE.MeshStandardMaterial({ color: 0x8d949c, roughness: 0.45, metalness: 0.55 }),
      geometries: equipmentParts,
    },
  ];
  TEAM_COLOURS.forEach((colour, index) => {
    sinks.push({
      material: new THREE.MeshStandardMaterial({ color: colour, roughness: 0.62 }),
      geometries: accentParts[index],
    });
  });

  let triangles = 0;
  let meshes = 0;
  for (const sink of sinks) {
    if (sink.geometries.length === 0) continue;
    const merged = mergeGeometries(sink.geometries);
    sink.geometries.forEach((geometry) => geometry.dispose());
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, sink.material);
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.name = `pit-garage-${meshes}`;
    scene.add(mesh);
    meshes += 1;
    triangles += merged.index ? merged.index.count / 3 : merged.attributes.position.count / 3;
  }

  // --- Collisions : fond, pignons, cloisons -------------------------------
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const collider = (
    width: number,
    height: number,
    depth: number,
    x: number,
    y: number,
    z: number,
  ): void => {
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(width / 2, height / 2, depth / 2)
        .setTranslation(x, y, z)
        .setFriction(0.7)
        .setRestitution(0.05)
        .setCollisionGroups(WALL_GROUP),
      body,
    );
  };
  collider(SHELL, CLEAR_HEIGHT, BUILDING_LENGTH, BACK_X + SHELL / 2, CLEAR_HEIGHT / 2, CENTRE_Z);
  for (const z of [Z0, Z1]) collider(GARAGE_DEPTH, CLEAR_HEIGHT, SHELL, CENTRE_X, CLEAR_HEIGHT / 2, z);
  for (let index = 1; index < STALL_COUNT; index++) {
    const z = stallCentre(index) - STALL_PITCH / 2;
    collider(GARAGE_DEPTH, CLEAR_HEIGHT, 0.24, CENTRE_X, CLEAR_HEIGHT / 2, z);
  }

  return { triangles, meshes };
}
