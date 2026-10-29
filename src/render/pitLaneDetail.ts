/**
 * Détail de la voie des stands : la dalle grise et ses pointillés ne suffisaient
 * pas à lire une voie des stands. Ici on pose ce qu'un joueur reconnaît tout de
 * suite — des emplacements numérotés, un rail de sécurité sur le muret, un poste
 * de chronométrage, des piles de pneus et des chariots.
 *
 * Tout est fusionné par matière et par usage : le marquage au sol tient en un
 * maillage, les numéros en un second (un atlas 4 × 2), les pneus et les chariots
 * sont instanciés. Six appels de dessin pour toute la voie, et aucune collision :
 * la voie reste du sol plat, on peut rouler dessus.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import {
  PIT_LANE_FROM,
  PIT_LANE_HALF,
  PIT_LANE_TO,
  PIT_LANE_X,
  PIT_WALL_OUTER,
  STALL_COUNT,
  STALL_FIRST_Z,
  STALL_PITCH,
  STALL_LENGTH,
} from '../world/pitLayout.ts';

export { PIT_LANE_FROM, PIT_LANE_HALF, PIT_LANE_TO, PIT_LANE_X, STALL_COUNT, STALL_PITCH };
const STALL_HALF_LENGTH = STALL_LENGTH / 2;
/** Cote du marquage, au-dessus de l'asphalte de la voie. */
const PAINT_Y = 0.036;
/** Teintes des écuries, reprises du bandeau du portique. */
const TEAM_COLOURS = [0xb3131b, 0x1d8f6f, 0x2b57a8, 0xe2a119];

interface QuadSink {
  positions: number[];
  indices: number[];
  colors?: number[];
  uvs?: number[];
}

/**
 * Quad posé à plat, sommets donnés dans l'ordre du tour. L'enroulement est
 * retourné si la face regarde le sol : un marquage vu de dessous disparaît.
 */
function addQuad(
  sink: QuadSink,
  points: [number, number][],
  y: number,
  color: THREE.Color | null,
  uv?: [number, number][],
): void {
  const base = sink.positions.length / 3;
  for (const [x, z] of points) sink.positions.push(x, y, z);
  if (color) {
    for (let i = 0; i < 4; i++) sink.colors!.push(color.r, color.g, color.b);
  }
  if (uv) for (const [u, v] of uv) sink.uvs!.push(u, v);
  const ax = points[1][0] - points[0][0];
  const az = points[1][1] - points[0][1];
  const bx = points[2][0] - points[0][0];
  const bz = points[2][1] - points[0][1];
  // Normale du triangle (0, 1, 2) : si elle pointe vers le sol, on retourne
  // l'enroulement, sinon tout le marquage disparaît vu du dessus.
  const ny = az * bx - ax * bz;
  if (ny < 0) sink.indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
  else sink.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

/** Rectangle à plat, entre deux x et deux z. */
function rect(
  sink: QuadSink,
  x0: number,
  x1: number,
  z0: number,
  z1: number,
  color: THREE.Color,
  y = PAINT_Y,
): void {
  addQuad(
    sink,
    [
      [x0, z0],
      [x1, z0],
      [x1, z1],
      [x0, z1],
    ],
    y,
    color,
  );
}

/** Atlas des numéros d'emplacement et des inscriptions au sol. */
const ATLAS_COLUMNS = 4;
const ATLAS_ROWS = 2;
const ATLAS_CELL = 256;
const ATLAS_LABELS = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8'];

function textAtlas(anisotropy: number): { texture: THREE.CanvasTexture; cell: (index: number) => [number, number, number, number] } {
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_COLUMNS * ATLAS_CELL;
  canvas.height = ATLAS_ROWS * ATLAS_CELL;
  const ctx = canvas.getContext('2d')!;
  const labels = [...ATLAS_LABELS, '60', 'PIT', '', ''];
  labels.forEach((label, index) => {
    if (!label) return;
    const column = index % ATLAS_COLUMNS;
    const row = Math.floor(index / ATLAS_COLUMNS);
    const x = column * ATLAS_CELL + ATLAS_CELL / 2;
    const y = row * ATLAS_CELL + ATLAS_CELL / 2;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 152px system-ui, sans-serif';
    ctx.lineWidth = 10;
    ctx.strokeStyle = 'rgba(12,14,18,0.55)';
    ctx.strokeText(label, x, y);
    ctx.fillStyle = '#f2f0e8';
    ctx.fillText(label, x, y);
    ctx.restore();
  });
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = anisotropy;
  return {
    texture,
    cell: (index) => {
      const column = index % ATLAS_COLUMNS;
      const row = Math.floor(index / ATLAS_COLUMNS);
      const u0 = column / ATLAS_COLUMNS;
      const v1 = 1 - row / ATLAS_ROWS;
      return [u0, v1 - 1 / ATLAS_ROWS, u0 + 1 / ATLAS_COLUMNS, v1];
    },
  };
}

/** Quad texturé à plat, UV dans une cellule de l'atlas. */
function labeled(
  sink: QuadSink,
  x0: number,
  x1: number,
  z0: number,
  z1: number,
  cell: [number, number, number, number],
  y = PAINT_Y + 0.002,
): void {
  addQuad(
    sink,
    [
      [x0, z0],
      [x1, z0],
      [x1, z1],
      [x0, z1],
    ],
    y,
    null,
    [
      [cell[0], cell[1]],
      [cell[2], cell[1]],
      [cell[2], cell[3]],
      [cell[0], cell[3]],
    ],
  );
}

export interface PitLaneBuild {
  meshes: number;
  triangles: number;
}

/** Petit maillage utilitaire : fusionne les boîtes d'un même matériau. */
function mergeBoxes(boxes: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  if (boxes.length === 0) return null;
  const merged = mergeGeometries(boxes);
  boxes.forEach((box) => box.dispose());
  return merged;
}

export function buildPitLaneDetail(scene: THREE.Scene, anisotropy: number): PitLaneBuild {
  let meshes = 0;
  let triangles = 0;
  const white = new THREE.Color(0xeceade);
  const yellow = new THREE.Color(0xe0b32a);

  // --- Marquage au sol -----------------------------------------------------
  const paint: QuadSink = { positions: [], indices: [], colors: [] };
  const laneMin = PIT_LANE_X - PIT_LANE_HALF;
  const laneMax = PIT_LANE_X + PIT_LANE_HALF;
  // Liserés de la voie : la largeur se lit à distance, même sans bordure.
  rect(paint, laneMin + 0.1, laneMin + 0.26, PIT_LANE_FROM + 7, PIT_LANE_TO - 7, white);
  rect(paint, laneMax - 0.26, laneMax - 0.1, PIT_LANE_FROM + 7, PIT_LANE_TO - 7, white);
  // Ligne jaune de la voie rapide, à l'intérieur du couloir de ravitaillement.
  rect(paint, laneMax - 1.55, laneMax - 1.39, PIT_LANE_FROM + 9, PIT_LANE_TO - 9, yellow);

  for (let stall = 0; stall < STALL_COUNT; stall++) {
    const centre = STALL_FIRST_Z + stall * STALL_PITCH;
    const z0 = centre - STALL_HALF_LENGTH;
    const z1 = centre + STALL_HALF_LENGTH;
    const x0 = laneMin + 0.4;
    const x1 = laneMax - 1.7;
    // Cadre de l'emplacement : trois traits, pas quatre (le quatrième est la voie).
    rect(paint, x1 - 0.08, x1 + 0.08, z0, z1, white);
    rect(paint, x0, x0 + 0.16, z0, z1, white);
    rect(paint, x0, x1, z0, z0 + 0.16, white);
    rect(paint, x0, x1, z1 - 0.16, z1, white);
    // Bande d'écurie au fond de l'emplacement, sur toute la longueur.
    const colour = new THREE.Color(TEAM_COLOURS[stall % TEAM_COLOURS.length]);
    rect(paint, x0 + 0.18, x0 + 1.05, z0 + 0.2, z1 - 0.2, colour);
  }

  // Entrée et sortie : deux biseaux peints, comme sur une vraie voie.
  const entry = [
    [laneMax, PIT_LANE_FROM + 16],
    [laneMax + 4.4, PIT_LANE_FROM + 2],
    [laneMax + 4.4, PIT_LANE_FROM + 10.5],
    [laneMax, PIT_LANE_FROM + 24],
  ] as [number, number][];
  addQuad(paint, entry, PAINT_Y - 0.002, white);
  const exit = [
    [laneMin, PIT_LANE_TO - 18],
    [laneMin - 4.2, PIT_LANE_TO - 3],
    [laneMin - 4.2, PIT_LANE_TO - 11],
    [laneMin, PIT_LANE_TO - 26],
  ] as [number, number][];
  addQuad(paint, exit, PAINT_Y - 0.002, white);

  if (paint.positions.length > 0) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(paint.positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(paint.colors!, 3));
    geometry.setIndex(paint.indices);
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.74,
        metalness: 0,
        polygonOffset: true,
        polygonOffsetFactor: -3,
        polygonOffsetUnits: -3,
      }),
    );
    mesh.receiveShadow = true;
    mesh.name = 'pit-paint';
    scene.add(mesh);
    meshes++;
    triangles += geometry.index!.count / 3;
  }

  // --- Numéros et inscriptions --------------------------------------------
  const atlas = textAtlas(anisotropy);
  const labels: QuadSink = { positions: [], indices: [], uvs: [] };
  for (let stall = 0; stall < STALL_COUNT; stall++) {
    const centre = STALL_FIRST_Z + stall * STALL_PITCH;
    labeled(
      labels,
      laneMin + 1.4,
      laneMin + 4.0,
      centre - 0.75,
      centre + 0.75,
      atlas.cell(stall),
    );
  }
  // Limitation à 60 km/h, à l'entrée et à la sortie, et rappel « PIT ».
  labeled(labels, laneMin + 1.2, laneMin + 4.4, PIT_LANE_FROM + 22, PIT_LANE_FROM + 24.6, atlas.cell(8));
  labeled(labels, laneMin + 1.2, laneMin + 4.4, PIT_LANE_TO - 24.4, PIT_LANE_TO - 21.8, atlas.cell(8));
  labeled(labels, laneMin + 1.2, laneMin + 4.2, PIT_LANE_FROM + 34, PIT_LANE_FROM + 36.4, atlas.cell(9));
  if (labels.positions.length > 0) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(labels.positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(labels.uvs!, 2));
    geometry.setIndex(labels.indices);
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({
        map: atlas.texture,
        transparent: true,
        depthWrite: false,
        roughness: 0.8,
        polygonOffset: true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -4,
      }),
    );
    mesh.receiveShadow = true;
    mesh.name = 'pit-labels';
    scene.add(mesh);
    meshes++;
    triangles += geometry.index!.count / 3;
  }

  // --- Pneus et chariots, par emplacement --------------------------------
  const tyreGeometry = new THREE.CylinderGeometry(0.4, 0.4, 0.3, 12);
  const tyres = new THREE.InstancedMesh(
    tyreGeometry,
    new THREE.MeshStandardMaterial({ color: 0x1b1c1f, roughness: 0.96 }),
    STALL_COUNT * 6,
  );
  const trolleys = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.95, 0.78, 1.55),
    new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.15 }),
    STALL_COUNT,
  );
  const matrix = new THREE.Matrix4();
  const colour = new THREE.Color();
  let tyre = 0;
  for (let stall = 0; stall < STALL_COUNT; stall++) {
    const centre = STALL_FIRST_Z + stall * STALL_PITCH;
    for (const side of [-1, 1]) {
      for (let level = 0; level < 3; level++) {
        matrix.makeTranslation(laneMin + 0.9, 0.19 + level * 0.32, centre + side * 3.5);
        tyres.setMatrixAt(tyre++, matrix);
      }
    }
    matrix.makeTranslation(laneMin + 2.1, 0.39, centre + 2.4);
    trolleys.setMatrixAt(stall, matrix);
    trolleys.setColorAt(stall, colour.set(TEAM_COLOURS[stall % TEAM_COLOURS.length]));
  }
  tyres.count = tyre;
  tyres.castShadow = false;
  tyres.receiveShadow = true;
  scene.add(tyres);
  trolleys.castShadow = true;
  trolleys.receiveShadow = true;
  scene.add(trolleys);
  meshes += 2;
  triangles += tyre * 48 + STALL_COUNT * 12;

  // --- Rail du muret de stands -------------------------------------------
  // Le rail se monte sur la face *stands* du muret : c'est de ce côté que se
  // tiennent les commissaires, face aux garages.
  const railX = PIT_WALL_OUTER - 0.2;
  const railParts: THREE.BufferGeometry[] = [];
  for (const y of [1.22, 1.56, 1.9]) {
    const rail = new THREE.BoxGeometry(0.07, 0.07, 208);
    rail.translate(railX, y, -404);
    railParts.push(rail);
  }
  for (let z = -498; z <= -310; z += 3.4) {
    const post = new THREE.BoxGeometry(0.06, 0.9, 0.06);
    post.translate(railX, 1.5, z);
    railParts.push(post);
  }
  // Poste de chronométrage, posé sur le muret, avec ses écrans et son mât.
  for (const z of [-434, -398]) {
    const leg = new THREE.BoxGeometry(0.08, 1.2, 0.08);
    leg.translate(railX, 1.5, z);
    railParts.push(leg);
  }
  const desk = new THREE.BoxGeometry(1.35, 0.95, 5.6);
  desk.translate(railX, 1.75, -416);
  railParts.push(desk);
  const canopy = new THREE.BoxGeometry(2.1, 0.09, 6.4);
  canopy.translate(railX - 0.3, 3.15, -416);
  railParts.push(canopy);
  for (const z of [-418.6, -413.4]) {
    const canopyPost = new THREE.BoxGeometry(0.07, 1.55, 0.07);
    canopyPost.translate(railX - 1.2, 2.35, z);
    railParts.push(canopyPost);
  }
  const mast = new THREE.CylinderGeometry(0.05, 0.05, 2.6, 8);
  mast.translate(railX - 1.1, 2.2, -418);
  railParts.push(mast);
  const railMesh = mergeBoxes(railParts);
  if (railMesh) {
    const mesh = new THREE.Mesh(
      railMesh,
      new THREE.MeshStandardMaterial({ color: 0x9aa0a8, roughness: 0.45, metalness: 0.6 }),
    );
    mesh.receiveShadow = true;
    mesh.name = 'pit-rail';
    scene.add(mesh);
    meshes++;
    triangles += railMesh.index ? railMesh.index.count / 3 : 0;
  }

  // Trois moniteurs face à la piste, sous l'auvent.
  const screens: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 3; i++) {
    const screen = new THREE.PlaneGeometry(1.15, 0.66);
    screen.rotateY(Math.PI / 2);
    screen.translate(railX - 0.66, 2.15 + (i === 1 ? 0.05 : 0), -418.4 + i * 2.4);
    screens.push(screen);
  }
  const screenMesh = mergeGeometries(screens);
  screens.forEach((screen) => screen.dispose());
  if (screenMesh) {
    const mesh = new THREE.Mesh(
      screenMesh,
      new THREE.MeshBasicMaterial({ color: 0x7fd8ff }),
    );
    mesh.name = 'pit-screens';
    scene.add(mesh);
    meshes++;
    triangles += screenMesh.index ? screenMesh.index.count / 3 : 0;
  }

  return { meshes, triangles };
}
