/**
 * Surface roulable de la piste : le collider garde la topologie du modèle et ses
 * cotes sont lissées. Les deux propriétés ont manqué tour à tour — une trame
 * régulière laissait des trous dans le collider, et c'est par un trou que la
 * voiture tombait sous la piste au départ des stands.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { buildFlatRoad } from '../src/world/circuit.ts';

/** Une dalle : des colonnes de sommets espacées, comme les carreaux du modèle. */
function slab(xs: number[], zs: number[], height: (x: number, z: number) => number): THREE.Mesh {
  const positions: number[] = [];
  for (const z of zs) {
    for (const x of xs) positions.push(x, height(x, z), z);
  }
  const index: number[] = [];
  const columns = xs.length;
  for (let row = 0; row < zs.length - 1; row++) {
    for (let column = 0; column < columns - 1; column++) {
      const a = row * columns + column;
      const b = a + 1;
      const c = a + columns;
      const d = c + 1;
      index.push(a, c, b, b, c, d);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(index);
  return new THREE.Mesh(geometry);
}

/** Aire couverte au sol par le collider, en m². */
function area(vertices: Float32Array, indices: Uint32Array): number {
  let total = 0;
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const a = indices[i] * 3;
    const b = indices[i + 1] * 3;
    const c = indices[i + 2] * 3;
    total +=
      Math.abs(
        (vertices[b] - vertices[a]) * (vertices[c + 2] - vertices[a + 2]) -
          (vertices[c] - vertices[a]) * (vertices[b + 2] - vertices[a + 2]),
      ) / 2;
  }
  return total;
}

/** Pente de la plus forte arête d'un maillage, en pourcentage. */
function rawGrade(mesh: THREE.Mesh): number {
  const positions = mesh.geometry.attributes.position;
  const index = mesh.geometry.index;
  if (!index) return 0;
  let worst = 0;
  for (let i = 0; i < index.count; i += 3) {
    for (let edge = 0; edge < 3; edge++) {
      const first = index.getX(i + edge);
      const second = index.getX(i + ((edge + 1) % 3));
      const run = Math.hypot(
        positions.getX(first) - positions.getX(second),
        positions.getZ(first) - positions.getZ(second),
      );
      if (run < 0.05) continue;
      const grade = (Math.abs(positions.getY(first) - positions.getY(second)) / run) * 100;
      if (grade > worst) worst = grade;
    }
  }
  return worst;
}

test('une longue dalle garde tous ses triangles : aucun trou sous la roue', () => {
  // Trente mètres sur douze, quatre sommets : aucune case intermédiaire. C'est
  // exactement le carreau sur lequel la trame régulière laissait un trou, et la
  // voiture tombait sous la piste.
  const road = buildFlatRoad([slab([0, 30], [0, 12], () => 4)]);
  assert.equal(road.triangles, 2, 'les deux triangles du carreau sont dans le collider');
  assert.ok(Math.abs(area(road.vertices, road.indices) - 360) < 1e-3, 'toute la dalle est couverte');
  assert.equal(road.maxGrade, 0);
});

test('le collider suit la topologie du modèle, triangle par triangle', () => {
  const road = buildFlatRoad([slab([0, 10, 20], [0, 8], () => 1)]);
  assert.equal(road.triangles, 4);
  assert.ok(Math.abs(area(road.vertices, road.indices) - 160) < 1e-3);
});

test('les vibreurs sont moyennés : la voiture ne saute plus dessus', () => {
  const xs = Array.from({ length: 21 }, (_, i) => i * 2);
  // Une marche de 30 cm tous les deux mètres : 15 % de pente brute.
  const kerb = slab(xs, [0, 12], (x) => (x % 4 === 0 ? 0.15 : -0.15));
  const grade = rawGrade(kerb);
  assert.ok(grade > 14, `pente brute ${grade.toFixed(1)} %`);
  const road = buildFlatRoad([kerb]);
  assert.ok(road.maxGrade < grade * 0.5, `pente lissée ${road.maxGrade.toFixed(1)} %`);
});

test('la montée du tour traverse le lissage', () => {
  // 6 % sur vingt mètres, sommets espacés : le lissage ne doit pas l'aplatir.
  const road = buildFlatRoad([slab([0, 20, 40], [0, 12], (x) => x * 0.06)]);
  assert.ok(Math.abs(road.maxGrade - 6) < 0.5, `pente ${road.maxGrade.toFixed(2)} %`);
});

test('les deux tabliers du croisement en huit gardent chacun leur cote', () => {
  const below = slab([0, 30], [0, 12], () => 0);
  const above = slab([0, 30], [0, 12], () => 8);
  const road = buildFlatRoad([below, above]);
  const heights = new Set<number>();
  for (let i = 1; i < road.vertices.length; i += 3) {
    heights.add(Math.round(road.vertices[i] * 100) / 100);
  }
  assert.deepEqual([...heights].sort((a, b) => a - b), [0, 8]);
});

test('deux primitives voisines se raccordent sans marche', () => {
  const bump = (x: number) => (x % 4 === 0 ? 0.15 : -0.15);
  const left = slab([0, 2, 4, 6, 8, 10], [0, 12], bump);
  const right = slab([10, 12, 14, 16, 18, 20], [0, 12], bump);
  const road = buildFlatRoad([left, right]);
  // La couture est à x = 10 : les deux maillages y posent chacun deux sommets,
  // qui doivent recevoir la même cote — sinon la roue bute sur une marche.
  const seam: number[] = [];
  for (let i = 0; i < road.vertices.length; i += 3) {
    if (Math.abs(road.vertices[i] - 10) < 1e-4) seam.push(road.vertices[i + 1]);
  }
  assert.equal(seam.length, 4, 'deux sommets par rangée sur la couture');
  const spread = Math.max(...seam) - Math.min(...seam);
  assert.ok(spread < 1e-5, `écart de cote à la couture : ${spread}`);
});
