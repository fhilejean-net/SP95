/**
 * Headless smoke test: boots the game, starts free roam, drives, drifts and
 * starts a race. Requires a running dev server and a Chromium install:
 *   npx playwright install chromium
 *   npm run dev            # in another shell
 *   node scripts/smoke.mjs
 *
 * On a machine without Chromium's system libraries, run with LD_LIBRARY_PATH
 * pointing at local copies of libnss3, libnspr4, libatk, libasound, libx*.
 */
import { chromium } from 'playwright';

const URL = process.env.SP95_URL ?? 'http://127.0.0.1:3000/?fx=low';
const TIMEOUT = 40_000;

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1024, height: 640 } });

const errors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(msg.text());
});
page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

let failed = false;
const check = (label, condition, detail) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failed = true;
};

const waitFor = async (fn, timeout = TIMEOUT) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await page.evaluate(fn);
    if (value) return value;
    await page.waitForTimeout(300);
  }
  return null;
};

try {
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__sp95?.ready === true, null, { timeout: 120_000 });

  const initial = await page.evaluate(() => ({
    mode: window.__sp95.mode,
    menuVisible: !document.getElementById('menu').classList.contains('hidden'),
    debug: window.__sp95.debug,
  }));
  check('game boots into the menu', initial.mode === 'menu' && initial.menuVisible);
  check(
    'scene builds with geometry',
    initial.debug.drawCalls > 15,
    `${initial.debug.drawCalls} draw calls, ${initial.debug.triangles} triangles`,
  );

  await page.click('#btn-free');
  await page.waitForFunction(() => window.__sp95.mode === 'free');
  await page.waitForTimeout(700);

  await page.keyboard.press('Escape');
  const paused = await waitFor(() => window.__sp95.paused === true, 8000);
  const overlayVisible = await page.evaluate(
    () => !document.getElementById('pause').classList.contains('hidden'),
  );
  await page.keyboard.press('Escape');
  const resumed = await waitFor(() => window.__sp95.paused === false, 8000);
  check('pause overlay opens and closes', Boolean(paused) && overlayVisible && Boolean(resumed));

  await page.keyboard.down('KeyW');
  const accelerated = await waitFor(() => window.__sp95.speedKmh > 35);
  await page.keyboard.up('KeyW');
  const driving = await page.evaluate(() => ({
    speed: window.__sp95.speedKmh,
    gear: window.__sp95.gear,
    rpm: window.__sp95.rpm,
  }));
  check('car accelerates under keyboard input', Boolean(accelerated), `${driving.speed.toFixed(0)} km/h`);
  check('engine and gearbox are live', driving.gear >= 1 && driving.rpm > 900, `gear ${driving.gear}, ${driving.rpm.toFixed(0)} rpm`);

  check('no console errors while driving', errors.length === 0, errors.slice(0, 3).join(' | '));

  await page.evaluate(() => window.__sp95.startRace());
  // Software rendering (SwiftShader) runs at a few fps, so the 3.4 s countdown
  // takes a lot longer than wall-clock time here. Allow plenty of headroom.
  const running = await waitFor(() => window.__sp95.racePhase === 'running', 120_000);
  check('race leaves the countdown', Boolean(running));
  const race = await page.evaluate(() => ({ phase: window.__sp95.racePhase, lap: window.__sp95.raceLap }));
  check('race starts on lap 1', race.lap === 1 && race.phase === 'running');

  await page.keyboard.down('KeyW');
  const raced = await waitFor(() => window.__sp95.speedKmh > 25, 45_000);
  await page.keyboard.up('KeyW');
  check('car drives on the circuit', Boolean(raced), `${(await page.evaluate(() => window.__sp95.speedKmh)).toFixed(0)} km/h`);

  const debug = await page.evaluate(() => window.__sp95.debug);
  console.log(`INFO  render: ${debug.drawCalls} draw calls, ${Math.round(debug.triangles / 1000)}k triangles, ~${debug.fps} fps (SwiftShader)`);
} catch (error) {
  failed = true;
  console.error('SMOKE ERROR', error);
} finally {
  await browser.close();
}

process.exit(failed ? 1 : 0);
