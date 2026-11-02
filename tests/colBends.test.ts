import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  BAND_MAX_M,
  LAYBY_RADIUS_M,
  LAYBY_WIDTH_M,
  findBends,
  offsetPoint,
  planBendBands,
  planLaybys,
  stationAt,
  type BendPoint,
} from '../src/world/colBends.ts';

const route = JSON.parse(
  readFileSync(new URL('../public/data/mollendruz/centerline.json', import.meta.url), 'utf8'),
) as { samples: BendPoint[] };
const points = route.samples.filter((point) => point.s >= 0);

function distanceToRoute(x: number, z: number): number {
  let best = Infinity;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const length2 = dx * dx + dz * dz;
    if (length2 < 1e-9) continue;
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / length2));
    best = Math.min(best, Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t)));
  }
  return best;
}

test('les virages serrés se lisent sur le rayon du tracé', () => {
  const bends = findBends(points);
  assert.ok(bends.length >= 5, `seulement ${bends.length} virages`);
  const tightest = bends.reduce((best, bend) => (bend.radius < best.radius ? bend : best), bends[0]);
  // L'épingle du bas du col : 88 m de développement, rayon d'une douzaine de mètres.
  assert.ok(tightest.radius < 15, `rayon mini ${tightest.radius.toFixed(1)} m`);
  assert.ok(Math.abs(tightest.apexS - 4548) < 15, `point de corde à ${tightest.apexS} m`);
  for (const bend of bends) {
    assert.ok(bend.radius <= 45.5, 'aucun virage large dans la liste');
    assert.ok(bend.endS > bend.startS);
    assert.ok(bend.apexS >= bend.startS && bend.apexS <= bend.endS);
    assert.ok(bend.turn === 1 || bend.turn === -1);
  }
});

test('les bandes naissent courtes et prennent une demi-voie au point de corde', () => {
  const bands = planBendBands(points, findBends(points));
  assert.ok(bands.length > 40, `seulement ${bands.length} bandes`);
  let longest = 0;
  for (const band of bands) {
    const station = stationAt(points, band.s);
    const length = Math.abs(band.to - band.from);
    longest = Math.max(longest, length);
    assert.ok(length >= 0.2, 'une bande ne disparaît pas');
    assert.ok(length <= BAND_MAX_M + 0.01, `bande de ${length.toFixed(2)} m`);
    // Le pied touche le trait d'axe, la pointe reste dans la voie intérieure.
    assert.ok(Math.abs(band.from) <= 0.2, 'pied sur le trait d\'axe');
    assert.ok(Math.abs(band.to) <= station.width / 2, 'pointe dans la voie');
    assert.ok(Math.sign(band.from) === Math.sign(band.to), 'la bande reste de son côté');
    const [x, z] = offsetPoint(station, band.to);
    assert.ok(distanceToRoute(x, z) < station.width / 2, 'pointe sur la chaussée');
  }
  assert.ok(longest > BAND_MAX_M * 0.9, 'au moins une bande atteint la demi-voie');
});

test('les places d’évitement tiennent dans l’intérieur des virages les plus serrés', () => {
  const bends = findBends(points);
  const laybys = planLaybys(points, bends);
  const eligible = bends.filter((bend) => bend.radius <= LAYBY_RADIUS_M);
  assert.equal(laybys.length, eligible.length);
  assert.ok(laybys.length >= 2, `seulement ${laybys.length} évitements`);
  for (const layby of laybys) {
    assert.ok(layby.outline.length >= 20, 'contour découpé finement');
    for (const [x, z] of layby.outline) {
      const distance = distanceToRoute(x, z);
      // Le contour reste collé à la rive et ne dépasse jamais la largeur prévue.
      assert.ok(distance <= 3.3 + LAYBY_WIDTH_M + 0.4, `point à ${distance.toFixed(1)} m de l'axe`);
    }
    // Le côté de l'évitement est celui de l'intérieur du virage.
    const station = stationAt(points, layby.bend.apexS);
    const inner = offsetPoint(station, layby.bend.turn * (station.width / 2 + LAYBY_WIDTH_M / 2));
    const innerDistance = Math.min(...layby.outline.map(([x, z]) => Math.hypot(x - inner[0], z - inner[1])));
    assert.ok(innerDistance < 2.5, 'la place est du côté intérieur du virage');
  }
});
