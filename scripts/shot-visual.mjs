import { chromium } from 'playwright';

// Capture de contrôle du cycle "qualité visuelle" : voiture au sol, trois
// quarts arrière, qualité par défaut (ombres activées).
const out = process.argv[2] ?? 'artifacts/visual-baseline.png';
const query = process.argv[3] ?? '';

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.setDefaultTimeout(240_000);
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

try {
  await page.goto(`http://127.0.0.1:3000/?${query}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__sp95?.ready === true, null, { timeout: 180_000 });
  await page.click('#btn-free');
  await page.waitForFunction(() => window.__sp95.mode !== null, null, { timeout: 60_000 });
  await page.waitForTimeout(4000);
  await page.evaluate(() => {
    const p = window.__sp95.position;
    window.__sp95.setCamera(p.x + 6.5, p.y + 2.4, p.z + 7.5, p.x, p.y + 0.6, p.z);
  });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: out });
  console.log('shot', out, JSON.stringify(await page.evaluate(() => ({
    ...window.__sp95.debug,
    pos: window.__sp95.position,
    map: window.__sp95.map,
  }))));
  console.log('errors', errors.slice(0, 8));
} catch (error) {
  console.error('SHOT ERROR', error);
} finally {
  await browser.close();
}
