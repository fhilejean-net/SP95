/**
 * Circuit SP95 : la piste plate, construite de bout en bout par le jeu.
 *
 * Suzuka venait d'un relevé : deux tabliers, 51 m de dénivelé, des dalles de
 * trente mètres et une plaque de collision reconstruite après coup — d'où les
 * trous, les marches et les voitures qui décollaient. Ici tout est authored :
 *
 * - le sol est le terrain plat (`heightAt` renvoie 0 sur cette carte), une
 *   **seule** couche physique, sans dalle posée par-dessus ;
 * - l'asphalte est une bande de largeur constante à 2 cm au-dessus du sol : le
 *   revêtement est *visuel* et les roues roulent sur le plan du terrain ;
 * - les murs sont des boîtes posées sur l'axe, sans trou ni recouvrement ;
 * - le décor (stands, pit, tribunes, arbres) reste derrière les murs.
 *
 * Aucune de ces surfaces ne peut donc mentir sur sa cote : tout est à zéro.
 */
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { GROUP_WORLD } from '../physics/vehicle.ts';
import {
  createAsphaltTexture,
  createConcreteTexture,
  createGrassTuftTexture,
  createRoadTextures,
} from '../render/materials.ts';
import {
  HALF_WIDTH,
  KERB_WIDTH,
  ROAD_LIFT,
  TRACK,
  WALL_OFFSET,
  hasKerb,
  type TrackSample,
} from './trackLayout.ts';

/** Les murs ne collisionnent que la coque, comme les bâtiments de la ville. */
const WALL_GROUP = (GROUP_WORLD << 16) | GROUP_WORLD;
const WALL_HEIGHT = 1.05;
const WALL_THICK = 0.5;
/** Pas des murs : trois mètres, avec recouvrement, ne laissent aucune fente. */
const WALL_STEP = 3;
const WALL_OVERLAP = 0.25;
/** Distance de la ligne peinte devant le point de départ. */
const START_LINE = 8;
/** Teinte des bords de piste : plus sombre, pour lire la largeur au loin. */
const EDGE_SHADE = 0.72;
/** Alternance des vibreurs, en mètres. */
const KERB_SEGMENT = 2.4;
/** Rayon en dessous duquel un mur reçoit des pneus empilés. */
const TYRE_RADIUS = 75;

export interface FlatCircuitHandles {
  spawn: { x: number; z: number; heading: number };
  meshes: number;
  triangles: number;
  loadMs: number;
  buildMs: number;
  /** Longueur du tour, en mètres. */
  length: number;
  walls: number;
}

export interface FlatCircuitOptions {
  anisotropy: number;
  lowFx: boolean;
}

function nextSample(samples: TrackSample[], index: number): TrackSample {
  return samples[(index + 1) % samples.length];
}

/** Rééchantillonne l'axe à pas constant, par interpolation linéaire. */
function resample(step: number): TrackSample[] {
  const samples = TRACK.samples;
  const total = TRACK.length;
  const out: TrackSample[] = [];
  const count = Math.max(8, Math.floor(total / step));
  let index = 0;
  for (let i = 0; i < count; i++) {
    const target = i * step;
    while (index + 1 < samples.length && samples[index + 1].distance <= target) index++;
    const a = samples[index];
    const b = nextSample(samples, index);
    const end = b.distance <= a.distance ? b.distance + total : b.distance;
    const span = Math.max(1e-6, end - a.distance);
    const t = Math.min(1, Math.max(0, (target - a.distance) / span));
    out.push({
      x: a.x + (b.x - a.x) * t,
      z: a.z + (b.z - a.z) * t,
      tx: a.tx + (b.tx - a.tx) * t,
      tz: a.tz + (b.tz - a.tz) * t,
      distance: target,
      curvature: a.curvature + (b.curvature - a.curvature) * t,
    });
  }
  return out;
}

/** Normale à droite de l'axe, dans le plan du sol. */
function rightOf(sample: TrackSample): { x: number; z: number } {
  return { x: -sample.tz, z: sample.tx };
}

interface RibbonOptions {
  /** Décalage latéral du bord gauche (négatif) et du bord droit. */
  from: number;
  to: number;
  y: number;
  /** Longueur d'une répétition de texture, en mètres. */
  tile: number;
  colorAt?: (fraction: number) => THREE.Color;
}

/** Bande continue le long de l'axe, entre deux décalages latéraux. */
function ribbon(
  samples: TrackSample[],
  options: RibbonOptions,
): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const white = new THREE.Color(1, 1, 1);
  samples.forEach((sample, index) => {
    const right = rightOf(sample);
    for (const [edge, lateral] of [
      [0, options.from],
      [1, options.to],
    ] as const) {
      positions.push(sample.x + right.x * lateral, options.y, sample.z + right.z * lateral);
      uvs.push(edge, sample.distance / options.tile);
      const color = options.colorAt?.(edge) ?? white;
      colors.push(color.r, color.g, color.b);
    }
    if (index === samples.length - 1) return;
    const base = index * 2;
    indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
  });
  // Fermeture de la boucle.
  const last = (samples.length - 1) * 2;
  indices.push(last, last + 1, 0, last + 1, 1, 0);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Quad coloré posé à plat, dans le repère de l'axe : `from`/`to` en latéral,
 * `length` en marche arrière le long de la tangente. Quatre sommets, deux
 * triangles — l'appelant ne partage aucune arête avec le quad voisin.
 */
function flatQuad(
  sample: TrackSample,
  from: number,
  to: number,
  y: number,
  length: number,
  color: THREE.Color,
  positions: number[],
  colors: number[],
  indices: number[],
): void {
  const right = rightOf(sample);
  const bx = sample.x - sample.tx * length;
  const bz = sample.z - sample.tz * length;
  const base = positions.length / 3;
  positions.push(
    sample.x + right.x * from, y, sample.z + right.z * from,
    sample.x + right.x * to, y, sample.z + right.z * to,
    bx + right.x * from, y, bz + right.z * from,
    bx + right.x * to, y, bz + right.z * to,
  );
  for (let i = 0; i < 4; i++) colors.push(color.r, color.g, color.b);
  indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
}

/**
 * Damier de la ligne : deux rangées de cases, larges d'un demi-mètre, sur toute
 * la piste. La ligne est le repère visuel du chrono, posé exactement dessus.
 */
function startLineGeometry(distance: number): THREE.BufferGeometry {
  const samples = resample(0.5);
  const sample =
    samples.find((entry) => entry.distance >= distance) ?? samples[0];
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const columns = 28;
  const width = (HALF_WIDTH * 2) / columns;
  const black = new THREE.Color(0x15161a);
  const white = new THREE.Color(0xf0f0ec);
  for (let row = 0; row < 2; row++) {
    // Les deux rangées sont posées *avant* la ligne, jamais après : la ligne
    // marque le franchissement, le damier ne doit pas le dépasser.
    const shift = (row + 1) * 0.45;
    const shifted: TrackSample = {
      ...sample,
      x: sample.x - sample.tx * shift,
      z: sample.z - sample.tz * shift,
    };
    for (let column = 0; column < columns; column++) {
      const from = -HALF_WIDTH + column * width;
      const to = from + width;
      flatQuad(
        shifted,
        from,
        to,
        ROAD_LIFT + 0.008,
        0.45,
        (row + column) % 2 === 0 ? white : black,
        positions,
        colors,
        indices,
      );
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/** Texture de panneau : fond plein, texte centré, une marque par panneau. */
function boardTexture(text: string, background: string, ink: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 96;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, 512, 96);
  ctx.strokeStyle = 'rgba(0,0,0,0.18)';
  ctx.lineWidth = 6;
  ctx.strokeRect(3, 3, 506, 90);
  ctx.fillStyle = ink;
  ctx.font = 'bold 58px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 256, 52);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

/**
 * Panneau de sponsor : fond plein, coin de couleur, marque et accroche. Le
 * dessin est net à 6 m de haut et coûte une canvas de 1024 × 160 par marque.
 */
function sponsorTexture(options: {
  name: string;
  tagline: string;
  background: string;
  ink: string;
  accent: string;
}): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 160;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = options.background;
  ctx.fillRect(0, 0, 1024, 160);
  // Coin oblique, comme une virgule de logo.
  ctx.fillStyle = options.accent;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(176, 0);
  ctx.lineTo(104, 160);
  ctx.lineTo(0, 160);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.22)';
  ctx.lineWidth = 4;
  ctx.strokeRect(2, 2, 1020, 156);
  ctx.fillStyle = options.ink;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = 'bold 80px system-ui, sans-serif';
  ctx.fillText(options.name, 208, 64);
  ctx.globalAlpha = 0.78;
  ctx.font = '600 32px system-ui, sans-serif';
  ctx.fillText(options.tagline, 212, 124);
  ctx.globalAlpha = 1;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

/**
 * Bandeau du portique : nom du circuit à gauche, quatre écuries à droite,
 * chacune avec sa couleur et ses initiales.
 */
function gantryBannerTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 2048;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#11141b';
  ctx.fillRect(0, 0, 2048, 256);
  ctx.fillStyle = '#a3141c';
  ctx.fillRect(0, 0, 2048, 12);
  ctx.fillRect(0, 244, 2048, 12);
  ctx.fillStyle = '#f3f0e6';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = 'bold 116px system-ui, sans-serif';
  ctx.fillText('CIRCUIT SP95', 54, 104);
  ctx.fillStyle = '#a9a69d';
  ctx.font = '600 38px system-ui, sans-serif';
  ctx.fillText('GRAND PRIX DE LA PLAINE', 58, 188);
  const teams = [
    { initials: 'RV', colour: '#b3131b', ink: '#f6f2e6' },
    { initials: 'AZ', colour: '#1d8f6f', ink: '#f6f2e6' },
    { initials: 'BL', colour: '#2b57a8', ink: '#f6f2e6' },
    { initials: 'OR', colour: '#e2a119', ink: '#191a1c' },
  ];
  teams.forEach((team, index) => {
    const x = 1252 + index * 192;
    ctx.fillStyle = team.colour;
    ctx.beginPath();
    ctx.roundRect(x, 54, 160, 148, 16);
    ctx.fill();
    ctx.fillStyle = team.ink;
    ctx.font = 'bold 72px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(team.initials, x + 80, 124);
  });
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

/**
 * Grand stands, atelier, pneus, arbres et panneaux : tout est bâti ici, à la
 * cote zéro, et aucun de ces objets ne porte de collision — ils sont derrière
 * les murs, ou hors d'atteinte.
 */
function buildScenery(scene: THREE.Scene, anisotropy: number, lowFx: boolean): number {
  const concrete = createConcreteTexture();
  concrete.repeat.set(3, 3);
  concrete.anisotropy = anisotropy;
  const concreteMat = new THREE.MeshStandardMaterial({
    map: concrete,
    roughness: 0.88,
    metalness: 0.04,
  });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x22252a, roughness: 0.7 });
  const metalMat = new THREE.MeshStandardMaterial({ color: 0x8a8f96, roughness: 0.42, metalness: 0.7 });
  const glassMat = new THREE.MeshPhysicalMaterial({
    color: 0x87a6bd,
    transparent: true,
    opacity: 0.34,
    roughness: 0.06,
    metalness: 0.1,
    depthWrite: false,
  });
  const seatMat = new THREE.MeshStandardMaterial({ roughness: 0.65, vertexColors: false });
  const whiteMat = new THREE.MeshStandardMaterial({ color: 0xe9e9e4, roughness: 0.6 });
  const redMat = new THREE.MeshStandardMaterial({ color: 0xa8141c, roughness: 0.62 });
  const pitAsphalt = new THREE.MeshStandardMaterial({ map: createAsphaltTexture(), roughness: 0.93 });

  let triangles = 0;
  const add = (mesh: THREE.Mesh, shadows: 'both' | 'receive' | 'none' = 'receive'): void => {
    mesh.castShadow = shadows === 'both';
    mesh.receiveShadow = shadows !== 'none';
    scene.add(mesh);
    const geometry = mesh.geometry as THREE.BufferGeometry;
    triangles += (geometry.index?.count ?? geometry.attributes.position.count) / 3;
  };
  const box = (
    width: number,
    height: number,
    depth: number,
    x: number,
    y: number,
    z: number,
    material: THREE.Material,
    yaw = 0,
    shadows: 'both' | 'receive' | 'none' = 'both',
  ): THREE.Mesh => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material);
    mesh.position.set(x, y, z);
    mesh.rotation.y = yaw;
    add(mesh, shadows);
    return mesh;
  };

  // --- Pit lane : une dalle, une voie des stands, un bâtiment, huit garages -
  const pad = new THREE.Mesh(new THREE.PlaneGeometry(46, 260), concreteMat);
  pad.rotation.x = -Math.PI / 2;
  pad.position.set(-42, ROAD_LIFT, -410);
  add(pad, 'receive');

  // La voie des stands court entre le bord de piste et le mur : elle est
  // peinte, le sol physique reste le terrain plat.
  const pitLane = new THREE.Mesh(new THREE.PlaneGeometry(8.6, 250), pitAsphalt);
  pitLane.rotation.x = -Math.PI / 2;
  pitLane.position.set(-13.2, ROAD_LIFT + 0.004, -390);
  add(pitLane, 'receive');
  for (let z = -508; z < -266; z += 8) {
    box(0.18, 0.02, 4, -13.2, ROAD_LIFT + 0.01, z, whiteMat, 0, 'none');
  }

  box(15, 8.4, 118, -33, 4.2, -420, concreteMat, 0, 'both');
  box(15.8, 0.7, 120, -33, 8.6, -420, darkMat, 0, 'both');
  // Bandeau vitré au-dessus des garages, puis les portes.
  box(0.2, 1.7, 112, -25.4, 6.1, -420, glassMat, 0, 'none');
  for (let i = 0; i < 8; i++) {
    const z = -474 + i * 13.2;
    box(0.35, 3.9, 8.4, -25.4, 1.95, z, darkMat, 0, 'none');
    box(0.25, 0.22, 8.4, -25.15, 0.11, z, whiteMat, 0, 'none');
  }
  // Enseigne du bâtiment, tournée vers la piste.
  const sign = new THREE.Mesh(
    new THREE.PlaneGeometry(18, 3.4),
    new THREE.MeshBasicMaterial({ map: boardTexture('SP95', '#a3141c', '#f4f1e8') }),
  );
  sign.position.set(-25.2, 8.2, -420);
  sign.rotation.y = Math.PI / 2;
  scene.add(sign);

  // --- Tribune principale : les gradins montent *vers l'extérieur* --------
  // La première version montait vers la piste : le public tournait le dos au
  // circuit et le toit passait au-dessus des sièges du premier rang.
  const steps = 10;
  const stepDepth = 2.1;
  const front = -24;
  const standZ = -300;
  for (let row = 0; row < steps; row++) {
    const height = 0.62 + row * 0.62;
    box(stepDepth, height, 92, front - (row + 0.5) * stepDepth, height / 2, standZ, concreteMat);
  }
  // Assises : une par place, couleur par rangée.
  const seats = new THREE.InstancedMesh(new THREE.BoxGeometry(0.46, 0.34, 0.5), seatMat, steps * 46);
  const matrix = new THREE.Matrix4();
  const color = new THREE.Color();
  let seat = 0;
  for (let row = 0; row < steps; row++) {
    for (let column = 0; column < 46; column++) {
      matrix.makeTranslation(
        front - (row + 1) * stepDepth + 0.55,
        0.62 + row * 0.62 + 0.17,
        standZ - 45 + column * 2,
      );
      seats.setMatrixAt(seat, matrix);
      color.set(row % 3 === 0 ? 0xb02026 : 0xd8d6cd);
      seats.setColorAt(seat, color);
      seat++;
    }
  }
  seats.castShadow = false;
  seats.receiveShadow = true;
  scene.add(seats);
  // Bandeau publicitaire sur la face avant, tourné vers la piste.
  const banner = new THREE.Mesh(
    new THREE.PlaneGeometry(92, 2.2),
    new THREE.MeshBasicMaterial({ map: boardTexture('GRAND STAND', '#a3141c', '#f4f1e8') }),
  );
  banner.position.set(front + 0.06, 2.15, standZ);
  banner.rotation.y = Math.PI / 2;
  scene.add(banner);
  // Escaliers d'accès, de chaque côté de la tribune.
  for (const z of [standZ - 47, standZ + 47]) {
    box(6, 0.5, 2.4, front - 3, 3.2, z, concreteMat);
  }
  // Toit de tribune, posé au-dessus des gradins, et ses poteaux à l'arrière.
  box(22, 0.5, 94, front - 5 * stepDepth, 9.6, standZ, metalMat);
  for (const z of [standZ - 38, standZ, standZ + 38]) box(0.6, 9.6, 0.6, front - 19, 4.8, z, metalMat);

  // --- Tour de contrôle ----------------------------------------------------
  box(7, 15, 7, -52, 7.5, -470, concreteMat);
  box(11, 2.4, 11, -52, 16, -470, glassMat, 0, 'none');

  // --- Postes de commissaires ---------------------------------------------
  // La position se calcule depuis l'axe, côté *extérieur* du virage, à huit
  // mètres derrière le mur. La version précédente écrivait six coordonnées à
  // la main : deux tombaient sur l'asphalte.
  const extinguisher = new THREE.CylinderGeometry(0.11, 0.11, 0.52, 10);
  const extinguisherMat = new THREE.MeshStandardMaterial({ color: 0xa3141c, roughness: 0.5 });
  const flagMat = new THREE.MeshStandardMaterial({
    color: 0xb01a1f,
    roughness: 0.75,
    side: THREE.DoubleSide,
  });
  const marshalHut = (
    x: number,
    z: number,
    yaw: number,
    facing: { x: number; z: number },
  ): void => {
    // Repère local du poste : `across` va vers la piste, `along` suit l'axe.
    const along = { x: facing.z, z: -facing.x };
    const at = (
      across: number,
      side: number,
      y: number,
      width: number,
      height: number,
      depth: number,
      material: THREE.Material,
      shadows: 'both' | 'receive' | 'none' = 'both',
    ): void => {
      box(
        width,
        height,
        depth,
        x + facing.x * across + along.x * side,
        y,
        z + facing.z * across + along.z * side,
        material,
        yaw,
        shadows,
      );
    };
    // Dalle, soubassement béton, corps blanc, bandeau rouge, toit à redans.
    at(0, 0, 0.11, 5, 0.22, 5.2, concreteMat, 'receive');
    at(0, 0, 0.42, 3.72, 0.84, 3.62, concreteMat);
    at(0, 0, 1.62, 3.6, 2.4, 3.5, whiteMat);
    at(0, 0, 2.72, 3.7, 0.34, 3.6, redMat);
    at(0, 0, 2.98, 4.3, 0.18, 4.3, darkMat);
    // Redan sur le toit, côté piste, et parapet arrière.
    at(1.98, 0, 3.2, 0.18, 0.4, 4.3, concreteMat);
    at(-1.98, 0, 3.1, 0.18, 0.24, 4.3, concreteMat);
    at(0, 2.05, 3.1, 4.3, 0.24, 0.18, concreteMat);
    at(0, -2.05, 3.1, 4.3, 0.24, 0.18, concreteMat);
    // Baie vitrée en bandeau, ses montants et son appui.
    at(1.83, 0, 1.86, 0.1, 0.86, 3.05, glassMat, 'none');
    for (const side of [-1.1, 0, 1.1]) at(1.87, side, 1.86, 0.09, 0.9, 0.1, darkMat);
    at(1.9, 0, 1.4, 0.15, 0.1, 3.1, whiteMat);
    // Porte à l'arrière, avec deux marches.
    at(0, -1.79, 0.95, 1.05, 1.9, 0.1, darkMat);
    at(0, -2.14, 0.14, 1.5, 0.28, 0.5, concreteMat);
    at(0, -2.5, 0.07, 1.5, 0.14, 0.5, concreteMat);
    // Sacs de sable devant l'ouverture, sur deux rangs.
    for (let row = 0; row < 2; row++) {
      for (let i = -2; i <= 2; i++) {
        at(2.28 + row * 0.42, i * 0.66 + row * 0.33, 0.16 + row * 0.29, 0.66, 0.3, 0.5, darkMat);
      }
    }
    // Extincteur, mât et drapeau, antenne radio.
    const bottle = new THREE.Mesh(extinguisher, extinguisherMat);
    bottle.position.set(x + facing.x * 1.55 + along.x * 1.5, 0.26, z + facing.z * 1.55 + along.z * 1.5);
    scene.add(bottle);
    box(0.09, 3.3, 0.09, x + facing.x * 1.5 + along.x * 1.4, 4.6, z + facing.z * 1.5 + along.z * 1.4, metalMat);
    const flag = new THREE.Mesh(new THREE.PlaneGeometry(1.05, 0.6), flagMat);
    flag.position.set(
      x + facing.x * 1.5 + along.x * 1.95,
      5.55,
      z + facing.z * 1.5 + along.z * 1.95,
    );
    flag.rotation.y = yaw + Math.PI / 2;
    scene.add(flag);
    box(0.06, 1.5, 0.06, x - facing.x * 1.3 + along.x * 1.1, 3.8, z - facing.z * 1.3 + along.z * 1.1, metalMat);
  };
  for (const fraction of [0.06, 0.18, 0.3, 0.42, 0.55, 0.68, 0.8, 0.92]) {
    const sample = TRACK.samples[Math.floor(fraction * TRACK.samples.length) % TRACK.samples.length];
    const right = rightOf(sample);
    const outward = sample.curvature > 1e-4 ? -1 : 1;
    const distance = WALL_OFFSET + 8;
    const x = sample.x + right.x * distance * outward;
    const z = sample.z + right.z * distance * outward;
    marshalHut(x, z, Math.atan2(sample.tx, sample.tz), {
      x: -right.x * outward,
      z: -right.z * outward,
    });
  }

  // --- Grille de départ : six emplacements en quinconce --------------------
  for (let slot = 0; slot < 6; slot++) {
    const distance = (TRACK.length - 14 - slot * 11) % TRACK.length;
    const sample = TRACK.samples[Math.floor((distance / TRACK.length) * TRACK.samples.length) % TRACK.samples.length];
    const right = rightOf(sample);
    const lateral = slot % 2 === 0 ? -3.4 : 3.4;
    const x = sample.x + right.x * lateral;
    const z = sample.z + right.z * lateral;
    const yaw = Math.atan2(sample.tx, sample.tz);
    box(2.8, 0.02, 0.22, x, ROAD_LIFT + 0.012, z, whiteMat, yaw, 'none');
    box(0.22, 0.02, 1.4, x, ROAD_LIFT + 0.012, z, whiteMat, yaw, 'none');
  }

  // --- Panneaux publicitaires, devant la face intérieure du mur -----------
  // La face est posée 9 cm *devant* le mur (dont la face intérieure est à
  // WALL_OFFSET - WALL_THICK/2). L'ancienne version la plantait 5 cm derrière
  // cette face, donc dans l'épaisseur du mur : les deux plans se disputaient le
  // tampon de profondeur, et tout le panneau clignotait au loin.
  const boards = [
    { map: sponsorTexture({ name: 'VELOCE', tagline: 'SCUDERIA · MODENA', background: '#8f1017', ink: '#f6f2e6', accent: '#e8b422' }), step: 25 },
    { map: sponsorTexture({ name: 'NORTHWIND', tagline: 'AIR SYSTEMS', background: '#e9e7df', ink: '#17202c', accent: '#2b57a8' }), step: 31 },
    { map: sponsorTexture({ name: 'APEX OIL', tagline: 'FULL SYNTHETIC', background: '#14161b', ink: '#f4d34a', accent: '#f4d34a' }), step: 27 },
    { map: sponsorTexture({ name: 'KERB+', tagline: 'RACE ENGINEERING', background: '#10241d', ink: '#eaf3ec', accent: '#1d8f6f' }), step: 35 },
    { map: sponsorTexture({ name: 'ORBITA', tagline: 'TYRES · GRIP 0', background: '#1d2a44', ink: '#f2f4f8', accent: '#c2272d' }), step: 29 },
  ];
  const wallSamples = resample(WALL_STEP);
  const boardLateral = WALL_OFFSET - WALL_THICK / 2 - 0.09;
  const postParts: THREE.BufferGeometry[] = [];
  boards.forEach((board, boardIndex) => {
    const geometry = new THREE.PlaneGeometry(6.4, 1.15);
    const material = new THREE.MeshStandardMaterial({ map: board.map, roughness: 0.6, metalness: 0.05 });
    const parts: THREE.BufferGeometry[] = [];
    const stride = Math.max(1, Math.round(board.step / WALL_STEP));
    for (let i = boardIndex * 5; i < wallSamples.length; i += stride) {
      const sample = wallSamples[i % wallSamples.length];
      const right = rightOf(sample);
      const yaw = Math.atan2(sample.tx, sample.tz);
      for (const side of [-1, 1]) {
        const face = geometry.clone();
        const x = sample.x + right.x * boardLateral * side;
        const z = sample.z + right.z * boardLateral * side;
        // Face tournée vers la piste, de chaque côté du mur ; une seule face,
        // pas de DoubleSide : le dos ne se lit jamais.
        face.rotateY(yaw + (side > 0 ? Math.PI / 2 : -Math.PI / 2));
        face.translate(x, 1.78, z);
        parts.push(face);
        for (const along of [-2.5, 2.5]) {
          const post = new THREE.BoxGeometry(0.11, 1.2, 0.11);
          post.rotateY(yaw + (side > 0 ? Math.PI / 2 : -Math.PI / 2));
          post.translate(x + sample.tx * along, 1.2, z + sample.tz * along);
          postParts.push(post);
        }
      }
    }
    if (parts.length === 0) return;
    const merged = mergeGeometries(parts);
    parts.forEach((part) => part.dispose());
    if (!merged) return;
    const mesh = new THREE.Mesh(merged, material);
    mesh.receiveShadow = true;
    scene.add(mesh);
    triangles += merged.index ? merged.index.count / 3 : merged.attributes.position.count / 3;
  });
  if (postParts.length > 0) {
    const merged = mergeGeometries(postParts);
    postParts.forEach((part) => part.dispose());
    if (merged) {
      const posts = new THREE.Mesh(merged, metalMat);
      posts.receiveShadow = true;
      scene.add(posts);
      triangles += merged.index ? merged.index.count / 3 : merged.attributes.position.count / 3;
    }
  }

  // --- Tribunes secondaires dans les virages lents ------------------------
  // Une tribune est construite dans un repère local (front à x = 0, gradins
  // vers -x) puis tournée pour regarder la piste. Elle se pose sur le
  // dégagement extérieur, à quinze mètres derrière le mur.
  const secondaryStand = (
    sample: TrackSample,
    outward: 1 | -1,
    length: number,
    rows: number,
  ): void => {
    const right = rightOf(sample);
    const distance = WALL_OFFSET + 16;
    const cx = sample.x + right.x * distance * outward;
    const cz = sample.z + right.z * distance * outward;
    const yaw = Math.atan2(outward * right.z, -outward * right.x);
    const group = new THREE.Group();
    group.position.set(cx, 0, cz);
    group.rotation.y = yaw;
    const stepDepth = 2.1;
    for (let row = 0; row < rows; row++) {
      const height = 0.62 + row * 0.62;
      const step = new THREE.Mesh(new THREE.BoxGeometry(stepDepth, height, length), concreteMat);
      step.position.set(-(row + 0.5) * stepDepth, height / 2, 0);
      step.castShadow = true;
      step.receiveShadow = true;
      group.add(step);
      triangles += 12;
    }
    const seats = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.46, 0.34, 0.5),
      seatMat,
      rows * Math.floor(length / 2),
    );
    let seat = 0;
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < Math.floor(length / 2); column++) {
        matrix.makeTranslation(
          -(row + 1) * stepDepth + 0.55,
          0.62 + row * 0.62 + 0.17,
          -length / 2 + 1 + column * 2,
        );
        seats.setMatrixAt(seat, matrix);
        color.set(row % 3 === 0 ? 0xb02026 : 0xd8d6cd);
        seats.setColorAt(seat, color);
        seat++;
      }
    }
    seats.receiveShadow = true;
    group.add(seats);
    const banner = new THREE.Mesh(
      new THREE.PlaneGeometry(length * 0.98, 1.7),
      new THREE.MeshBasicMaterial({ map: boardTexture('SP95', '#12303f', '#f2efe6') }),
    );
    banner.position.set(0.06, 2, 0);
    banner.rotation.y = Math.PI / 2;
    group.add(banner);
    const roof = new THREE.Mesh(new THREE.BoxGeometry(rows * stepDepth + 4, 0.45, length), metalMat);
    roof.position.set(-(rows * stepDepth) / 2 - 1, 8.2, 0);
    roof.castShadow = true;
    group.add(roof);
    for (const z of [-length / 2 + 4, length / 2 - 4]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.55, 8.2, 0.55), metalMat);
      post.position.set(-rows * stepDepth - 1, 4.1, z);
      group.add(post);
    }
    scene.add(group);
    triangles += 40;
  };
  let placedStands = 0;
  for (let i = 0; i < TRACK.samples.length && placedStands < 3; i += 2) {
    const sample = TRACK.samples[i];
    if (Math.abs(sample.curvature) < 1 / 62) continue;
    // Une tribune tous les 350 m au moins, sur l'extérieur du virage.
    if (TRACK.samples.slice(0, i).some((other, index) => {
      if (index % 2 !== 0) return false;
      if (Math.abs(other.curvature) < 1 / 62) return false;
      return Math.abs(other.distance - sample.distance) < 350;
    })) continue;
    secondaryStand(sample, sample.curvature > 0 ? -1 : 1, 46, 7);
    placedStands++;
  }

  // --- Barrières Tecpro au pied des murs des courbes rapides --------------
  // Décoratives : les murs restent la limite physique, les blocs sont posés
  // contre leur face intérieure, là où une voiture sortie large arrive.
  const tecproSpots: { x: number; z: number; yaw: number }[] = [];
  for (const sample of wallSamples) {
    if (Math.abs(sample.curvature) < 1 / 120) continue;
    const right = rightOf(sample);
    const outward = sample.curvature > 0 ? -1 : 1;
    const lateral = outward * (WALL_OFFSET - WALL_THICK / 2 - 0.34);
    tecproSpots.push({
      x: sample.x + right.x * lateral,
      z: sample.z + right.z * lateral,
      yaw: Math.atan2(sample.tx, sample.tz),
    });
  }
  if (tecproSpots.length > 0) {
    const blocks = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.6, 0.94, 2.9),
      new THREE.MeshStandardMaterial({ roughness: 0.52, metalness: 0.05 }),
      tecproSpots.length,
    );
    const quaternion = new THREE.Quaternion();
    const position = new THREE.Vector3();
    const scale = new THREE.Vector3(1, 1, 1);
    tecproSpots.forEach((spot, index) => {
      quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), spot.yaw);
      position.set(spot.x, 0.47, spot.z);
      matrix.compose(position, quaternion, scale);
      blocks.setMatrixAt(index, matrix);
      blocks.setColorAt(index, color.set(index % 2 === 0 ? 0xe6e2d6 : 0xb02328));
    });
    blocks.castShadow = false;
    blocks.receiveShadow = true;
    scene.add(blocks);
    triangles += tecproSpots.length * 12;
  }

  // --- Touffes d'herbe, en cartes croisées ---------------------------------
  // Le paquet fourni contient 204 000 triangles de brins : ici, une seule
  // touffe de deux quads, instanciée. Cinq cents touffes coûtent un appel.
  if (!lowFx) {
    const tuft = new THREE.PlaneGeometry(1.6, 0.85);
    tuft.translate(0, 0.42, 0);
    const crossed = mergeGeometries([tuft, tuft.clone().rotateY(Math.PI / 2)]);
    if (crossed) {
      const tufts = new THREE.InstancedMesh(
        crossed,
        new THREE.MeshStandardMaterial({
          map: createGrassTuftTexture(anisotropy),
          transparent: true,
          alphaTest: 0.45,
          roughness: 0.92,
          side: THREE.DoubleSide,
        }),
        520,
      );
      let seed = 7717;
      const random = (): number => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 4294967296;
      };
      // Repère local à ce bloc : les variables du même nom vivent dans la
      // section Tecpro, juste au-dessus.
      const tuftRotation = new THREE.Quaternion();
      const tuftPosition = new THREE.Vector3();
      const tuftScale = new THREE.Vector3(1, 1, 1);
      let planted = 0;
      for (let i = 0; i < wallSamples.length && planted < 520; i += 2) {
        const sample = wallSamples[i];
        const right = rightOf(sample);
        for (const side of [-1, 1]) {
          if (random() > 0.55) continue;
          const lateral = side * (WALL_OFFSET + 3.2 + random() * 16);
          const x = sample.x + right.x * lateral + (random() - 0.5) * 3;
          const z = sample.z + right.z * lateral + (random() - 0.5) * 3;
          const yaw = random() * Math.PI;
          const size = 0.7 + random() * 0.9;
          tuftRotation.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
          tuftPosition.set(x, 0, z);
          tuftScale.set(size, size, size);
          matrix.compose(tuftPosition, tuftRotation, tuftScale);
          tufts.setMatrixAt(planted, matrix);
          tufts.setColorAt(planted, color.setHSL(0.25 + random() * 0.05, 0.32, 0.3 + random() * 0.1));
          planted++;
          if (planted >= 520) break;
        }
      }
      tufts.count = planted;
      tufts.receiveShadow = false;
      scene.add(tufts);
      triangles += planted * 4;
    }
  }

  // --- Pneus empilés derrière les murs des virages serrés -----------------
  const tyreSpots: { x: number; z: number; yaw: number }[] = [];
  for (const sample of wallSamples) {
    if (Math.abs(sample.curvature) < 1 / TYRE_RADIUS) continue;
    const right = rightOf(sample);
    for (const side of [-1, 1]) {
      tyreSpots.push({
        x: sample.x + right.x * (WALL_OFFSET + 1.3) * side,
        z: sample.z + right.z * (WALL_OFFSET + 1.3) * side,
        yaw: Math.atan2(sample.tx, sample.tz),
      });
    }
  }
  if (tyreSpots.length > 0) {
    const tyres = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.58, 0.58, 0.32, 12),
      new THREE.MeshStandardMaterial({ color: 0x1c1d20, roughness: 0.95 }),
      tyreSpots.length * 3,
    );
    let tyre = 0;
    for (const spot of tyreSpots) {
      for (let level = 0; level < 3; level++) {
        matrix.makeTranslation(spot.x, 0.18 + level * 0.34, spot.z);
        tyres.setMatrixAt(tyre++, matrix);
      }
    }
    tyres.castShadow = false;
    tyres.receiveShadow = true;
    scene.add(tyres);
  }

  // --- Arbres, en dehors de tout ce qui roule -----------------------------
  if (!lowFx) {
    const treeCount = 150;
    const trunks = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.34, 0.5, 3.4, 6),
      new THREE.MeshStandardMaterial({ color: 0x5b4632, roughness: 0.9 }),
      treeCount,
    );
    const crowns = new THREE.InstancedMesh(
      new THREE.ConeGeometry(2.6, 7.4, 7),
      new THREE.MeshStandardMaterial({ roughness: 0.85 }),
      treeCount,
    );
    let seed = 20261028;
    const random = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    let planted = 0;
    let guard = 0;
    while (planted < treeCount && guard++ < treeCount * 40) {
      const x = -640 + random() * 1280;
      const z = -720 + random() * 1280;
      const sample = nearestAxis(x, z);
      if (Math.abs(sample.offset) < 34) continue;
      if (x < -18 && z > -430 && z < -20) continue; // paddock et tribunes
      const scale = 0.75 + random() * 0.7;
      matrix.makeScale(scale, scale, scale);
      matrix.setPosition(x, 1.7 * scale, z);
      trunks.setMatrixAt(planted, matrix);
      matrix.makeScale(scale, scale, scale);
      matrix.setPosition(x, (3.4 + 3.2) * scale, z);
      crowns.setMatrixAt(planted, matrix);
      crowns.setColorAt(planted, color.setHSL(0.26 + random() * 0.06, 0.34, 0.24 + random() * 0.08));
      planted++;
    }
    trunks.count = planted;
    crowns.count = planted;
    trunks.receiveShadow = true;
    crowns.receiveShadow = true;
    scene.add(trunks, crowns);
  }

  return triangles;
}

/**
 * Échantillon d'axe le plus proche, pour placer le décor : même principe que
 * `lateralOffset`, mais on veut aussi le point d'ancrage et sa normale.
 */
function nearestAxis(x: number, z: number): { offset: number; sample: TrackSample } {
  const samples = TRACK.samples;
  let best = Infinity;
  let sample = samples[0];
  for (let i = 0; i < samples.length; i += 2) {
    const distance = Math.hypot(x - samples[i].x, z - samples[i].z);
    if (distance < best) {
      best = distance;
      sample = samples[i];
    }
  }
  const right = rightOf(sample);
  const offset = (x - sample.x) * right.x + (z - sample.z) * right.z;
  return { offset, sample };
}

export function buildFlatCircuit(
  scene: THREE.Scene,
  world: RAPIER.World,
  options: FlatCircuitOptions,
): FlatCircuitHandles {
  const started = performance.now();
  // Asphalte photographié : deux répétitions sur la largeur (7 m de tuile),
  // onze mètres le long de l'axe. La normale et la rugosité viennent du même
  // relevé, ce qui donne le grain sans une texture procédurale de plus.
  const roadTextures = createRoadTextures(options.anisotropy, 3);
  const asphaltMat = new THREE.MeshStandardMaterial({
    map: roadTextures.map,
    normalMap: roadTextures.normalMap,
    // Le relevé est clair et très marqué : on le ramène au gris sombre de la
    // piste et on garde un grain discret, sinon l'asphalte lit comme du béton.
    normalScale: new THREE.Vector2(0.18, 0.18),
    color: new THREE.Color(0.44, 0.46, 0.5),
    roughnessMap: roadTextures.roughnessMap,
    roughness: 1,
    metalness: 0.03,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const paintMat = new THREE.MeshStandardMaterial({
    roughness: 0.7,
    vertexColors: true,
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -3,
  });

  const samples = TRACK.samples;
  let triangles = 0;

  // --- Asphalte -----------------------------------------------------------
  const asphalt = ribbon(samples, {
    from: -HALF_WIDTH,
    to: HALF_WIDTH,
    y: ROAD_LIFT,
    tile: 11,
  });
  const road = new THREE.Mesh(asphalt, asphaltMat);
  road.receiveShadow = true;
  road.name = 'flat-track';
  scene.add(road);
  triangles += asphalt.index ? asphalt.index.count / 3 : asphalt.attributes.position.count / 3;

  // Bords plus sombres : deux bandes étroites, même texture, teinte basse. Elles
  // donnent la largeur de la piste à distance sans éclaircir le centre.
  const edgeMat = new THREE.MeshStandardMaterial({
    map: roadTextures.map,
    normalMap: roadTextures.normalMap,
    color: new THREE.Color(EDGE_SHADE, EDGE_SHADE, EDGE_SHADE * 1.06),
    roughness: 0.96,
    metalness: 0.01,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  for (const side of [-1, 1]) {
    const strip = ribbon(samples, {
      from: side * (HALF_WIDTH - 1.6),
      to: side * HALF_WIDTH,
      y: ROAD_LIFT + 0.002,
      tile: 11,
    });
    const mesh = new THREE.Mesh(strip, edgeMat);
    mesh.receiveShadow = true;
    scene.add(mesh);
    triangles += strip.index ? strip.index.count / 3 : 0;
  }

  // --- Vibreurs : rouges et blancs, seulement dans les virages ------------
  const kerbPositions: number[] = [];
  const kerbColors: number[] = [];
  const kerbIndices: number[] = [];
  const red = new THREE.Color(0xb9252a);
  const cream = new THREE.Color(0xe8e4d8);
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i];
    if (!hasKerb(sample)) continue;
    const next = samples[(i + 1) % samples.length];
    const span = Math.max(0.5, next.distance > sample.distance
      ? next.distance - sample.distance
      : TRACK.length - sample.distance);
    const shade = Math.floor(sample.distance / KERB_SEGMENT) % 2 === 0 ? red : cream;
    for (const side of [-1, 1]) {
      flatQuad(
        sample,
        side * HALF_WIDTH,
        side * (HALF_WIDTH + KERB_WIDTH),
        ROAD_LIFT + 0.012,
        span,
        shade,
        kerbPositions,
        kerbColors,
        kerbIndices,
      );
    }
  }
  if (kerbPositions.length > 0) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(kerbPositions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(kerbColors, 3));
    geometry.setIndex(kerbIndices);
    geometry.computeVertexNormals();
    const kerbs = new THREE.Mesh(geometry, paintMat);
    kerbs.receiveShadow = true;
    scene.add(kerbs);
    triangles += kerbIndices.length / 3;
  }

  // --- Lignes blanches de bord -------------------------------------------
  const lineMat = new THREE.MeshStandardMaterial({
    color: 0xf1efe6,
    roughness: 0.7,
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -3,
  });
  for (const side of [-1, 1]) {
    const line = ribbon(samples, {
      from: side * (HALF_WIDTH - 0.34),
      to: side * (HALF_WIDTH - 0.06),
      y: ROAD_LIFT + 0.006,
      tile: 20,
    });
    const mesh = new THREE.Mesh(line, lineMat);
    mesh.receiveShadow = true;
    scene.add(mesh);
    triangles += line.index ? line.index.count / 3 : 0;
  }

  // --- Ligne de départ-arrivée ------------------------------------------
  const startLine = new THREE.Mesh(startLineGeometry(START_LINE), paintMat);
  startLine.receiveShadow = true;
  scene.add(startLine);
  triangles += startLine.geometry.index ? startLine.geometry.index.count / 3 : 0;

  // --- Murs : boîtes alignées, sans trou ni recouvrement ------------------
  const wallSamples = resample(WALL_STEP);
  const buildMsStart = performance.now();
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const wallGeometry = new THREE.BoxGeometry(WALL_THICK, WALL_HEIGHT, 1);
  const concreteTexture = createConcreteTexture();
  concreteTexture.repeat.set(2, 1);
  concreteTexture.anisotropy = options.anisotropy;
  const wallMat = new THREE.MeshStandardMaterial({
    map: concreteTexture,
    roughness: 0.85,
    metalness: 0.03,
  });
  const walls = new THREE.InstancedMesh(wallGeometry, wallMat, wallSamples.length * 2);
  const caps = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.12, 0.16, 1),
    new THREE.MeshStandardMaterial({ roughness: 0.55 }),
    wallSamples.length * 2,
  );
  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3(1, 1, 1);
  const capColor = new THREE.Color();
  let wallIndex = 0;
  for (let i = 0; i < wallSamples.length; i++) {
    const a = wallSamples[i];
    const b = nextSample(wallSamples, i);
    for (const side of [-1, 1]) {
      const rightA = rightOf(a);
      const rightB = rightOf(b);
      const ax = a.x + rightA.x * WALL_OFFSET * side;
      const az = a.z + rightA.z * WALL_OFFSET * side;
      const bx = b.x + rightB.x * WALL_OFFSET * side;
      const bz = b.z + rightB.z * WALL_OFFSET * side;
      const dx = bx - ax;
      const dz = bz - az;
      const span = Math.hypot(dx, dz);
      if (span < 1e-4) continue;
      const yaw = Math.atan2(dx, dz);
      quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
      position.set((ax + bx) / 2, WALL_HEIGHT / 2, (az + bz) / 2);
      scale.set(1, 1, span + WALL_OVERLAP);
      matrix.compose(position, quaternion, scale);
      walls.setMatrixAt(wallIndex, matrix);
      // Le chapeau repose *sur* le mur : à 2 cm au-dessus du centre, sa moitié
      // basse entrait dans la boîte du mur et clignotait.
      caps.setMatrixAt(wallIndex, matrix.setPosition(position.x, WALL_HEIGHT + 0.09, position.z));
      capColor.set(wallIndex % 2 === 0 ? 0xd8d5cc : 0xb02a2c);
      caps.setColorAt(wallIndex, capColor);
      wallIndex++;

      world.createCollider(
        RAPIER.ColliderDesc.cuboid(WALL_THICK / 2, WALL_HEIGHT / 2, span / 2 + WALL_OVERLAP / 2)
          .setTranslation(position.x, position.y, position.z)
          .setRotation({ x: quaternion.x, y: quaternion.y, z: quaternion.z, w: quaternion.w })
          .setFriction(0.6)
          .setRestitution(0.05)
          .setCollisionGroups(WALL_GROUP),
        body,
      );
    }
  }
  walls.count = wallIndex;
  walls.castShadow = true;
  walls.receiveShadow = true;
  caps.count = wallIndex;
  caps.receiveShadow = true;
  scene.add(walls, caps);
  triangles += 12 * wallIndex * 2;

  // --- Portique de départ ------------------------------------------------
  const start = wallSamples[0];
  const right = rightOf(start);
  const gantryMat = new THREE.MeshStandardMaterial({ color: 0x22262c, roughness: 0.55, metalness: 0.45 });
  // Les mâts se plantent derrière le mur : sur le dégagement, une voiture
  // sortie large les traverserait sans rien toucher.
  const GANTRY_HALF = WALL_OFFSET + 2.5;
  for (const side of [-1, 1]) {
    const x = start.x + right.x * GANTRY_HALF * side;
    const z = start.z + right.z * GANTRY_HALF * side;
    const mast = new THREE.Mesh(new THREE.BoxGeometry(0.7, 7.6, 0.7), gantryMat);
    mast.position.set(x, 3.8, z);
    mast.castShadow = true;
    scene.add(mast);
  }
  // La poutre doit être *en travers* de la piste : sa largeur locale suit X,
  // donc le cap de la piste suffit. Le +π/2 de la première version la posait
  // dans l'axe de la ligne droite, comme un rail au-dessus des voitures.
  const gantryYaw = Math.atan2(start.tx, start.tz);
  const beam = new THREE.Mesh(new THREE.BoxGeometry((GANTRY_HALF + 0.4) * 2, 1.1, 0.9), gantryMat);
  beam.position.set(
    start.x + start.tx * START_LINE,
    7.2,
    start.z + start.tz * START_LINE,
  );
  beam.rotation.y = gantryYaw;
  beam.castShadow = true;
  scene.add(beam);
  // Cinq feux de départ sous la poutre, face à la voiture.
  const lightMat = new THREE.MeshStandardMaterial({
    color: 0x2a0a0a,
    emissive: 0x3a0505,
    roughness: 0.35,
  });
  for (let i = 0; i < 5; i++) {
    const offset = (i - 2) * 1.15;
    const light = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.52, 0.2), lightMat);
    light.position.set(
      beam.position.x + Math.cos(gantryYaw) * offset,
      6.4,
      beam.position.z - Math.sin(gantryYaw) * offset,
    );
    light.rotation.y = gantryYaw + Math.PI;
    scene.add(light);
  }
  // Deux faces dos à dos, chacune sur une face de la poutre : à 2 cm du centre,
  // elles étaient *dans* la poutre (90 cm d'épaisseur) et invisibles. Le
  // bandeau porte le nom du circuit et quatre écuries.
  const BEAM_DEPTH = 0.9;
  const gantryMaterial = new THREE.MeshBasicMaterial({ map: gantryBannerTexture() });
  for (const [turn, shift] of [[0, BEAM_DEPTH / 2 + 0.02], [Math.PI, -(BEAM_DEPTH / 2 + 0.02)]] as const) {
    const face = new THREE.Mesh(new THREE.PlaneGeometry(24, 2.1), gantryMaterial);
    face.position.copy(beam.position);
    face.position.y = 6.35;
    face.position.x += Math.sin(gantryYaw) * shift;
    face.position.z += Math.cos(gantryYaw) * shift;
    face.rotation.y = gantryYaw + turn;
    scene.add(face);
  }

  const scenery = buildScenery(scene, options.anisotropy, options.lowFx);
  triangles += scenery;
  const buildMs = performance.now() - buildMsStart;

  return {
    spawn: TRACK.spawn,
    meshes: scene.children.length,
    triangles: Math.round(triangles),
    loadMs: Math.round(performance.now() - started),
    buildMs: Math.round(buildMs),
    length: TRACK.length,
    walls: wallIndex,
  };
}
