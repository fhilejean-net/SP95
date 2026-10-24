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

  const kit = await page.evaluate(() => window.__sp95.streetKit);
  check(
    'the Kenney street kit is built',
    kit.models >= 10 && kit.instances > 200 && kit.colliders > 150,
    `${kit.models} models, ${kit.instances} pieces, ${kit.colliders} colliders`,
  );

  // The modelled car: the GLB replaces the lofted shell, wheels on the mounts.
  const carState = await page.evaluate(() => ({
    id: window.__sp95.car,
    model: window.__sp95.carModel,
    mounts: window.__sp95.wheelMounts,
    cars: window.__sp95.cars,
    spec: window.__sp95.spec,
    redline: window.__sp95.redline,
  }));
  check(
    'the modelled car loads from its GLB',
    carState.model && carState.cars.length === 3,
    `${carState.id}, fallback ${carState.model ? 'no' : 'yes'}`,
  );
  const halfTrack = Math.max(...carState.mounts.map((mount) => Math.abs(mount.x)));
  const wheelbase = Math.abs(carState.mounts[0].z - carState.mounts[2].z);
  check(
    'its wheels sit on the physics mounts',
    Math.abs(halfTrack - 0.8545) < 0.02 && Math.abs(wheelbase - 2.749) < 0.02,
    `${(halfTrack * 2).toFixed(3)} m track, ${wheelbase.toFixed(3)} m wheelbase`,
  );

  // Sound panel: one fader per family, applied live and remembered.
  await page.click('#btn-sound');
  await page.waitForTimeout(400);
  const soundPanel = await page.evaluate(() => ({
    open: window.__sp95.soundPanelOpen,
    rows: document.querySelectorAll('#sound-channels .sound-row').length,
    menuHidden: document.getElementById('menu').classList.contains('hidden'),
  }));
  check(
    'the sound panel opens with one fader per channel',
    soundPanel.open && soundPanel.rows === 9 && soundPanel.menuHidden,
    `${soundPanel.rows} faders`,
  );
  await page.evaluate(() => {
    const slider = document.querySelector('#sound-channels input[data-channel="turbo"]');
    slider.value = '20';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const mixed = await page.evaluate(() => ({
    mix: window.__sp95.soundMix,
    stored: localStorage.getItem('sp95.audioMix'),
  }));
  check(
    'a fader moves that channel and is remembered',
    Math.abs(mixed.mix.turbo - 0.2) < 1e-6 && Boolean(mixed.stored),
    `turbo ${mixed.mix.turbo}`,
  );
  await page.click('#btn-sound-reset');
  const resetTurbo = await page.evaluate(() => window.__sp95.soundMix.turbo);
  check('reset restores the balanced mix', Math.abs(resetTurbo - 0.45) < 1e-6, `${resetTurbo}`);
  await page.click('#btn-sound-close');
  const menuBack = await page.evaluate(
    () => !document.getElementById('menu').classList.contains('hidden'),
  );
  check('closing the sound panel returns to the menu', menuBack);

  // Garage: pick a part, make sure the car is rebuilt with it.
  await page.click('#btn-garage');
  await page.waitForTimeout(400);
  const garage = await page.evaluate(() => ({
    open: window.__sp95.garageOpen,
    tabs: document.querySelectorAll('#garage-tabs button').length,
    parts: document.querySelectorAll('#garage-options button').length,
  }));
  check('garage lists every setup category', garage.open && garage.tabs === 6, `${garage.tabs} tabs`);
  await page.click('#garage-options button[data-option="1"]');
  const tuned = await page.evaluate(() => window.__sp95.spec);
  check('a part changes the car', tuned.peakTorque > carState.spec.peakTorque, `${tuned.peakTorque} Nm`);
  await page.click('#garage-options button[data-option="0"]');
  await page.click('#garage-presets button[data-preset="1"]');
  const drift = await page.evaluate(() => window.__sp95.spec);
  check(
    'the drift preset fits the angle kit',
    drift.maxSteer > carState.spec.maxSteer + 0.05,
    `${drift.maxSteer.toFixed(2)} rad`,
  );
  await page.click('#garage-presets button[data-preset="0"]');
  await page.click('#btn-garage-close');
  const stockAgain = await page.evaluate(() => window.__sp95.spec);
  check(
    'the stock setup is restored',
    stockAgain.peakTorque === carState.spec.peakTorque,
    `${stockAgain.peakTorque} Nm`,
  );

  // Car picker: the rally car has its own footprint, engine and redline.
  await page.click('#btn-garage');
  await page.waitForTimeout(400);
  await page.click('#garage-cars .car-choice[data-car="i20n"]');
  const swapped = await waitFor(
    () => window.__sp95.car === 'i20n' && !document.querySelector('#garage-cars .car-choice.loading'),
    60_000,
  );
  const pickup = await page.evaluate(() => ({
    spec: window.__sp95.spec,
    redline: window.__sp95.redline,
    mounts: window.__sp95.wheelMounts,
  }));
  const rallyBase = Math.abs(pickup.mounts[0].z - pickup.mounts[2].z);
  check(
    'the garage swaps in another car model',
    Boolean(swapped) && pickup.spec.mass === 1230 && pickup.redline === 7200,
    `${pickup.spec.name}, ${pickup.redline} tr/min`,
  );
  check(
    'the new model brings its own wheelbase',
    Math.abs(rallyBase - 2.59) < 0.02,
    `${rallyBase.toFixed(3)} m`,
  );
  await page.click('#garage-cars .car-choice[data-car="aventador"]');
  await waitFor(() => window.__sp95.car === 'aventador', 60_000);
  await page.click('#btn-garage-close');

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
  const spinA = await page.evaluate(() => window.__sp95.wheelSpin);
  // SwiftShader runs at about one frame per second: give it a few frames.
  await page.waitForTimeout(3000);
  const spinB = await page.evaluate(() => window.__sp95.wheelSpin);
  await page.keyboard.up('KeyW');
  check(
    'the wheels roll with the car',
    spinA.some((value, index) => Math.abs(value - spinB[index]) > 0.01),
    spinB.map((value) => value.toFixed(2)).join(', '),
  );
  const driving = await page.evaluate(() => ({
    speed: window.__sp95.speedKmh,
    gear: window.__sp95.gear,
    rpm: window.__sp95.rpm,
  }));
  check('car accelerates under keyboard input', Boolean(accelerated), `${driving.speed.toFixed(0)} km/h`);
  check('engine and gearbox are live', driving.gear >= 1 && driving.rpm > 900, `gear ${driving.gear}, ${driving.rpm.toFixed(0)} rpm`);

  const tach = await page.evaluate(() => ({
    value: Number(document.getElementById('rpm-value').textContent.replace(/\s/g, '')),
    max: document.getElementById('rpm-max').textContent.replace(/\s/g, ''),
    redline: window.__sp95.redline,
  }));
  check(
    'the tachometer shows live revs and the redline',
    tach.value > 1000 && tach.max.endsWith(String(tach.redline)) && tach.redline === carState.redline,
    `${tach.value} tr/min ${tach.max}`,
  );

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

  // Mountain road: the col spawns far from the city, on the climb.
  await page.keyboard.press('Escape');
  await waitFor(() => window.__sp95.paused === true, 8000);
  await page.click('#btn-pause-col');
  await page.waitForTimeout(1200);
  const col = await page.evaluate(() => ({ mode: window.__sp95.mode, position: window.__sp95.position }));
  check(
    'the col spawns on the mountain road',
    col.mode === 'free' && col.position.x < -200 && col.position.z < -280,
    `${col.position.x.toFixed(0)}, ${col.position.z.toFixed(0)}`,
  );
  await page.keyboard.down('KeyW');
  const climbed = await waitFor(() => window.__sp95.speedKmh > 20, 45_000);
  await page.keyboard.up('KeyW');
  check('the car drives away on the col', Boolean(climbed));

  // Rally stage: spawn on the gravel loop, on dirt.
  await page.keyboard.press('Escape');
  await waitFor(() => window.__sp95.paused === true, 8000);
  await page.click('#btn-pause-rally');
  await page.waitForTimeout(1200);
  const rally = await page.evaluate(() => ({
    mode: window.__sp95.mode,
    surface: window.__sp95.surface,
    position: window.__sp95.position,
  }));
  check(
    'the rally stage spawns on dirt',
    rally.mode === 'free' && rally.surface === 'terre',
    `${rally.surface} at ${rally.position.x.toFixed(0)}, ${rally.position.z.toFixed(0)}`,
  );
  await page.keyboard.down('KeyW');
  const rallyMoved = await waitFor(() => window.__sp95.speedKmh > 20, 45_000);
  await page.keyboard.up('KeyW');
  check('the car drives on gravel', Boolean(rallyMoved));

  // Summit drift arena.
  await page.keyboard.press('Escape');
  await waitFor(() => window.__sp95.paused === true, 8000);
  await page.click('#btn-pause-sommet');
  await page.waitForTimeout(1200);
  const summit = await page.evaluate(() => ({
    mode: window.__sp95.mode,
    surface: window.__sp95.surface,
    position: window.__sp95.position,
  }));
  check(
    'the summit arena is paved and high up',
    summit.mode === 'free' && summit.surface === 'asphalte' && summit.position.y > 50,
    `${summit.surface}, y=${summit.position.y.toFixed(0)}`,
  );

  // Engine sound effects: a full-throttle launch then a lift should have fired
  // an upshift fart and/or overrun pops.
  await page.keyboard.press('Escape');
  await waitFor(() => window.__sp95.paused === true, 8000);
  await page.click('#btn-pause-free');
  await page.waitForTimeout(800);
  await page.keyboard.down('KeyW');
  await waitFor(() => window.__sp95.speedKmh > 45, 60_000);
  await page.keyboard.up('KeyW');
  await page.waitForTimeout(600);
  const effects = await page.evaluate(() => window.__sp95.audioEvents);
  check('shift and overrun effects fire', effects > 0, `${effects} events`);

  check('no console errors at the end', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (error) {
  failed = true;
  console.error('SMOKE ERROR', error);
} finally {
  await browser.close();
}

process.exit(failed ? 1 : 0);
