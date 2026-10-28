import { chromium } from 'playwright';

// Coût de la passe d'ombre du soleil, mesurée sur les compteurs du moteur.
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 700, height: 440 } });
page.setDefaultTimeout(240_000);
try {
  await page.goto('http://127.0.0.1:3000/?map=suzuka&fx=full', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__sp95?.ready === true, null, { timeout: 180_000 });
  await page.click('#btn-free');
  await page.waitForTimeout(4000);
  const on = await page.evaluate(() => window.__sp95.debug);
  await page.evaluate(() => window.__sp95.debug.setShadows(false));
  await page.waitForTimeout(2500);
  const off = await page.evaluate(() => window.__sp95.debug);
  console.log('SHADOW-ON ', JSON.stringify({ calls: on.drawCalls, tris: on.triangles, casting: on.shadow.casting }));
  console.log('SHADOW-OFF', JSON.stringify({ calls: off.drawCalls, tris: off.triangles }));
  console.log('CANVAS', await page.evaluate(() => `${document.querySelector('canvas').width}x${document.querySelector('canvas').height} dpr=${devicePixelRatio}`));
} catch (e) {
  console.error('COST ERROR', e);
} finally {
  await browser.close();
}
