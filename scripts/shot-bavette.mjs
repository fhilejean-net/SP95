import { chromium } from 'playwright';

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
const errors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(msg.text());
});
page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

const waitFor = async (fn, timeout = 60_000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await page.evaluate(fn)) return true;
    await page.waitForTimeout(60);
  }
  return false;
};

try {
  await page.goto('http://127.0.0.1:3000/?fx=low', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__sp95?.ready === true, null, { timeout: 120_000 });
  await page.click('#btn-moto');
  await page.waitForFunction(() => window.__sp95.vehicleKind === 'bike', null, { timeout: 90_000 });
  await page.evaluate(() => window.__sp95.teleport(176, 132, 0));
  await page.waitForTimeout(2200);
  await page.keyboard.down('KeyW');
  await waitFor(() => window.__sp95.speedKmh > 35);

  // First clutch-up: the throttle then holds the front at its angle.
  await page.evaluate(() => window.__sp95.popWheelie());
  await waitFor(() => window.__sp95.bikeState.pitchDeg > 40, 20_000);
  console.log('held', await page.evaluate(() => window.__sp95.bikeState.pitchDeg.toFixed(0)));

  // Second one pushes past the hold into the bavette: the tail scrapes.
  await page.evaluate(() => window.__sp95.popWheelie());
  const scraped = await waitFor(() => window.__sp95.sparks > 12, 20_000);
  const side = await page.evaluate(() => window.__sp95.position);
  await page.evaluate((p) => window.__sp95.setCamera(p.x + 4.2, p.y + 0.25, p.z - 0.3, p.x, p.y - 0.1, p.z), side);
  await page.waitForTimeout(120);
  await page.screenshot({ path: 'artifacts/bike-bavette.png' });
  await page.evaluate(() => window.__sp95.clearCamera());
  console.log('bavette', scraped, await page.evaluate(() => ({
    pitch: window.__sp95.bikeState.pitchDeg.toFixed(0),
    sparks: window.__sp95.sparks,
    pending: Math.round(window.__sp95.stuntPending),
  })));

  // The brake is the only way back from there.
  await page.keyboard.up('KeyW');
  await page.keyboard.down('KeyS');
  await waitFor(() => window.__sp95.bikeState.pitchDeg < 8, 25_000);
  await page.keyboard.up('KeyS');
  await page.waitForTimeout(1200);
  console.log('banked', await page.evaluate(() => ({
    total: window.__sp95.stuntTotal,
    panel: document.getElementById('stunt-label').textContent,
  })));
  console.log('errors', errors.slice(0, 6));
} catch (error) {
  console.error('SHOT ERROR', error);
} finally {
  await browser.close();
}
