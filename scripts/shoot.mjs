#!/usr/bin/env node
/**
 * Photographie des voitures du jeu dans Chromium et mesure ce que le loader a
 * réellement construit (moyeux, rotation des roues, contact, vitesse).
 *
 *   node scripts/shoot.mjs --cars supra,crz,kart --view three-quarter
 *   node scripts/shoot.mjs --cars supra --drive 2000 --view side
 *
 * Une seule page pour toutes les voitures : chaque chargement de page coûte
 * une quarantaine de secondes sur SwiftShader.
 *
 * Le rendu tourne sur SwiftShader ; les bibliothèques système manquantes de la
 * VM sont extraites dans `.sysroot` et `LD_LIBRARY_PATH` vient de
 * `.sysroot/env.sh`. La capture passe par CDP : l'API `screenshot` de Playwright
 * attend un compositeur au repos qu'une scène WebGL permanente n'atteint jamais.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : fallback;
};

const cars = opt('cars', opt('car', 'aventador')).split(',').filter(Boolean);
const view = opt('view', 'three-quarter');
const light = opt('light', 'apres-midi');
const wait = Number(opt('wait', '1600'));
const drive = Number(opt('drive', '0'));
const fps = opt('fps', '20');
const base = opt('base', 'http://127.0.0.1:3000/');
const prefix = opt('prefix', '');
const teleport = opt('teleport', null);

mkdirSync('artifacts', { recursive: true });

const url = new URL(base);
url.searchParams.set('map', 'sp95');
url.searchParams.set('start', 'free');
url.searchParams.set('fx', 'full');
url.searchParams.set('fps', fps);
url.searchParams.set('light', light);

const browser = await chromium.launch({
  args: [
    '--no-sandbox',
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--disable-dev-shm-usage',
    // Sans ces trois drapeaux, Chromium sans tête ralentit la boucle de rendu
    // dès que l'onglet n'est pas au premier plan : la voiture restait figée à
    // 16 km/h et les roues ne tournaient pas, ce qui faisait passer un modèle
    // sain pour cassé.
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
await page.waitForFunction(() => Boolean(window.__sp95), null, { timeout: 180000 });
const client = await page.context().newCDPSession(page);

const press = (code, type) =>
  page.evaluate(
    ([key, kind]) => window.dispatchEvent(new KeyboardEvent(kind, { code: key, bubbles: true })),
    [code, type],
  );

const cameraFor = {
  'three-quarter': [5.4, 2.0, -4.6],
  'three-quarter-rear': [-5.4, 2.0, 4.6],
  side: [6.6, 1.6, 0.2],
  'side-left': [-6.6, 1.6, 0.2],
  front: [0.4, 1.5, -6.4],
  rear: [0.4, 1.8, 6.4],
  top: [0.01, 9, 0.01],
};

const results = [];
for (const car of cars) {
  const started = logs.length;
  await page.evaluate((id) => window.__sp95.setCar(id), car);
  await page.waitForTimeout(wait);

  const state = await page.evaluate(() => ({
    car: window.__sp95.car,
    model: window.__sp95.carModel,
    spec: window.__sp95.spec,
    mounts: window.__sp95.wheelMounts,
    spin: window.__sp95.wheelSpin,
    wheels: window.__sp95.wheels.length,
  }));

  if (teleport) {
    const [x, z, heading] = teleport.split(',').map(Number);
    await page.evaluate(
      ([px, pz, angle]) => window.__sp95.teleport(px, pz, angle),
      [x, z, heading ?? 0],
    );
    await page.waitForTimeout(500);
  }

  const origin = await page.evaluate(() => window.__sp95.position);
  if (view !== 'chase') {
    const [px, py, pz] = cameraFor[view] ?? cameraFor['three-quarter'];
    await page.evaluate(
      ([x, y, z, ox, oy, oz]) =>
        window.__sp95.setCamera(ox + x, oy + y, oz + z, ox, oy + 0.55, oz),
      [px, py, pz, origin.x, origin.y, origin.z],
    );
    await page.waitForTimeout(400);
  }

  // La photo est prise **avant** le test de conduite : la caméra est fixe et
  // la voiture quitterait le cadre en roulant.
  const file = `artifacts/${prefix}${car}-${view}.png`;
  {
    const shot = await client.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(file, Buffer.from(shot.data, 'base64'));
  }

  let spinDelta = null;
  let samples = null;
  if (drive > 0) {
    const before = await page.evaluate(() => window.__sp95.wheelSpin);
    const start = await page.evaluate(() => window.__sp95.position);
    await press('KeyW', 'keydown');
    const trace = [];
    const steps = 5;
    for (let step = 0; step < steps; step++) {
      await page.waitForTimeout(drive / steps);
      trace.push(
        await page.evaluate(() => {
          const speed = Math.round(window.__sp95.speedKmh);
          const omega = (window.__sp95.wheels[0]?.omega ?? 0).toFixed(1);
          const spin = (window.__sp95.wheelSpin[0] ?? 0).toFixed(2);
          const fps = window.__sp95.debug?.fps ?? -1;
          return `${speed}km/h w${omega} rot${spin} ${fps}fps`;
        }),
      );
    }
    const after = await page.evaluate(() => window.__sp95.wheelSpin);
    const end = await page.evaluate(() => window.__sp95.position);
    await press('KeyW', 'keyup');
    spinDelta = after.map((value, index) => Number((value - (before[index] ?? 0)).toFixed(3)));
    samples = {
      moved: Number(Math.hypot(end.x - start.x, end.z - start.z).toFixed(2)),
      trace,
    };
  }

  results.push({
    car,
    file,
    model: state.model,
    wheels: state.wheels,
    mounts: state.mounts.map((mount) => `${mount.x.toFixed(2)}/${mount.z.toFixed(2)}`),
    spinDelta,
    samples,
    logs: logs
      .slice(started)
      .filter((line) => /roue|moyeu|error|warn/i.test(line))
      .slice(-4),
  });
}

await browser.close();
console.log(JSON.stringify(results, null, 2));
