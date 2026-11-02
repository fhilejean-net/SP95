import * as THREE from 'three';
import type { ParkingPoint } from './colParking.ts';

export interface ParkingPadOptions {
  lift?: number;
  /** Nombre de découpages : chaque triangle devient quatre. */
  subdivisions?: number;
}

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

/**
 * Les polygones OSM ne sont pas tous orientés pareil. On force les triangles
 * à regarder vers le ciel, sinon une dalle entière disparaît vue de dessus.
 */
function faceUp(positions: number[], indices: number[]): void {
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i], b = indices[i + 1], c = indices[i + 2];
    const ux = positions[b * 3] - positions[a * 3];
    const uz = positions[b * 3 + 2] - positions[a * 3 + 2];
    const vx = positions[c * 3] - positions[a * 3];
    const vz = positions[c * 3 + 2] - positions[a * 3 + 2];
    if (uz * vx - ux * vz < 0) {
      indices[i + 1] = c;
      indices[i + 2] = b;
    }
  }
}

function buildGeometry(positions: number[], indices: number[], ground: (x: number, z: number) => number, lift: number): THREE.BufferGeometry {
  const vertices = new Float32Array(positions.length);
  const uvs = new Float32Array((positions.length / 3) * 2);
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const z = positions[i + 2];
    vertices[i] = x;
    vertices[i + 1] = ground(x, z) + lift;
    vertices[i + 2] = z;
    uvs[(i / 3) * 2] = x / 10;
    uvs[(i / 3) * 2 + 1] = z / 10;
  }
  faceUp(positions, indices);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Dalle posée sur le terrain. Le polygone OSM n'a que des sommets sur son
 * pourtour : triangulé tel quel, il passe sous les bosses du pré et l'herbe
 * ressort au milieu de l'asphalte. On découpe donc chaque triangle en quatre
 * assez de fois pour que la dalle suive le relief entre ses bords.
 */
export function parkingPadGeometry(
  outline: ParkingPoint[],
  ground: (x: number, z: number) => number,
  options: ParkingPadOptions = {},
): THREE.BufferGeometry {
  const points = cleanOutline(outline);
  if (points.length < 3) return new THREE.BufferGeometry();
  const lift = options.lift ?? 0.04;
  const rounds = options.subdivisions ?? 6;
  const shape = new THREE.Shape();
  points.forEach(([x, z], i) => i === 0 ? shape.moveTo(x, -z) : shape.lineTo(x, -z));
  const base = new THREE.ShapeGeometry(shape);
  base.applyMatrix4(new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1));
  const source = base.getAttribute('position');
  const positions: number[] = [];
  for (let i = 0; i < source.count; i++) positions.push(source.getX(i), 0, source.getZ(i));
  const sourceIndex = base.getIndex();
  let indices: number[] = sourceIndex
    ? Array.from(sourceIndex.array)
    : positions.map((_, i) => i);
  base.dispose();

  const valid: number[] = [];
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i], b = indices[i + 1], c = indices[i + 2];
    const area = (positions[b * 3] - positions[a * 3]) * (positions[c * 3 + 2] - positions[a * 3 + 2])
      - (positions[c * 3] - positions[a * 3]) * (positions[b * 3 + 2] - positions[a * 3 + 2]);
    if (Math.abs(area) > 1e-6) valid.push(a, b, c);
  }
  indices = valid;

  for (let round = 0; round < rounds; round++) {
    const midpoints = new Map<string, number>();
    const midpoint = (a: number, b: number): number => {
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      const cached = midpoints.get(key);
      if (cached !== undefined) return cached;
      const index = positions.length / 3;
      positions.push(
        (positions[a * 3] + positions[b * 3]) / 2,
        0,
        (positions[a * 3 + 2] + positions[b * 3 + 2]) / 2,
      );
      midpoints.set(key, index);
      return index;
    };
    const next: number[] = [];
    for (let i = 0; i < indices.length; i += 3) {
      const a = indices[i], b = indices[i + 1], c = indices[i + 2];
      const ab = midpoint(a, b), bc = midpoint(b, c), ca = midpoint(c, a);
      next.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca);
    }
    indices = next;
  }

  return buildGeometry(positions, indices, ground, lift);
}

/** Rééchantillonne une ligne tous les `step` mètres, extrémités comprises. */
function resample(points: ParkingPoint[], step: number): ParkingPoint[] {
  const result: ParkingPoint[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const [ax, az] = points[i - 1];
    const [bx, bz] = points[i];
    const length = Math.hypot(bx - ax, bz - az);
    if (length < 0.01) continue;
    const count = Math.max(1, Math.ceil(length / step));
    for (let k = 1; k <= count; k++) {
      const t = k / count;
      result.push([ax + (bx - ax) * t, az + (bz - az) * t]);
    }
  }
  return result;
}

/**
 * Bande d'asphalte qui relie la route à une dalle. Elle est elle aussi
 * rééchantillonnée en travers pour ne pas laisser passer l'herbe sur les
 * bosses du bas-côté.
 */
export function parkingAccessGeometry(
  points: ParkingPoint[],
  ground: (x: number, z: number) => number,
  width: number,
  lift: number,
): THREE.BufferGeometry {
  const line = cleanOutline(points);
  if (line.length < 2) return new THREE.BufferGeometry();
  const sections = resample(line, 1.5);
  const columns = 6;
  const positions: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i < sections.length; i++) {
    const previous = sections[Math.max(0, i - 1)];
    const next = sections[Math.min(sections.length - 1, i + 1)];
    const dx = next[0] - previous[0];
    const dz = next[1] - previous[1];
    const length = Math.hypot(dx, dz) || 1;
    const nx = -dz / length;
    const nz = dx / length;
    const [x, z] = sections[i];
    for (let j = 0; j <= columns; j++) {
      const offset = (j / columns - 0.5) * width;
      positions.push(x + nx * offset, 0, z + nz * offset);
    }
    if (i > 0) {
      const row = columns + 1;
      for (let j = 0; j < columns; j++) {
        const a = (i - 1) * row + j;
        const b = a + 1;
        const c = i * row + j;
        const d = c + 1;
        indices.push(a, c, b, b, c, d);
      }
    }
  }
  return buildGeometry(positions, indices, ground, lift);
}
