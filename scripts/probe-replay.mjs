/**
 * Contrôle navigateur du replay : la physique est gelée pendant la lecture,
 * donc la position du corps ne bouge plus, mais les roues du modèle doivent
 * continuer à tourner. Avant le cycle 11, elles restaient figées.
 *
 * Le rendu logiciel de la VM tourne à ~2 fps et le pas de temps est plafonné à
 * 50 ms : la lecture avance donc lentement. On attend un instant de lecture
 * précis au lieu de dormir un nombre fixe de secondes.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const URL = process.env.SP95_URL ?? 'http://127.0.0.1:3000/?map=sp95&fx=low';
mkdirSync('artifacts', { recursive: true });

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1024, height: 640 } });
const errors = [];
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

const waitFor = async (fn, timeout = 90_000, arg) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await page.evaluate(fn, arg);
    if (value) return value;
    await page.waitForTimeout(300);
  }
  return null;
};

let failed = false;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed = true;
};

await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => window.__sp95?.ready === true, null, { timeout: 150_000 });
await page.waitForTimeout(1200);
await page.evaluate(() => window.__sp95.startFree());
await waitFor(() => window.__sp95.mode === 'free');
await page.waitForTimeout(800);

await page.keyboard.down('KeyW');
const drove = await waitFor(() => window.__sp95.speedKmh > 25);
await page.waitForTimeout(3000);
await page.keyboard.up('KeyW');
await page.waitForTimeout(500);
check('the car is moving before the replay', Boolean(drove));

await page.keyboard.press('KeyV');
const playing = await waitFor(() => window.__sp95.replayState.active, 30_000);
check('the replay starts', Boolean(playing));

// Laisse la lecture atteindre la portion roulée : les premières frames de la
// mémoire datent de l'arrêt au stand, où les roues ne tournaient pas.
const startA = await waitFor(() => {
  const state = window.__sp95.replayState;
  return state.elapsed > 4.0 ? state.elapsed : 0;
}, 200_000);
const p1 = await page.evaluate(() => window.__sp95.position);
const spinA = await page.evaluate(() => window.__sp95.wheelSpin);

const endB = await waitFor(
  (threshold) => {
    const state = window.__sp95.replayState;
    return state.elapsed > threshold ? state.elapsed : 0;
  },
  200_000,
  startA + 0.8,
);
const p2 = await page.evaluate(() => window.__sp95.position);
const spinB = await page.evaluate(() => window.__sp95.wheelSpin);
await page.screenshot({ path: 'artifacts/replay-wheels.png' });

const frozen = Math.hypot(p1.x - p2.x, p1.y - p2.y, p1.z - p2.z) < 1e-6;
const turning = spinA.some((value, index) => Math.abs(value - spinB[index]) > 0.01);
check(
  'playback reached the rolling part of the recording',
  Boolean(endB),
  `t=${startA?.toFixed(2)} → ${endB?.toFixed(2)} s`,
);
check('the physics stays frozen, so the replay is playing', frozen, `Δ=${Math.hypot(p1.x - p2.x, p1.z - p2.z).toFixed(3)} m`);
check(
  'the wheels turn during playback',
  turning,
  `${spinA.map((v) => v.toFixed(2))} → ${spinB.map((v) => v.toFixed(2))}`,
);
check('no console errors', errors.length === 0, errors.slice(0, 2).join(' | '));

await browser.close();
if (failed) process.exit(1);
