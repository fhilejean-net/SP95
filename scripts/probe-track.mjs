/**
 * Diagnostic de la piste : couches de maillages au sol autour de la voiture,
 * tenue de route sur la ligne droite (antipatinage actif puis coupé) et trois
 * captures du revêtement.
 *
 *   SP95_HOLD=8000 node scripts/tmp-layers.mjs
 */
import { chromium } from 'playwright';

const URL = process.env.SP95_TRACK_URL ?? 'http://127.0.0.1:3000/?map=suzuka&fx=low';
const HOLD_MS = Number(process.env.SP95_HOLD ?? 8000);

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.setDefaultNavigationTimeout(240_000);
page.on('pageerror', (error) => console.log(`pageerror: ${error.message}`));
page.on('console', (message) => {
  const text = message.text();
  if (message.type() === 'error') console.log(`console error: ${text}`);
  else if (/Circuit|Piste|Matières|Terrain|décor/.test(text)) console.log(`log: ${text}`);
});

await page.goto(URL, { waitUntil: 'load', timeout: 240_000 });
await page.waitForFunction(() => window.__sp95?.ready === true, null, { timeout: 300_000 });
await page.evaluate(() => window.__sp95.startFree());
await page.waitForTimeout(500);

const setup = await page.evaluate(() => ({
  car: window.__sp95.car,
  tcs: window.__sp95.tcs,
  setup: window.__sp95.setup,
  wheels: window.__sp95.wheels.map((wheel) => wheel.name),
  fps: window.__sp95.debug.fps,
}));
console.log(
  `voiture ${setup.car} · antipatinage ${setup.tcs ? 'actif' : 'coupé'} · roues ${setup.wheels.join(',')} · ` +
    `${setup.fps.toFixed(0)} fps · réglage ${JSON.stringify(setup.setup)}`,
);

const sample = () =>
  page.evaluate(() => ({
    y: window.__sp95.position.y,
    speed: window.__sp95.speedKmh,
    surface: window.__sp95.surface,
    gear: window.__sp95.gear,
    rpm: window.__sp95.rpm,
    tcs: window.__sp95.tcs,
    contacts: window.__sp95.wheels.filter((wheel) => wheel.contact).length,
    loads: window.__sp95.wheels.map((wheel) => Math.round(wheel.load)),
    slips: window.__sp95.wheels.map((wheel) => Number(wheel.slip.toFixed(2))),
  }));

async function phase(label, ms) {
  const track = [];
  await page.keyboard.down('ArrowUp');
  for (let i = 0; i < Math.round(ms / 100); i++) {
    await page.waitForTimeout(100);
    track.push(await sample());
  }
  await page.keyboard.up('ArrowUp');
  await page.waitForTimeout(300);
  const slips = track.flatMap((entry) => entry.slips);
  const loads = track.map((entry) => entry.loads);
  const front = loads.map((entry) => entry[0] + entry[1]);
  const ascent = track.map((entry, index) => entry.y - (index === 0 ? track[0].y : track[index - 1].y));
  const jitter = ascent.filter((step) => Math.abs(step) > 0.01).map((step) => Math.abs(step));
  console.log(
    `${label} : ${track[track.length - 1].speed.toFixed(0)} km/h en ${(ms / 1000).toFixed(0)} s · ` +
      `rapport ${track[track.length - 1].gear} à ${track[track.length - 1].rpm.toFixed(0)} tr/min · ` +
      `patinage moyen ${(slips.reduce((sum, value) => sum + Math.abs(value), 0) / slips.length).toFixed(2)} max ${Math.max(...slips.map(Math.abs)).toFixed(2)}\n` +
      `  charge avant ${Math.min(...front)}..${Math.max(...front)} N · charge par roue ${loads[loads.length - 1].join('/')} N · ` +
      `contacts<4 ${track.filter((entry) => entry.contacts < 4).length}/${track.length} · à-coups ${jitter.length} (pire ${Math.max(0, ...jitter).toFixed(3)} m)`,
  );
  return track[track.length - 1];
}

await phase('antipatinage actif', HOLD_MS);
await page.evaluate(() => window.__sp95.setTcs(false));
await page.waitForTimeout(200);
await phase('antipatinage coupé', HOLD_MS);

const frame = await page.evaluate(() => ({ ...window.__sp95.position }));
const cameras = [
  ['artifacts/track-straight.png', (p) => [p.x, p.y + 3.2, p.z + 11, p.x, p.y + 0.4, p.z - 26]],
  ['artifacts/track-surface.png', (p) => [p.x, p.y + 1.1, p.z - 2, p.x, p.y - 0.2, p.z - 18]],
  ['artifacts/track-high.png', (p) => [p.x - 4, p.y + 14, p.z + 6, p.x + 2, p.y, p.z - 60]],
];
for (const [path, camera] of cameras) {
  await page.evaluate(
    ([source, point]) => window.__sp95.setCamera(...new Function('p', `return (${source})(p)`)(point)),
    [camera.toString(), frame],
  );
  await page.waitForTimeout(1100);
  await page
    .screenshot({ path, timeout: 150_000 })
    .then(() => console.log(`  capture ${path}`))
    .catch((error) => console.log(`  capture ratée (${error.message.split('\n')[0]})`));
}

await browser.close();
