/**
 * Audit de la trame de collision de la piste : bosses, couverture, et capture
 * du pire endroit trouvé.
 *
 *   node scripts/tmp-plate-audit.mjs
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.setDefaultNavigationTimeout(240_000);
page.on('pageerror', (error) => console.log(`pageerror: ${error.message}`));
page.on('console', (message) => {
  const text = message.text();
  if (/Piste|Circuit :|Matières/.test(text)) console.log(`log: ${text}`);
});

await page.goto('http://127.0.0.1:3000/?map=suzuka&fx=low', { waitUntil: 'load', timeout: 240_000 });
await page.waitForFunction(() => window.__sp95?.ready === true, null, { timeout: 300_000 });
await page.waitForTimeout(400);

const audit = await page.evaluate(() => {
  const road = window.__sp95Circuit.flatRoad;
  const { vertices, indices } = road;
  const tilts = [];
  let grading = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3;
    const b = indices[t + 1] * 3;
    const c = indices[t + 2] * 3;
    const ux = vertices[b] - vertices[a];
    const uy = vertices[b + 1] - vertices[a + 1];
    const uz = vertices[b + 2] - vertices[a + 2];
    const vx = vertices[c] - vertices[a];
    const vy = vertices[c + 1] - vertices[a + 1];
    const vz = vertices[c + 2] - vertices[a + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-9) continue;
    const tilt = (Math.acos(Math.min(1, Math.abs(ny) / len)) * 180) / Math.PI;
    tilts.push(tilt);
    if (tilt > 3) grading++;
  }
  tilts.sort((a, b) => a - b);
  const at = (q) => Number((tilts[Math.floor((tilts.length - 1) * q)] ?? 0).toFixed(2));

  // Bosses : écart d'un nœud à la moyenne de ses quatre voisins orthogonaux,
  // sur la plaque *sans collet* (la seule qui porte la piste).
  const core = window.__sp95Circuit.roadCore;
  const grid = new Map();
  for (let i = 0; i < core.vertices.length; i += 3) {
    const key = `${Math.round(core.vertices[i] / 3)}:${Math.round(core.vertices[i + 2] / 3)}`;
    grid.set(key, { x: core.vertices[i], y: core.vertices[i + 1], z: core.vertices[i + 2] });
  }
  const bumps = [];
  let checked = 0;
  for (const [key, node] of grid) {
    const [ix, iz] = key.split(':').map(Number);
    const around = [`${ix + 1}:${iz}`, `${ix - 1}:${iz}`, `${ix}:${iz + 1}`, `${ix}:${iz - 1}`];
    if (!around.every((k) => grid.has(k))) continue;
    let sum = 0;
    for (const k of around) sum += grid.get(k).y;
    checked++;
    bumps.push({ d: Math.abs(node.y - sum / 4), x: node.x, y: node.y, z: node.z });
  }
  bumps.sort((a, b) => b.d - a.d);
  const quant = (q) => Number((bumps[Math.floor((bumps.length - 1) * q)] ?? { d: 0 }).d.toFixed(3));

  return {
    triangles: road.triangles,
    decks: road.decks,
    maxGrade: Number(road.maxGrade.toFixed(1)),
    dropped: road.dropped,
    tilt: { p50: at(0.5), p90: at(0.9), p99: at(0.99), max: at(1) },
    over3: grading,
    nodes: checked,
    bump: { p50: quant(0.5), p90: quant(0.9), p99: quant(0.99), max: Number((bumps[0]?.d ?? 0).toFixed(3)) },
    worstBumps: bumps.slice(0, 6).map((b) => ({
      d: Number(b.d.toFixed(2)),
      x: Number(b.x.toFixed(1)),
      y: Number(b.y.toFixed(1)),
      z: Number(b.z.toFixed(1)),
    })),
  };
});
console.log(JSON.stringify(audit, null, 1));

// Vue de dessus avec le treillis de collision, puis gros plan sur la pire bosse.
await page.evaluate(() => window.__sp95.startFree());
await page.waitForTimeout(800);
await page.keyboard.press('F9');
await page.waitForTimeout(400);
const spot = audit.worstBumps[0] ?? { x: 0, y: 0, z: 0 };
await page.evaluate((point) => {
  window.__sp95.setCamera(point.x + 26, point.y + 18, point.z + 26, point.x, point.y, point.z - 10);
}, spot);
await page.waitForTimeout(1200);
await page.screenshot({ path: 'artifacts/plate-bump.png' });

await page.evaluate(() => {
  const p = window.__sp95.position;
  window.__sp95.setCamera(p.x, p.y + 70, p.z + 90, p.x, p.y, p.z - 80);
});
await page.waitForTimeout(1200);
await page.screenshot({ path: 'artifacts/plate-wide.png' });
await browser.close();
