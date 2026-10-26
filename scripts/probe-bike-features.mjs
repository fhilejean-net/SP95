import { chromium } from 'playwright';

/**
 * Functional probe for the bike features: clutch wheelie + sound, the
 * walk-back reverse and the five camera points of view.
 *
 * Software rendering runs at a couple of frames per second and the simulation
 * advances 0.05 s per frame, so the probe waits on the game state rather than
 * on wall time.
 */
const results = [];
const check = (name, ok, detail = '') => {
  results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
page.setDefaultTimeout(200000);
page.on('pageerror', (error) => results.push(`FAIL pageerror — ${error.message}`));

try {
  await page.goto('http://127.0.0.1:3000/?fx=low', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__sp95?.ready === true, null, { timeout: 120000 });
  await page.click('#btn-moto');
  await page.waitForFunction(() => window.__sp95.vehicleKind === 'bike', null, { timeout: 30000 });

  // --- Roll forward, then dump the clutch ---
  await page.keyboard.down('w');
  const rolling = await page
    .waitForFunction(() => (window.__sp95.speedKmh > 9 ? window.__sp95.speedKmh : false), null, {
      timeout: 90000,
      polling: 200,
    })
    .then((handle) => handle.jsonValue())
    .catch(() => 0);
  check('bike rolls under power', rolling > 9, `speed=${Number(rolling).toFixed(1)}`);

  const before = await page.evaluate(() => window.__sp95.audioEvents);
  await page.keyboard.press('Space');
  const pitch = await page
    .waitForFunction(() => (window.__sp95.bikePitch > 0.1 ? window.__sp95.bikePitch : false), null, {
      timeout: 60000,
      polling: 200,
    })
    .then((handle) => handle.jsonValue())
    .catch(() => 0);
  const after = await page.evaluate(() => window.__sp95.audioEvents);
  await page.keyboard.up('w');
  check('space lifts the front', pitch > 0.1, `pitch=${Number(pitch).toFixed(2)}`);
  check('clutch bang plays', after - before >= 1, `events +${after - before}`);

  // --- Reverse from a standstill ---
  await page.keyboard.down('s');
  await page
    .waitForFunction(() => window.__sp95.speedKmh < 2, null, { timeout: 60000, polling: 200 })
    .catch(() => null);
  await page
    .waitForFunction(() => window.__sp95.pushingBack === true, null, { timeout: 90000, polling: 200 })
    .catch(() => null);
  await page
    .waitForFunction(() => window.__sp95.speedKmh > 2, null, { timeout: 60000, polling: 200 })
    .catch(() => null);
  const reverse = await page.evaluate(() => ({
    pushing: window.__sp95.pushingBack,
    gear: window.__sp95.gear,
    speed: window.__sp95.speedKmh,
  }));
  await page.keyboard.up('s');
  check('reverse engages', reverse.pushing === true, JSON.stringify(reverse));
  check('reverse gear reads R', reverse.gear === -1, `gear=${reverse.gear}`);
  check('reverse is slow', reverse.speed > 1 && reverse.speed < 9, `speed=${reverse.speed.toFixed(1)}`);

  // --- Camera modes ---
  const modes = [await page.evaluate(() => window.__sp95.cameraMode)];
  for (let i = 0; i < 5; i++) {
    const previous = modes[modes.length - 1];
    await page.keyboard.press('c');
    await page
      .waitForFunction((last) => window.__sp95.cameraMode !== last, previous, { timeout: 20000, polling: 150 })
      .catch(() => null);
    modes.push(await page.evaluate(() => window.__sp95.cameraMode));
  }
  check('camera cycles through five views', new Set(modes).size === 5, modes.join(' → '));
} catch (error) {
  results.push(`FAIL script — ${error.message}`);
} finally {
  console.log(results.join('\n'));
  await browser.close();
}
