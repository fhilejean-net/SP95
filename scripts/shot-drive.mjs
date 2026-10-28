import { chromium } from 'playwright';

// Roulage scripté avec captures : la voiture doit rester posée sur l'asphalte
// là où la piste monte, et la hauteur doit suivre le tracé.
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
page.setDefaultTimeout(240_000);
const ys = [];
try {
  await page.goto('http://127.0.0.1:3000/?map=suzuka&fx=full', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__sp95?.ready === true, null, { timeout: 180_000 });
  await page.click('#btn-free');
  await page.waitForTimeout(2500);
  const p = await page.evaluate(() => window.__sp95.position);
  await page.evaluate(([x, y, z]) => window.__sp95.setCamera(x + 6, y + 3, z + 9, x, y + 0.4, z), [p.x, p.y, p.z]);
  await page.waitForTimeout(1800);
  await page.screenshot({ path: 'artifacts/drive-0.png' });

  await page.keyboard.down('w');
  for (let i = 0; i < 7; i++) {
    await page.waitForTimeout(2000);
    ys.push(await page.evaluate(() => +window.__sp95.position.y.toFixed(2)));
    if (i === 2) await page.screenshot({ path: 'artifacts/drive-1.png' });
  }
  await page.keyboard.up('w');
  await page.screenshot({ path: 'artifacts/drive-2.png' });
  console.log('YS', JSON.stringify(ys));
} catch (error) {
  console.error('SHOTDRIVE ERROR', error);
} finally {
  await browser.close();
}
