import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL('../public/data/mollendruz/', import.meta.url);
const header = JSON.parse(readFileSync(new URL('terrain.json', root), 'utf8')) as {
  bounds: number[]; chunkSize: number; heightOffset: number; heightScale: number;
  chunks: { x: number; z: number; width: number; depth: number; nx: number; nz: number; offset: number; bytes: number }[];
};
const route = JSON.parse(readFileSync(new URL('centerline.json', root), 'utf8')) as {
  samples: { x: number; y: number; z: number; width: number; bank: number }[];
};
const bytes = readFileSync(new URL('terrain_chunks.bin', root));
const [x0, z0] = header.bounds;
const cells = new Map(header.chunks.map((c) => [
  `${Math.round((c.x - x0) / header.chunkSize)},${Math.round((c.z - z0) / header.chunkSize)}`, c,
]));

function terrainAt(x: number, z: number): number {
  const c = cells.get(`${Math.floor((x - x0) / header.chunkSize)},${Math.floor((z - z0) / header.chunkSize)}`);
  assert.ok(c, 'la route doit rester dans le terrain');
  const fx = Math.min(c.nx - 0.000001, Math.max(0, (x - c.x) / c.width * c.nx));
  const fz = Math.min(c.nz - 0.000001, Math.max(0, (z - c.z) / c.depth * c.nz));
  const ix = Math.floor(fx), iz = Math.floor(fz), tx = fx - ix, tz = fz - iz;
  const h = (x: number, z: number) => header.heightOffset + header.heightScale * bytes.readUInt16LE(c.offset + 2 * (z * (c.nx + 1) + x));
  const h00 = h(ix, iz), h10 = h(ix + 1, iz), h01 = h(ix, iz + 1), h11 = h(ix + 1, iz + 1);
  return tx + tz <= 1 ? h00 + tx * (h10 - h00) + tz * (h01 - h00)
    : h11 + (1 - tx) * (h01 - h11) + (1 - tz) * (h10 - h11);
}

test('les blocs de terrain respectent le format 16 bits et la précision annoncée', () => {
  assert.equal(header.heightScale, 0.02);
  for (const c of header.chunks) {
    assert.equal(c.bytes, (c.nx + 1) * (c.nz + 1) * 2);
    assert.ok(c.offset >= 0 && c.offset + c.bytes <= bytes.length);
  }
});

test('le terrain reste sous la chaussée relevée, y compris sur ses bords', () => {
  const points = route.samples;
  for (let i = 0; i < points.length; i++) {
    const p = points[i], a = points[Math.max(0, i - 1)], b = points[Math.min(points.length - 1, i + 1)];
    const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz);
    assert.ok(len > 0);
    for (const side of [-1, 0, 1]) {
      const d = side * p.width / 2;
      const terrain = terrainAt(p.x - dz / len * d, p.z + dx / len * d);
      const road = p.y + p.bank * d + 0.04;
      assert.ok(terrain < road, `terrain au-dessus de la route à l'échantillon ${i}, côté ${side}`);
    }
  }
});
