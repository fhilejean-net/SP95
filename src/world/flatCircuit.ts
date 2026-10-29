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
  createGravelTexture,
  createTrackSurfaceTextures,
} from '../render/materials.ts';
import {
  HALF_WIDTH,
  KERB_WIDTH,
  ROAD_LIFT,
  TRACK,
  WALL_OFFSET,
  WALL_THICK,
  hasKerb,
  type TrackSample,
} from './trackLayout.ts';
import { brakingMarkers } from './brakingMarkers.ts';
import { buildBrakingBoards } from '../render/brakingBoards.ts';
import { gravelFillAt, gravelRuns } from './circuitDecor.ts';
import { buildSponsorFence } from '../render/sponsorFence.ts';
import { buildDriftPad } from '../render/driftPad.ts';
import { DRIFT_PAD, driftWallGap, insideDriftPad } from './driftPad.ts';
import { buildPitLaneDetail } from '../render/pitLaneDetail.ts';
import { buildPitGarage } from '../render/pitGarage.ts';
import {
  PIT_APRON_FROM,
  PIT_APRON_TO,
  PIT_LANE_FROM,
  PIT_LANE_HALF,
  PIT_LANE_TO,
  PIT_LANE_X,
  PIT_THROATS,
  PIT_THROAT_INNER_X,
  PIT_WALL_OUTER,
  pitWallGap,
} from './pitLayout.ts';

/** Les murs ne collisionnent que la coque, comme les bâtiments de la ville. */
const WALL_GROUP = (GROUP_WORLD << 16) | GROUP_WORLD;
const WALL_HEIGHT = 1.05;
/** Pas des murs : trois mètres, avec recouvrement, ne laissent aucune fente. */
const WALL_STEP = 3;
const WALL_OVERLAP = 0.25;
/** Distance de la ligne peinte devant le point de départ. */
const START_LINE = 8;
/** Teinte des bords de piste : plus sombre, pour lire la largeur au loin. */
const EDGE_SHADE = 0.86;
/** Alternance des vibreurs, en mètres. */
const KERB_SEGMENT = 2.4;
/** Rayon en dessous duquel un mur reçoit des pneus empilés. */
const TYRE_RADIUS = 75;
/** Tuile carrée de l'asphalte, en mètres. */
const ASPHALT_TILE = 6;
/**
 * Profil du bac, en fraction de sa largeur : [fraction, hauteur]. Le gravier se
 * bombe contre le mur comme une banquette au lieu d'être une plaque.
 */
const GRAVEL_PROFILE: [number, number][] = [
  [0, 0.015],
  [0.24, 0.055],
  [0.62, 0.1],
  [0.9, 0.15],
  [1, 0.115],
];
/** Largeur du liséré de terre qui raccorde le bac à l'herbe, en mètres. */
const GRAVEL_FRINGE = 2.6;
/** Tuile du gravier, en mètres. */
const GRAVEL_TILE = 5;
/**
 * Profil du vibreur, du bord de la piste vers l'extérieur : [décalage latéral,
 * hauteur au-dessus du sol]. Un vibreur peint à plat ne se lit pas ; ce profil
 * lui donne le bombé d'un vrai vibreur, sans rien changer à la physique — les
 * roues roulent toujours sur le plan du terrain.
 */
const KERB_PROFILE: [number, number][] = [
  [0, 0.022],
  [0.32, 0.062],
  [KERB_WIDTH - 0.32, 0.062],
  [KERB_WIDTH, 0.03],
];
/** Trajectoire gommée : décalage latéral des colonnes, puis leur opacité. */
const RACING_LINE_LATERAL = [-4.3, -2.6, -1.7, -0.7, 0.7, 1.7, 2.6, 4.3];
const RACING_LINE_ALPHA = [0, 0.1, 0.42, 0.14, 0.14, 0.42, 0.1, 0];

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
 * Trajectoire gommée : deux bandes sombres aux passages de roues, avec un
 * dégradé d'alpha vers les bords. Une piste uniformément noire lit comme du
 * plastique ; ces bandes sont la seule marque que le circuit garde du passage
 * des voitures.
 */
function racingLineGeometry(samples: TrackSample[]): THREE.BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const columns = RACING_LINE_LATERAL.length;
  const tint = new THREE.Color(0x191b1e);
  samples.forEach((sample, index) => {
    const right = rightOf(sample);
    for (let column = 0; column < columns; column++) {
      const lateral = RACING_LINE_LATERAL[column];
      positions.push(
        sample.x + right.x * lateral,
        ROAD_LIFT + 0.004,
        sample.z + right.z * lateral,
      );
      colors.push(tint.r, tint.g, tint.b, RACING_LINE_ALPHA[column]);
    }
    if (index === samples.length - 1) return;
    const base = index * columns;
    for (let column = 0; column < columns - 1; column++) {
      const a = base + column;
      const b = a + 1;
      const c = base + columns + column;
      const d = c + 1;
      indices.push(a, b, c, b, d, c);
    }
  });
  // Fermeture de la boucle.
  const last = (samples.length - 1) * columns;
  for (let column = 0; column < columns - 1; column++) {
    const a = last + column;
    const b = a + 1;
    indices.push(a, b, column, b, column + 1, column);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  // Un attribut de couleur à quatre canaux porte l'alpha du dégradé.
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 4));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Vibreurs en relief : quatre points de profil par échantillon, rouges et blancs
 * alternés. Le sens de l'enroulement est calculé depuis la normale, sinon une
 * des deux rangées regarde le sol et disparaît.
 */
function kerbGeometry(samples: TrackSample[]): THREE.BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const red = new THREE.Color(0xa81f28);
  const cream = new THREE.Color(0xd9d3c4);
  for (let i = 0; i < samples.length; i++) {
    const a = samples[i];
    const b = samples[(i + 1) % samples.length];
    if (!hasKerb(a) || !hasKerb(b)) continue;
    const shade = Math.floor(a.distance / KERB_SEGMENT) % 2 === 0 ? red : cream;
    const rightA = rightOf(a);
    const rightB = rightOf(b);
    for (const side of [-1, 1] as const) {
      const base = positions.length / 3;
      for (const [lateral, height] of KERB_PROFILE) {
        const from = side * (HALF_WIDTH + lateral);
        positions.push(
          a.x + rightA.x * from, ROAD_LIFT + height, a.z + rightA.z * from,
          b.x + rightB.x * from, ROAD_LIFT + height, b.z + rightB.z * from,
        );
        colors.push(shade.r, shade.g, shade.b, shade.r, shade.g, shade.b);
      }
      for (let k = 0; k < KERB_PROFILE.length - 1; k++) {
        const i0 = base + k * 2;
        const i1 = i0 + 1;
        const i2 = i0 + 2;
        const i3 = i0 + 3;
        const p0 = positions.slice(i0 * 3, i0 * 3 + 3);
        const p1 = positions.slice(i1 * 3, i1 * 3 + 3);
        const p2 = positions.slice(i2 * 3, i2 * 3 + 3);
        const ny =
          (p1[2] - p0[2]) * (p2[0] - p0[0]) - (p1[0] - p0[0]) * (p2[2] - p0[2]);
        if (ny >= 0) indices.push(i0, i1, i2, i1, i3, i2);
        else indices.push(i0, i2, i1, i1, i2, i3);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Bacs à gravier : une bande entre le vibreur et le mur, à l'extérieur des
 * virages. Trois choses manquaient à la première version, qui était une plaque
 * grise coupée net : la largeur ne suivait pas le serrage du virage, le bord
 * était une arête vive au milieu de l'herbe, et le gravier était parfaitement
 * plat. Ici le bac s'ouvre avec le rayon, s'éteint sur dix-huit mètres à ses
 * extrémités et se bombe contre le mur. Purement visuel : la physique garde son
 * sol plat.
 */
function gravelGeometry(samples: TrackSample[]): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const from = HALF_WIDTH + KERB_WIDTH + 0.05;
  const full = WALL_OFFSET - 0.45 - from;
  const columns = GRAVEL_PROFILE.length;
  const count = samples.length;
  for (const run of gravelRuns(samples)) {
    const span = run.end >= run.start ? run.end - run.start + 1 : count - run.start + run.end + 1;
    let previous = -1;
    for (let step = 0; step < span; step++) {
      const index = (run.start + step) % count;
      const sample = samples[index];
      const fill = gravelFillAt(samples, run, index);
      const right = rightOf(sample);
      const width = full * fill;
      const base = positions.length / 3;
      // Ratissage : la teinte ondule tous les mètres, comme un gravier travaillé.
      const rake = 0.9 + 0.1 * Math.sin(sample.distance * 0.9);
      for (const [fraction, height] of GRAVEL_PROFILE) {
        const lateral = run.side * (from + width * fraction);
        positions.push(
          sample.x + right.x * lateral,
          ROAD_LIFT + 0.004 + height * fill,
          sample.z + right.z * lateral,
        );
        uvs.push((width * fraction) / GRAVEL_TILE, sample.distance / GRAVEL_TILE);
        // Le bord extérieur s'assombrit : sans ça le bac se termine sur une
        // arête claire que la frange doit ensuite cacher.
        const rim = 1 - 0.3 * fraction;
        colors.push(rake * rim, rake * rim, rake * rim * 0.97);
      }
      if (previous >= 0) {
        for (let column = 0; column < columns - 1; column++) {
          const a = previous + column;
          const b = a + 1;
          const c = base + column;
          const d = c + 1;
          const ax = positions[a * 3];
          const az = positions[a * 3 + 2];
          const bx = positions[b * 3];
          const bz = positions[b * 3 + 2];
          const cx = positions[c * 3];
          const cz = positions[c * 3 + 2];
          const ny = (cz - az) * (bx - ax) - (cx - ax) * (bz - az);
          if (ny >= 0) indices.push(a, c, b, b, c, d);
          else indices.push(a, b, c, b, d, c);
        }
      }
      previous = base;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Frange de terre du bac : la bande qui va du gravier vers l'herbe et s'efface.
 * L'alpha est porté par les sommets (quatre colonnes), pas par une texture : le
 * grain du gravier s'éparpille et s'arrête, au lieu de finir sur l'arête claire
 * d'une bande posée sur la pelouse.
 */
function gravelFringeGeometry(samples: TrackSample[]): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const from = HALF_WIDTH + KERB_WIDTH + 0.05;
  const full = WALL_OFFSET - 0.45 - from;
  const count = samples.length;
  /** Décalage dans la frange, et part de gravier qui reste à cette distance. */
  const fringe: [number, number][] = [
    [0, 0.95],
    [0.3, 0.66],
    [0.64, 0.3],
    [1, 0],
  ];
  const columns = fringe.length;
  for (const run of gravelRuns(samples)) {
    const span = run.end >= run.start ? run.end - run.start + 1 : count - run.start + run.end + 1;
    let previous = -1;
    for (let step = 0; step < span; step++) {
      const index = (run.start + step) % count;
      const fill = gravelFillAt(samples, run, index);
      if (fill < 0.3) {
        previous = -1;
        continue;
      }
      const sample = samples[index];
      const right = rightOf(sample);
      const base = positions.length / 3;
      for (const [offset, alpha] of fringe) {
        const lateral = run.side * (from + full * fill + GRAVEL_FRINGE * offset);
        positions.push(
          sample.x + right.x * lateral,
          ROAD_LIFT + 0.005,
          sample.z + right.z * lateral,
        );
        // Même tuile que le bac : le gravier continue, il s'éclaircit seulement.
        uvs.push((GRAVEL_FRINGE * offset) / GRAVEL_TILE, sample.distance / GRAVEL_TILE);
        colors.push(1, 1, 1, alpha);
      }
      if (previous >= 0) {
        for (let column = 0; column < columns - 1; column++) {
          const a = previous + column;
          const b = a + 1;
          const c = base + column;
          const d = c + 1;
          const ax = positions[a * 3];
          const az = positions[a * 3 + 2];
          const bx = positions[b * 3];
          const bz = positions[b * 3 + 2];
          const cx = positions[c * 3];
          const cz = positions[c * 3 + 2];
          const ny = (cz - az) * (bx - ax) - (cx - ax) * (bz - az);
          if (ny >= 0) indices.push(a, c, b, b, c, d);
          else indices.push(a, b, c, b, d, c);
        }
      }
      previous = base;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 4));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
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
 * Grand stands, atelier, pneus, arbres et panneaux : tout est bâti ici, à la
 * cote zéro, et aucun de ces objets ne porte de collision — ils sont derrière
 * les murs, ou hors d'atteinte.
 */
function buildScenery(
  scene: THREE.Scene,
  world: RAPIER.World,
  anisotropy: number,
  lowFx: boolean,
): number {
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

  // --- Stands : la voie est *derrière* le muret --------------------------
  // La dalle couvre la voie et l'atelier : les garages ouvrent dessus.
  const padLength = PIT_APRON_TO - PIT_APRON_FROM;
  // La dalle ne court plus jusqu'à x = -65 : elle s'arrête huit mètres derrière
  // les garages, ce qui laisse la clôture et les arbres sur l'herbe au lieu de
  // les planter au milieu du béton.
  const pad = new THREE.Mesh(new THREE.PlaneGeometry(36, padLength), concreteMat);
  pad.rotation.x = -Math.PI / 2;
  pad.position.set(-37, ROAD_LIFT, (PIT_APRON_FROM + PIT_APRON_TO) / 2);
  add(pad, 'receive');

  const pitLane = new THREE.Mesh(
    new THREE.PlaneGeometry(PIT_LANE_HALF * 2, PIT_LANE_TO - PIT_LANE_FROM),
    pitAsphalt,
  );
  pitLane.rotation.x = -Math.PI / 2;
  pitLane.position.set(PIT_LANE_X, ROAD_LIFT + 0.004, (PIT_LANE_FROM + PIT_LANE_TO) / 2);
  add(pitLane, 'receive');

  // Raccordements piste ↔ stands : deux traversées du dégagement, là où le
  // muret est ouvert. Sans elles, la voie serait une impasse derrière le mur.
  for (const throat of PIT_THROATS) {
    // Largeur positive : la face intérieure est à -6, la face du muret à
    // -18,95. La soustraction dans l'autre sens donnait un plan retourné, donc
    // invisible — le raccordement restait de l'herbe à l'écran.
    const ramp = new THREE.Mesh(
      new THREE.PlaneGeometry(PIT_THROAT_INNER_X - PIT_WALL_OUTER, throat.to - throat.from),
      pitAsphalt,
    );
    ramp.rotation.x = -Math.PI / 2;
    ramp.position.set(
      (PIT_THROAT_INNER_X + PIT_WALL_OUTER) / 2,
      ROAD_LIFT + 0.004,
      (throat.from + throat.to) / 2,
    );
    add(ramp, 'receive');
  }

  // Détail de la voie : emplacements numérotés, rail de muret, pneus, chrono.
  const pitDetail = buildPitLaneDetail(scene, anisotropy);
  triangles += pitDetail.triangles;
  // Les boxes : un bâtiment ouvert, ses cloisons et son toit.
  const garage = buildPitGarage(scene, world, anisotropy);
  triangles += garage.triangles;

  // --- Tribune principale : les gradins montent *vers l'extérieur* --------
  // La première version montait vers la piste : le public tournait le dos au
  // circuit et le toit passait au-dessus des sièges du premier rang.
  const steps = 10;
  const stepDepth = 2.1;
  // La tribune regarde la ligne droite depuis le côté *opposé* aux stands :
  // à x = -24 elle occupait la voie des stands et traversait les garages.
  const front = 24;
  const standZ = -300;
  for (let row = 0; row < steps; row++) {
    const height = 0.62 + row * 0.62;
    box(stepDepth, height, 92, front + (row + 0.5) * stepDepth, height / 2, standZ, concreteMat);
  }
  // Assises : une par place, couleur par rangée.
  const seats = new THREE.InstancedMesh(new THREE.BoxGeometry(0.46, 0.34, 0.5), seatMat, steps * 46);
  const matrix = new THREE.Matrix4();
  const color = new THREE.Color();
  let seat = 0;
  for (let row = 0; row < steps; row++) {
    for (let column = 0; column < 46; column++) {
      matrix.makeTranslation(
        front + (row + 1) * stepDepth - 0.55,
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
  banner.position.set(front - 0.06, 2.15, standZ);
  banner.rotation.y = -Math.PI / 2;
  scene.add(banner);
  // Escaliers d'accès, de chaque côté de la tribune.
  for (const z of [standZ - 47, standZ + 47]) {
    box(6, 0.5, 2.4, front + 3, 3.2, z, concreteMat);
  }
  // Toit de tribune, posé au-dessus des gradins, et ses poteaux à l'arrière.
  box(22, 0.5, 94, front + 5 * stepDepth, 9.6, standZ, metalMat);
  for (const z of [standZ - 38, standZ, standZ + 38]) box(0.6, 9.6, 0.6, front + 19, 4.8, z, metalMat);

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
    // Aucun poste sur la ligne droite : la voie des stands et son paddock y
    // sont, et un poste de commissaire au milieu du bitume n'a aucun sens.
    if (z < -240 && z > -545 && x < 10) continue;
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

  // --- Palissade publicitaire, posée sur le muret -------------------------
  // Un bandeau continu qui suit le mur, au lieu de plaques plates semées tous
  // les 25 m : dans un virage de 23 m de rayon, la corde d'une plaque de 6,4 m
  // s'enfonçait de 22 cm dans le béton et les panneaux voisins se coupaient.
  const wallSamples = resample(WALL_STEP);
  const fence = buildSponsorFence(scene, anisotropy, metalMat);
  triangles += fence.triangles;

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
          // Pas de touffes sur la dalle des stands ni sur l'aire de gymkhana :
          // c'était de l'herbe plantée dans le paddock, à l'envers sur le
          // béton, et au milieu du tracé de drift.
          if (x < -16 && z < -250 && z > -535) continue;
          if (insideDriftPad(x, z)) continue;
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
      // L'aire de gymkhana est un ouvrage : aucun arbre ne pousse dessus. La
      // marge évite qu'une couronne déborde au-dessus du bitume.
      if (
        x > DRIFT_PAD.cx - DRIFT_PAD.halfX - 12 &&
        x < DRIFT_PAD.cx + DRIFT_PAD.halfX + 18 &&
        z > DRIFT_PAD.cz - DRIFT_PAD.halfZ - 18 &&
        z < DRIFT_PAD.cz + DRIFT_PAD.halfZ + 20
      ) {
        continue;
      }
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
  // Asphalte procédural, tuilé en carré : 6 m dans les deux sens. Le grain se
  // lit à un mètre et ne scintille pas au loin, contrairement au relevé photo
  // dont les graviers blancs clignotaient.
  const roadTextures = createTrackSurfaceTextures(options.anisotropy);
  for (const texture of [roadTextures.map, roadTextures.normalMap, roadTextures.roughnessMap]) {
    texture.repeat.set((HALF_WIDTH * 2) / ASPHALT_TILE, 1);
  }
  const asphaltMat = new THREE.MeshStandardMaterial({
    map: roadTextures.map,
    normalMap: roadTextures.normalMap,
    normalScale: new THREE.Vector2(0.32, 0.32),
    roughnessMap: roadTextures.roughnessMap,
    color: 0xffffff,
    roughness: 1,
    metalness: 0.02,
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
    tile: ASPHALT_TILE,
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
    normalScale: new THREE.Vector2(0.32, 0.32),
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
      tile: ASPHALT_TILE,
    });
    const mesh = new THREE.Mesh(strip, edgeMat);
    mesh.receiveShadow = true;
    scene.add(mesh);
    triangles += strip.index ? strip.index.count / 3 : 0;
  }

  // --- Trajectoire gommée : deux bandes souples sur l'asphalte ------------
  const racingLine = new THREE.Mesh(
    racingLineGeometry(samples),
    new THREE.MeshStandardMaterial({
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      roughness: 0.52,
      metalness: 0.02,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    }),
  );
  racingLine.name = 'racing-line';
  scene.add(racingLine);

  // --- Vibreurs : rouges et blancs, en relief, dans les virages -----------
  const kerbMesh = kerbGeometry(samples);
  if (kerbMesh.index && kerbMesh.index.count > 0) {
    const kerbMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.55,
      metalness: 0.02,
    });
    const kerbs = new THREE.Mesh(kerbMesh, kerbMat);
    kerbs.receiveShadow = true;
    scene.add(kerbs);
    triangles += kerbMesh.index.count / 3;
  } else {
    kerbMesh.dispose();
  }

  // --- Bacs à gravier à l'extérieur des virages serrés --------------------
  const gravelMesh = gravelGeometry(samples);
  if (gravelMesh.index && gravelMesh.index.count > 0) {
    const gravelTexture = createGravelTexture();
    gravelTexture.anisotropy = options.anisotropy;
    const gravelMat = new THREE.MeshStandardMaterial({
      map: gravelTexture,
      vertexColors: true,
      color: 0xb6ab97,
      roughness: 1,
      metalness: 0,
    });
    const gravel = new THREE.Mesh(gravelMesh, gravelMat);
    gravel.receiveShadow = true;
    scene.add(gravel);
    triangles += gravelMesh.index.count / 3;

    // Le liséré de terre : ce qui raccorde le bac à l'herbe.
    const fringeMesh = gravelFringeGeometry(samples);
    if (fringeMesh.index && fringeMesh.index.count > 0) {
      const fringe = new THREE.Mesh(
        fringeMesh,
        new THREE.MeshStandardMaterial({
          map: gravelTexture,
          vertexColors: true,
          transparent: true,
          depthWrite: false,
          roughness: 1,
          metalness: 0,
          polygonOffset: true,
          polygonOffsetFactor: -2,
          polygonOffsetUnits: -2,
        }),
      );
      fringe.name = 'flat-gravel-fringe';
      fringe.receiveShadow = true;
      scene.add(fringe);
      triangles += fringeMesh.index.count / 3;
    } else {
      fringeMesh.dispose();
    }
  } else {
    gravelMesh.dispose();
  }

  // --- Panneaux de freinage 150/100/50 m --------------------------------
  // Posés dans le dégagement avant chaque entrée de virage, face à la voiture
  // qui arrive. Purement visuels : une sortie large les traverse.
  const markerPlan = brakingMarkers();
  const markerBoards = buildBrakingBoards(scene, markerPlan, options.anisotropy);
  triangles += markerBoards.triangles;

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
    // Le béton nu sortait blanc pur sous le ciel : une teinte chaude le calme.
    color: 0xd3d0c6,
    roughness: 0.85,
    metalness: 0.03,
  });
  const walls = new THREE.InstancedMesh(wallGeometry, wallMat, wallSamples.length * 2);
  const caps = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.12, 0.16, 1),
    new THREE.MeshStandardMaterial({ roughness: 0.55 }),
    wallSamples.length * 2,
  );
  // Plinthe sombre au pied du mur : sans elle le béton est un aplat clair du sol
  // jusqu'au chapeau, et le mur ne lit pas comme un ouvrage.
  const plinth = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.05, 0.3, 1),
    new THREE.MeshStandardMaterial({ color: 0x2f312e, roughness: 0.96 }),
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
      // Les deux traversées des stands : le muret s'ouvre, sinon la voie est
      // une impasse derrière lui. La voie est du côté x négatif, c'est-à-dire
      // `side = +1` (la normale à droite pointe vers -x sur cette ligne).
      if (side === 1 && pitWallGap(a.x, a.z, b.z)) continue;
      // Le raccordement de la gymkhana traverse le muret intérieur : le mur
      // s'ouvre là, sinon l'aire n'est qu'un décor derrière une clôture.
      if (side === -1 && driftWallGap(a.x, a.z, b.z)) continue;
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
      const inner = (WALL_OFFSET - WALL_THICK / 2 - 0.03) * side;
      plinth.setMatrixAt(
        wallIndex,
        matrix.setPosition(
          (a.x + rightA.x * inner + b.x + rightB.x * inner) / 2,
          0.15,
          (a.z + rightA.z * inner + b.z + rightB.z * inner) / 2,
        ),
      );
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
  plinth.count = wallIndex;
  plinth.receiveShadow = true;
  scene.add(walls, caps, plinth);
  triangles += 12 * wallIndex * 2;

  // Le portique de départ-arrivée n'est plus bâti ici : le modèle fourni
  // (finish_line) le remplace dans pitProps.ts.

  // L'aire de gymkhana, au centre du circuit, reliée à la ligne droite.
  const driftPad = buildDriftPad(scene, world, options.anisotropy);
  triangles += driftPad.triangles;

  const scenery = buildScenery(scene, world, options.anisotropy, options.lowFx);
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
