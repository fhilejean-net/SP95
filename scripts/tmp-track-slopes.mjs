/**
 * Pentes de la trame de collision, trous de couverture et vues depuis la piste.
 *
 *   node scripts/tmp-track-slopes.mjs
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.setDefaultTimeout(300_000);
page.on('pageerror', (error) => console.log(`pageerror: ${error.message}`));
page.on('console', (message) => {
  const text = message.text();
  if (/Circuit|Piste|Terrain/.test(text)) console.log(`log: ${text}`);
});

await page.goto('http://127.0.0.1:3000/?map=suzuka&fx=low', { waitUntil: 'load' });
await page.waitForFunction(() => window.__sp95?.ready === true, null, { timeout: 300_000 });
await page.evaluate(() => window.__sp95.startFree());
await page.waitForTimeout(800);

const report = await page.evaluate(() => {
  const THREE = window.__sp95three.THREE;
  const c = window.__sp95Circuit;
  const road = c.flatRoad;
  const verts = road.vertices;
  const idx = road.indices;
  const triangles = [];
  for (let t = 0; t < road.triangles; t++) {
    const ia = idx[t * 3];
    const ib = idx[t * 3 + 1];
    const ic = idx[t * 3 + 2];
    const a = [verts[ia * 3], verts[ia * 3 + 1], verts[ia * 3 + 2]];
    const b = [verts[ib * 3], verts[ib * 3 + 1], verts[ib * 3 + 2]];
    const d = [verts[ic * 3], verts[ic * 3 + 1], verts[ic * 3 + 2]];
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ac = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
    const nx = ab[1] * ac[2] - ab[2] * ac[1];
    const ny = ab[2] * ac[0] - ab[0] * ac[2];
    const nz = ab[0] * ac[1] - ab[1] * ac[0];
    const len = Math.hypot(nx, ny, nz) || 1;
    const slope = Math.abs(ny / len);
    const cx = (a[0] + b[0] + d[0]) / 3;
    const cz = (a[2] + b[2] + d[2]) / 3;
    const cy = (a[1] + b[1] + d[1]) / 3;
    triangles.push({ slope, cx, cz, cy, y: [a[1], b[1], d[1]], span: Math.max(a[1], b[1], d[1]) - Math.min(a[1], b[1], d[1]) });
  }
  // Pente = dénivelé / horizontale ; 100 % = 45°. On trie par pire.
  triangles.sort((p, q) => p.slope - q.slope);
  const worst = triangles.slice(0, 12).map((entry) => ({
    grade: +((1 / Math.max(0.01, entry.slope) - 0) * 0).toFixed(0),
    slopeDeg: +((Math.acos(Math.min(1, entry.slope)) * 180) / Math.PI).toFixed(1),
    gradePct: +(Math.tan(Math.acos(Math.min(1, entry.slope))) * 100).toFixed(0),
    at: [+entry.cx.toFixed(1), +entry.cy.toFixed(1), +entry.cz.toFixed(1)],
    heights: entry.y.map((v) => +v.toFixed(2)),
    span: +(Math.max(...entry.y) - Math.min(...entry.y)).toFixed(2),
  }));

  // Distribution : combien de triangles au-delà de 10 / 20 / 50 % de pente.
  const grades = triangles.map((entry) => Math.tan(Math.acos(Math.min(1, entry.slope))) * 100);
  const over = (limit) => grades.filter((grade) => grade > limit).length;

  // Couverture : chaque triangle d'asphalte visible doit avoir un triangle de
  // collision sous lui. On échantillonne les centres des triangles de la piste
  // et on regarde si un triangle de collision les couvre à moins de 0,6 m.
  const CELL = 6;
  const buckets = new Map();
  const keyOf = (x, z) => `${Math.floor(x / CELL)}:${Math.floor(z / CELL)}`;
  const triStore = [];
  for (let t = 0; t < road.triangles; t++) {
    const ia = idx[t * 3];
    const ib = idx[t * 3 + 1];
    const ic = idx[t * 3 + 2];
    const tri = {
      a: [verts[ia * 3], verts[ia * 3 + 1], verts[ia * 3 + 2]],
      b: [verts[ib * 3], verts[ib * 3 + 1], verts[ib * 3 + 2]],
      d: [verts[ic * 3], verts[ic * 3 + 1], verts[ic * 3 + 2]],
    };
    triStore.push(tri);
    const minX = Math.min(tri.a[0], tri.b[0], tri.d[0]);
    const maxX = Math.max(tri.a[0], tri.b[0], tri.d[0]);
    const minZ = Math.min(tri.a[2], tri.b[2], tri.d[2]);
    const maxZ = Math.max(tri.a[2], tri.b[2], tri.d[2]);
    for (let gx = Math.floor(minX / CELL); gx <= Math.floor(maxX / CELL); gx++) {
      for (let gz = Math.floor(minZ / CELL); gz <= Math.floor(maxZ / CELL); gz++) {
        const key = `${gx}:${gz}`;
        const list = buckets.get(key);
        if (list) list.push(tri);
        else buckets.set(key, [tri]);
      }
    }
  }
  const cover = (x, z) => {
    const list = buckets.get(keyOf(x, z));
    if (!list) return null;
    for (const tri of list) {
      const denom =
        (tri.b[2] - tri.d[2]) * (tri.b[0] - tri.a[0]) - (tri.b[0] - tri.d[0]) * (tri.b[2] - tri.a[2]);
      if (Math.abs(denom) < 1e-9) continue;
      const alpha = ((z - tri.b[2]) * (tri.b[0] - tri.a[0]) - (x - tri.a[0]) * (tri.b[0] - tri.d[0])) / denom;
      const beta = ((tri.d[2] - tri.b[2]) * (x - tri.a[0]) - (tri.d[0] - tri.a[0]) * (z - tri.b[2])) / denom;
      if (alpha < -1e-4 || beta < -1e-4 || alpha + beta > 1 + 1e-4) continue;
      return tri.a[1] + (tri.b[1] - tri.a[1]) * alpha + (tri.d[1] - tri.a[1]) * beta;
    }
    return null;
  };

  const holes = [];
  let sampled = 0;
  for (const mesh of c.trackMeshes ?? c.asphaltMeshes) {
    const positions = mesh.geometry.attributes.position;
    const index = mesh.geometry.index;
    const count = index ? index.count : positions.count;
    const stride = Math.max(3, Math.floor(index ? index.count : positions.count) / 2500);
    const point = new THREE.Vector3();
    for (let i = 0; i + 2 < count; i += stride * 3) {
      let sx = 0;
      let sy = 0;
      let sz = 0;
      for (let k = 0; k < 3; k++) {
        const id = index ? index.getX(i + k) : i + k;
        point.fromBufferAttribute(positions, id).applyMatrix4(mesh.matrixWorld);
        sx += point.x / 3;
        sy += point.y / 3;
        sz += point.z / 3;
      }
      sampled++;
      const level = cover(sx, sz);
      if (level === null || Math.abs(level - sy) > 0.35) {
        holes.push({ x: +sx.toFixed(0), y: +sy.toFixed(1), z: +sz.toFixed(0), level: level === null ? null : +level.toFixed(2) });
      }
    }
  }

  return {
    triangles: road.triangles,
    over10: over(10),
    over20: over(20),
    over50: over(50),
    worst,
    holes: holes.length,
    holeSamples: holes.slice(0, 20),
    sampled,
  };
});

console.log(
  `TRAME ${report.triangles} triangles · >10 % ${report.over10} · >20 % ${report.over20} · >50 % ${report.over50}`,
);
for (const entry of report.worst) {
  console.log(
    `  ${String(entry.gradePct).padStart(4)} % (${entry.slopeDeg}°) en (${entry.at.join(', ')}) · cotes ${entry.heights.join('/')} (écart ${entry.span} m)`,
  );
}
console.log(`TROUS ${report.holes}/${report.sampled} échantillons d'asphalte sans collision à 0,6 m`);
for (const hole of report.holeSamples) console.log(`  asphalte (${hole.x}, ${hole.y}, ${hole.z}) · collision ${hole.level}`);

// Vues depuis la piste : on pose la voiture sur des nœuds de la trame, orientée
// vers un nœud voisin, et on laisse la caméra de poursuite faire l'image.
const spots = await page.evaluate(() => {
  const c = window.__sp95Circuit;
  const verts = c.flatRoad.vertices;
  const nodes = [];
  for (let i = 0; i < verts.length; i += 3) nodes.push({ x: verts[i], y: verts[i + 1], z: verts[i + 2] });
  const chosen = [];
  for (let i = 0; i < nodes.length; i += 37) {
    const here = nodes[i];
    let best = null;
    let bestDistance = 14;
    for (let k = 0; k < 24; k++) {
      const other = nodes[(i + k * 13) % nodes.length];
      const d = Math.hypot(other.x - here.x, other.z - here.z);
      if (d > 5 && d < bestDistance) {
        bestDistance = d;
        best = other;
      }
    }
    if (!best) continue;
    chosen.push({
      x: here.x,
      z: here.z,
      heading: Math.atan2(best.x - here.x, best.z - here.z),
    });
    if (chosen.length >= 8) break;
  }
  return chosen;
});

for (const [index, spot] of spots.entries()) {
  await page.evaluate(
    (pose) => {
      window.__sp95.teleport(pose.x, pose.z, pose.heading);
    },
    spot,
  );
  await page.waitForTimeout(1800);
  await page.screenshot({ path: `artifacts/spot-${index}.png`, timeout: 240_000 });
  console.log(`capture artifacts/spot-${index}.png en (${spot.x.toFixed(0)}, ${spot.z.toFixed(0)})`);
}

// Test de roulage : plein gaz sur la ligne droite des stands, échantillonné à
// 100 ms. On mesure les à-coups de cote et les instants sans contact.
await page.evaluate(() => window.__sp95.teleport(500, 430, Math.PI));
await page.waitForTimeout(900);
await page.keyboard.down('ArrowUp');
const track = [];
for (let i = 0; i < 45; i++) {
  await page.waitForTimeout(100);
  track.push(
    await page.evaluate(() => ({
      y: window.__sp95.position.y,
      speed: window.__sp95.speedKmh,
      contacts: window.__sp95.wheels.filter((wheel) => wheel.contact).length,
    })),
  );
}
await page.keyboard.up('ArrowUp');
const steps = track.slice(1).map((entry, index) => Math.abs(entry.y - track[index].y));
const air = track.filter((entry) => entry.contacts === 0).length;
console.log(
  `ROULAGE ${track[track.length - 1].speed.toFixed(0)} km/h · à-coups > 2 cm ${steps.filter((step) => step > 0.02).length}/${steps.length} ` +
    `(pire ${(Math.max(0, ...steps) * 100).toFixed(0)} cm) · roues en l'air ${air}/${track.length}`,
);

await browser.close();
