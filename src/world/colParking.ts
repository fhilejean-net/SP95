import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { EnvironmentMaterials } from '../render/materials.ts';

/**
 * Les deux parkings du col sont les polygones OSM 76238299 (ouest) et 76836658
 * (haut), séparés par la Route de Fauchy. On y trace les rangées de places de
 * la référence, en épis le long des grands côtés, et on laisse le terre-plein
 * central libre pour manœuvrer.
 */

export type ParkingPoint = [number, number];

export interface ParkingLine {
  a: ParkingPoint;
  b: ParkingPoint;
}

export interface ParkingPlan {
  /** Séparateurs de places, du bord de la dalle vers le terre-plein. */
  bays: ParkingLine[];
  /** Liseré blanc qui ferme la dalle. */
  border: ParkingLine[];
}

/** Pas des places le long du bord, en mètres. */
const BAY_SPACING = 3;
/** Longueur peinte d'une place, en mètres. */
const BAY_LENGTH = 5;
/** Les épis sont inclinés de 58° par rapport au bord. */
const BAY_ANGLE = (58 * Math.PI) / 180;
/** Retrait du trait par rapport au bord de la dalle. */
const BAY_INSET = 0.6;
/** On ne trace pas de place collée aux extrémités de chaque rangée. */
const ROW_MARGIN = 1.2;
/** Épaisseur des traits. */
const BAY_WIDTH = 0.12;
const BORDER_WIDTH = 0.1;
/** Les traits reposent 1,8 cm au-dessus de la dalle. */
const PAINT_LIFT = 0.018;

function cleanOutline(outline: ParkingPoint[]): ParkingPoint[] {
  const points: ParkingPoint[] = [];
  for (const [x, z] of outline) {
    const previous = points[points.length - 1];
    if (previous && Math.hypot(x - previous[0], z - previous[1]) < 0.05) continue;
    points.push([x, z]);
  }
  if (points.length > 2) {
    const first = points[0];
    const last = points[points.length - 1];
    if (Math.hypot(first[0] - last[0], first[1] - last[1]) < 0.05) points.pop();
  }
  return points;
}

function centroid(points: ParkingPoint[]): ParkingPoint {
  let x = 0;
  let z = 0;
  for (const point of points) {
    x += point[0];
    z += point[1];
  }
  return [x / points.length, z / points.length];
}

function pointInside(points: ParkingPoint[], [x, z]: ParkingPoint): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [ax, az] = points[i];
    const [bx, bz] = points[j];
    if (az > z !== bz > z && x < ((bx - ax) * (z - az)) / (bz - az) + ax) inside = !inside;
  }
  return inside;
}

/** Trace une rangée d'épis le long d'une ligne brisée, vers l'intérieur. */
function planRow(
  path: ParkingPoint[],
  outline: ParkingPoint[],
  interior: ParkingPoint,
  bays: ParkingLine[],
): void {
  const segments: number[] = [];
  let total = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const length = Math.hypot(path[i + 1][0] - path[i][0], path[i + 1][1] - path[i][1]);
    segments.push(length);
    total += length;
  }
  if (total < ROW_MARGIN * 2 + 1) return;

  const cos = Math.cos(BAY_ANGLE);
  const sin = Math.sin(BAY_ANGLE);
  for (let s = ROW_MARGIN; s <= total - ROW_MARGIN; s += BAY_SPACING) {
    let distance = s;
    let index = 0;
    while (index < segments.length - 1 && distance > segments[index]) {
      distance -= segments[index];
      index++;
    }
    const [ax, az] = path[index];
    const [bx, bz] = path[index + 1];
    const length = segments[index] || 1;
    const tx = (bx - ax) / length;
    const tz = (bz - az) / length;
    const px = ax + tx * distance;
    const pz = az + tz * distance;

    // Normale orientée vers le centre de la dalle, donc vers le terre-plein.
    let nx = -tz;
    let nz = tx;
    if ((interior[0] - px) * nx + (interior[1] - pz) * nz < 0) {
      nx = -nx;
      nz = -nz;
    }

    const base: ParkingPoint = [px + nx * BAY_INSET, pz + nz * BAY_INSET];
    const directionX = tx * cos + nx * sin;
    const directionZ = tz * cos + nz * sin;
    const tip: ParkingPoint = [
      base[0] + directionX * BAY_LENGTH,
      base[1] + directionZ * BAY_LENGTH,
    ];
    // Près des pointes, un épi incliné peut sortir de la dalle : on l'omet.
    if (!pointInside(outline, base) || !pointInside(outline, tip)) continue;
    bays.push({ a: base, b: tip });
  }
}

/** Calcule les traits du parking sans toucher à la scène. */
export function planColParking(outline: ParkingPoint[]): ParkingPlan {
  const points = cleanOutline(outline);
  const plan: ParkingPlan = { bays: [], border: [] };
  if (points.length < 3) return plan;

  for (let i = 0; i < points.length; i++) {
    plan.border.push({ a: points[i], b: points[(i + 1) % points.length] });
  }

  const interior = centroid(points);
  let longest = 0;
  let longestLength = 0;
  for (let i = 0; i < points.length; i++) {
    const [ax, az] = points[i];
    const [bx, bz] = points[(i + 1) % points.length];
    const length = Math.hypot(bx - ax, bz - az);
    if (length > longestLength) {
      longest = i;
      longestLength = length;
    }
  }

  // Rangée du bord de route, sur le plus grand côté.
  planRow([points[longest], points[(longest + 1) % points.length]], points, interior, plan.bays);

  // Rangée opposée : le reste du pourtour, sans les deux accès d'extrémité.
  const farSide: ParkingPoint[] = [];
  for (let i = (longest + 2) % points.length; i !== longest; i = (i + 1) % points.length) {
    farSide.push(points[i]);
  }
  farSide.push(points[(longest + points.length - 1) % points.length]);
  if (farSide.length >= 2) planRow(farSide, points, interior, plan.bays);

  return plan;
}

/**
 * Bande peinte posée sur la dalle, entre deux points du plan. Elle est
 * découpée tous les 3 m pour épouser les plis des grands triangles.
 */
function ribbon(
  line: ParkingLine,
  width: number,
  surface: (x: number, z: number) => number,
): THREE.BufferGeometry | null {
  const [ax, az] = line.a;
  const [bx, bz] = line.b;
  const dx = bx - ax;
  const dz = bz - az;
  const length = Math.hypot(dx, dz);
  if (length < 0.05) return null;
  const nx = (-dz / length) * (width / 2);
  const nz = (dx / length) * (width / 2);
  const steps = Math.max(1, Math.ceil(length / 3));
  const positions: number[] = [];
  const indices: number[] = [];

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const cx = ax + dx * t;
    const cz = az + dz * t;
    const y = surface(cx, cz) + PAINT_LIFT;
    positions.push(cx + nx, y, cz + nz, cx - nx, y, cz - nz);
    if (i > 0) {
      const base = (i - 1) * 2;
      indices.push(base, base + 2, base + 1, base + 2, base + 3, base + 1);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/** Pose les traits d'un parking sur sa dalle et retourne le nombre de places. */
export function buildColParking(
  scene: THREE.Scene,
  mats: EnvironmentMaterials,
  outline: ParkingPoint[],
  surface: (x: number, z: number) => number,
  name = 'col-parking',
): number {
  const plan = planColParking(outline);

  const bayGeometries = plan.bays
    .map((line) => ribbon(line, BAY_WIDTH, surface))
    .filter((geometry): geometry is THREE.BufferGeometry => geometry !== null);
  if (bayGeometries.length > 0) {
    const merged = mergeGeometries(bayGeometries);
    if (merged) {
      const bays = new THREE.Mesh(merged, mats.lines);
      bays.name = `${name}-bays`;
      scene.add(bays);
    }
    for (const geometry of bayGeometries) geometry.dispose();
  }

  const borderGeometries = plan.border
    .map((line) => ribbon(line, BORDER_WIDTH, surface))
    .filter((geometry): geometry is THREE.BufferGeometry => geometry !== null);
  if (borderGeometries.length > 0) {
    const merged = mergeGeometries(borderGeometries);
    if (merged) {
      const border = new THREE.Mesh(merged, mats.lines);
      border.name = `${name}-border`;
      scene.add(border);
    }
    for (const geometry of borderGeometries) geometry.dispose();
  }

  return plan.bays.length;
}
