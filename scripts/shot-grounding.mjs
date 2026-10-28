import { chromium } from 'playwright';

// Deux angles sur la voiture posée : de trois quarts arrière puis au ras de
// l'asphalte, pour juger l'ombre de contact et le reflet.
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 560 } });
page.setDefaultTimeout(240_000);
try {
  await page.goto('http://127.0.0.1:3000/?map=suzuka&fx=full', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__sp95?.ready === true, null, { timeout: 180_000 });
  await page.click('#btn-free');
  await page.waitForTimeout(3500);
  const p = await page.evaluate(() => window.__sp95.position);
  await page.evaluate(([x, y, z]) => window.__sp95.setCamera(x + 5.5, y + 2.1, z + 6.5, x, y + 0.4, z), [p.x, p.y, p.z]);
  await page.waitForTimeout(2400);
  await page.screenshot({ path: 'artifacts/grounding-behind.png' });
  await page.evaluate(([x, y, z]) => window.__sp95.setCamera(x - 4.2, y + 1.05, z - 5.2, x, y + 0.45, z), [p.x, p.y, p.z]);
  await page.waitForTimeout(2400);
  await page.screenshot({ path: 'artifacts/grounding-low.png' });
  console.log('PERF', JSON.stringify(await page.evaluate(() => ({ calls: window.__sp95.debug.drawCalls, tris: window.__sp95.debug.triangles }))));
} catch (error) {
  console.error('SHOT ERROR', error);
} finally {
  await browser.close();
}
