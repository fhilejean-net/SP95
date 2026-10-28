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
import { createAsphaltTexture, createConcreteTexture } from '../render/materials.ts';
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

  // --- Pit lane : une dalle, un long bâtiment, huit garages -----------------
  const pad = new THREE.Mesh(new THREE.PlaneGeometry(46, 300), concreteMat);
  pad.rotation.x = -Math.PI / 2;
  pad.position.set(-42, ROAD_LIFT, -290);
  add(pad, 'receive');

  box(15, 8.4, 118, -33, 4.2, -300, concreteMat, 0, 'both');
  box(15.8, 0.7, 120, -33, 8.6, -300, darkMat, 0, 'both');
  // Bandeau vitré au-dessus des garages, puis les portes.
  box(0.2, 1.7, 112, -25.4, 6.1, -300, glassMat, 0, 'none');
  for (let i = 0; i < 8; i++) {
    const z = -354 + i * 13.6;
    box(0.35, 3.9, 8.4, -25.4, 1.95, z, darkMat, 0, 'none');
    box(0.25, 0.22, 8.4, -25.15, 0.11, z, whiteMat, 0, 'none');
  }
  // Enseigne du bâtiment, tournée vers la piste.
  const sign = new THREE.Mesh(
    new THREE.PlaneGeometry(18, 3.4),
    new THREE.MeshBasicMaterial({ map: boardTexture('SP95', '#a3141c', '#f4f1e8') }),
  );
  sign.position.set(-25.2, 8.2, -300);
  sign.rotation.y = Math.PI / 2;
  scene.add(sign);

  // --- Tribune principale, face à la ligne --------------------------------
  const steps = 10;
  const stepDepth = 2.1;
  for (let row = 0; row < steps; row++) {
    box(stepDepth, 0.62 + row * 0.62, 92, -24 + row * stepDepth, (0.62 + row * 0.62) / 2, -190, concreteMat);
  }
  // Gradins : une marche de béton, une assise de couleur par rangée.
  const seats = new THREE.InstancedMesh(new THREE.BoxGeometry(0.46, 0.34, 0.5), seatMat, steps * 46);
  const matrix = new THREE.Matrix4();
  const color = new THREE.Color();
  let seat = 0;
  for (let row = 0; row < steps; row++) {
    for (let column = 0; column < 46; column++) {
      matrix.makeTranslation(-22.9 + row * stepDepth, 0.62 + row * 0.62 + 0.17, -236 + column * 2);
      seats.setMatrixAt(seat, matrix);
      color.set(row % 3 === 0 ? 0xb02026 : 0xd8d6cd);
      seats.setColorAt(seat, color);
      seat++;
    }
  }
  seats.castShadow = false;
  seats.receiveShadow = true;
  scene.add(seats);
  // Toit de tribune et ses poteaux.
  box(24, 0.5, 94, -29, 9.6, -190, metalMat);
  for (const z of [-232, -190, -148]) box(0.6, 9.6, 0.6, -40, 4.8, z, metalMat);

  // --- Tour de contrôle et postes de commissaires --------------------------
  box(7, 15, 7, -52, 7.5, -360, concreteMat);
  box(11, 2.4, 11, -52, 16, -360, glassMat, 0, 'none');
  for (const [x, z] of [
    [30, -500], [355, -420], [390, -180], [330, 40], [180, 35], [-12, -120],
  ]) {
    box(3.4, 2.7, 3.4, x, 1.35, z, whiteMat);
    box(4.2, 0.25, 4.2, x, 2.8, z, darkMat);
  }

  // --- Panneaux publicitaires, sur le haut du mur -------------------------
  const boards = [
    { map: boardTexture('SP95', '#a3141c', '#f4f1e8'), step: 26 },
    { map: boardTexture('TURBO', '#f2f0e8', '#1a1c20'), step: 26 },
    { map: boardTexture('PISTON', '#e8b422', '#191a1c'), step: 26 },
  ];
  const wallSamples = resample(WALL_STEP);
  boards.forEach((board, boardIndex) => {
    const geometry = new THREE.PlaneGeometry(7, 1.3);
    const material = new THREE.MeshStandardMaterial({ map: board.map, roughness: 0.7, side: THREE.DoubleSide });
    const parts: THREE.BufferGeometry[] = [];
    const stride = Math.max(1, Math.round(board.step / WALL_STEP));
    for (let i = boardIndex * 5; i < wallSamples.length; i += stride) {
      const sample = wallSamples[i % wallSamples.length];
      const right = rightOf(sample);
      const sign = geometry.clone();
      const yaw = Math.atan2(sample.tx, sample.tz);
      const position = new THREE.Vector3(
        sample.x + right.x * (WALL_OFFSET + 0.05),
        1.8,
        sample.z + right.z * (WALL_OFFSET + 0.05),
      );
      sign.rotateY(yaw + Math.PI / 2);
      sign.translate(position.x, position.y, position.z);
      parts.push(sign);
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
  const asphaltTexture = createAsphaltTexture();
  asphaltTexture.anisotropy = options.anisotropy;
  const asphaltMat = new THREE.MeshStandardMaterial({
    map: asphaltTexture,
    roughness: 0.93,
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
    map: asphaltTexture,
    color: new THREE.Color(EDGE_SHADE, EDGE_SHADE, EDGE_SHADE * 1.06),
    roughness: 0.95,
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
      caps.setMatrixAt(wallIndex, matrix.setPosition(position.x, WALL_HEIGHT + 0.02, position.z));
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
  const gantryMat = new THREE.MeshStandardMaterial({ color: 0x2a2d33, roughness: 0.5, metalness: 0.5 });
  for (const side of [-1, 1]) {
    const x = start.x + right.x * (HALF_WIDTH + 4) * side;
    const z = start.z + right.z * (HALF_WIDTH + 4) * side;
    const mast = new THREE.Mesh(new THREE.BoxGeometry(0.7, 7.6, 0.7), gantryMat);
    mast.position.set(x, 3.8, z);
    mast.castShadow = true;
    scene.add(mast);
  }
  const beam = new THREE.Mesh(new THREE.BoxGeometry((HALF_WIDTH + 4.4) * 2, 1.1, 0.9), gantryMat);
  beam.position.set(
    start.x - start.tx * START_LINE,
    7.2,
    start.z - start.tz * START_LINE,
  );
  beam.rotation.y = Math.atan2(start.tx, start.tz) + Math.PI / 2;
  beam.castShadow = true;
  scene.add(beam);
  const gantrySign = new THREE.Mesh(
    new THREE.PlaneGeometry(11, 1.6),
    new THREE.MeshBasicMaterial({ map: boardTexture('SP95  ·  CIRCUIT', '#12141a', '#f2efe6'), side: THREE.DoubleSide }),
  );
  gantrySign.position.copy(beam.position);
  gantrySign.position.y = 6.5;
  gantrySign.rotation.y = Math.atan2(start.tx, start.tz) + Math.PI;
  scene.add(gantrySign);

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
