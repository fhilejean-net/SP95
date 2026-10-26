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

const waitFor = async (fn, timeout = 90_000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await page.evaluate(fn);
    if (value) return value;
    await page.waitForTimeout(250);
  }
  return null;
};

try {
  await page.goto('http://127.0.0.1:3000/?fx=low', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__sp95?.ready === true, null, { timeout: 120_000 });
  await page.click('#btn-moto');
  await page.waitForFunction(() => window.__sp95.vehicleKind === 'bike', null, { timeout: 20_000 });
  // The drift pad is a big flat slab with a clear run-up: the city spawn has
  // walls close enough that a 30 km/h turn finds one immediately.
  await page.evaluate(() => window.__sp95.teleport(176, 132, 0));
  await page.waitForTimeout(2500);
  console.log('boot', await page.evaluate(() => ({
    kind: window.__sp95.vehicleKind,
    state: window.__sp95.bikeState,
    hud: {
      stunt: !document.getElementById('stunt-panel').classList.contains('hidden'),
      tcs: document.getElementById('tcs-chip').classList.contains('hidden'),
      wheelie: !document.getElementById('wheelie-chip').classList.contains('hidden'),
    },
  })));

  await page.keyboard.down('KeyW');
  const fast = await waitFor(() => window.__sp95.speedKmh > 30);
  console.log('speed ok', Boolean(fast), await page.evaluate(() => window.__sp95.speedKmh.toFixed(0)));

  await page.keyboard.down('KeyA');
  const leaned = await waitFor(() => Math.abs(window.__sp95.bikeState.leanDeg) > 25, 15_000);
  console.log('lean', Boolean(leaned), await page.evaluate(() => ({
    state: window.__sp95.bikeState,
    speed: window.__sp95.speedKmh,
    wheels: window.__sp95.wheels,
    position: window.__sp95.position,
  })));
  await page.screenshot({ path: 'artifacts/bike-lean.png' });
  await page.keyboard.up('KeyA');
  await page.waitForTimeout(1200);

  const popped = await page.evaluate(() => ({
    ok: window.__sp95.popWheelie(),
    speed: window.__sp95.speedKmh,
    wheels: window.__sp95.wheels,
  }));
  console.log('pop', popped);
  const up = await waitFor(() => window.__sp95.bikeState.pitchDeg > 40);
  console.log('wheelie', Boolean(up), await page.evaluate(() => ({
    state: window.__sp95.bikeState,
    pending: window.__sp95.stuntPending,
    sparks: window.__sp95.sparks,
  })));
  await page.screenshot({ path: 'artifacts/bike-wheelie.png' });

  const deep = await waitFor(() => window.__sp95.bikeState.pitchDeg > 55, 25_000);
  console.log('deep', Boolean(deep), await page.evaluate(() => ({
    state: window.__sp95.bikeState,
    pending: window.__sp95.stuntPending,
    sparks: window.__sp95.sparks,
  })));
  await page.screenshot({ path: 'artifacts/bike-bavette.png' });

  await page.keyboard.up('KeyW');
  await page.keyboard.down('KeyS');
  const down = await waitFor(() => window.__sp95.bikeState.pitchDeg < 15, 30_000);
  console.log('brake down', Boolean(down), await page.evaluate(() => ({
    state: window.__sp95.bikeState,
    total: window.__sp95.stuntTotal,
  })));
  await page.keyboard.up('KeyS');

  // Back to a car through the garage.
  await page.evaluate(() => window.__sp95.setCar('aventador'));
  const car = await waitFor(() => window.__sp95.vehicleKind === 'car', 60_000);
  console.log('car back', Boolean(car), await page.evaluate(() => ({
    kind: window.__sp95.vehicleKind,
    car: window.__sp95.car,
    stuntPanelHidden: document.getElementById('stunt-panel').classList.contains('hidden'),
    driftHidden: document.getElementById('drift-total-wrap').classList.contains('hidden'),
  })));
  console.log('errors', errors.slice(0, 8));
} catch (error) {
  console.error('PROBE ERROR', error);
  console.log('errors', errors.slice(0, 10));
} finally {
  await browser.close();
}
