import { chromium } from 'playwright';

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1000, height: 620 } });
page.setDefaultTimeout(180_000);
try {
  await page.goto('http://127.0.0.1:3000/?fx=low', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__sp95?.ready === true, null, { timeout: 120_000 });
  await page.click('#btn-moto');
  await page.waitForFunction(() => window.__sp95.vehicleKind === 'bike', null, { timeout: 20_000 });
  await page.evaluate(() => window.__sp95.teleport(-60, 40, 0));
  await page.waitForTimeout(3000);
  await page.evaluate(() => {
    const p = window.__sp95.position;
    window.__sp95.setCamera(p.x + 10, p.y + 6, p.z + 16, p.x, p.y + 1, p.z - 30);
  });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'artifacts/veg-road.png' });

  await page.evaluate(() => {
    const p = window.__sp95.position;
    window.__sp95.setCamera(p.x, p.y + 60, p.z + 90, p.x, p.y, p.z - 60);
  });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'artifacts/veg-wide.png' });
  console.log('ok');
} catch (error) {
  console.error(error);
} finally {
  await browser.close();
}
