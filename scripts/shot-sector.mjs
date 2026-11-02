#!/usr/bin/env node
/**
 * Rendu du secteur de la place du col : vue d'ensemble, hôtel et virage serré.
 *
 *   node scripts/shot-sector.mjs
 *
 * Le rendu tourne sur SwiftShader, d'où `--fx=low` : les captures servent à
 * vérifier la géométrie, pas les effets. La capture passe par CDP, comme dans
 * `shoot.mjs` : l'API Playwright attend un compositeur au repos que la scène
 * WebGL n'atteint jamais.
 */
import { chromium } from 'playwright';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const centerline = JSON.parse(readFileSync('public/data/mollendruz/centerline.json', 'utf8'));
const features = JSON.parse(readFileSync('public/data/mollendruz/features.json', 'utf8'));
const samples = centerline.samples;

const hotel = features.buildings.find((building) => building.kind === 'hotel');
const hotelX = hotel.points.reduce((sum, p) => sum + p[0], 0) / hotel.points.length;
const hotelZ = hotel.points.reduce((sum, p) => sum + p[1], 0) / hotel.points.length;
const plazaX = features.plaza.reduce((sum, p) => sum + p[0], 0) / features.plaza.length;
const plazaZ = features.plaza.reduce((sum, p) => sum + p[1], 0) / features.plaza.length;

const at = (s) => samples.reduce((best, p) => (Math.abs(p.s - s) < Math.abs(best.s - s) ? p : best), samples[0]);
const bend = at(4548);
const previous = at(4520);
const dx = bend.x - previous.x;
const dz = bend.z - previous.z;
const length = Math.hypot(dx, dz) || 1;
const ux = dx / length;
const uz = dz / length;
const nx = -uz;
const nz = ux;

/** [caméra relative au sol, cible relative au sol, point de sol visé] */
const views = {
  secteur: {
    ground: [plazaX, plazaZ],
    camera: [plazaX + 52, 34, plazaZ + 62],
    target: [(plazaX + hotelX) / 2, 4, (plazaZ + hotelZ) / 2],
  },
  hotel: {
    ground: [hotelX + 18, hotelZ - 22],
    camera: [hotelX + 15, 9, hotelZ - 19],
    target: [hotelX, 4.5, hotelZ],
  },
  virage: {
    ground: [bend.x, bend.z],
    camera: [bend.x + nx * 30 - ux * 22, 34, bend.z + nz * 30 - uz * 22],
    target: [bend.x, 0, bend.z],
  },
  dessus: {
    ground: [bend.x, bend.z],
    camera: [bend.x + 0.01, 42, bend.z + 0.01],
    target: [bend.x, 0, bend.z],
  },
};

const base = process.env.SP95_URL ?? 'http://127.0.0.1:3000/';
const url = new URL(base);
url.searchParams.set('map', 'col');
url.searchParams.set('start', 'free');
url.searchParams.set('fx', 'low');
url.searchParams.set('fps', '20');
url.searchParams.set('light', 'soleil-haut');

mkdirSync('artifacts', { recursive: true });
const browser = await chromium.launch({
  args: [
    '--no-sandbox',
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--disable-dev-shm-usage',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
  ],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const logs = [];
page.on('console', (message) => logs.push(`${message.type()}: ${message.text()}`));
page.on('pageerror', (error) => logs.push(`pageerror: ${error.message}`));

await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__sp95?.ready === true, null, { timeout: 240000 });
const client = await page.context().newCDPSession(page);

for (const [name, view] of Object.entries(views)) {
  const ground = await page.evaluate(
    ([x, z]) => {
      window.__sp95.teleport(x, z, 0);
      return window.__sp95.position.y;
    },
    view.ground,
  );
  await page.waitForTimeout(1200);
  await page.evaluate(
    ([cx, cy, cz, tx, ty, tz, gy]) => window.__sp95.setCamera(cx, gy + cy, cz, tx, gy + ty, tz),
    [...view.camera, ...view.target, ground],
  );
  await page.waitForTimeout(1500);
  const shot = await client.send('Page.captureScreenshot', { format: 'png' });
  const file = `artifacts/secteur-${name}.png`;
  writeFileSync(file, Buffer.from(shot.data, 'base64'));
  console.log(file);
}

const built = await page.evaluate(() => {
  const scene = window.__sp95three.scene;
  const counts = { laybys: 0, annexes: 0 };
  scene.traverse((object) => {
    if (object.name.startsWith('mollendruz-layby-')) counts.laybys++;
    if (object.name.startsWith('mollendruz-annex-')) counts.annexes++;
  });
  return {
    ...counts,
    hotel: Boolean(scene.getObjectByName('mollendruz-hotel')),
    bands: Boolean(scene.getObjectByName('mollendruz-bend-bands')),
    plaza: Boolean(scene.getObjectByName('mollendruz-plaza')),
  };
});
console.log(JSON.stringify(built));
const stats = await page.evaluate(() => window.__sp95.debug);
console.log(`render ${stats.drawCalls} draw calls, ${Math.round(stats.triangles / 1000)}k triangles`);
const errors = logs.filter((line) => /pageerror|error/i.test(line));
if (errors.length) console.log(errors.slice(0, 5).join('\n'));
await browser.close();
