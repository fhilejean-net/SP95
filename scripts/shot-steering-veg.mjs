import { chromium } from 'playwright';

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 980, height: 620 } });
page.setDefaultTimeout(200000);
try {
  await page.goto('http://127.0.0.1:3000/?fx=low', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__sp95?.ready === true, null, { timeout: 120000 });
  await page.click('#btn-moto');
  await page.waitForFunction(() => window.__sp95.vehicleKind === 'bike', null, { timeout: 30000 });

  // Bar on full lock, seen from the front: fork lowers, clamps and cables.
  await page.keyboard.down('a');
  await page.waitForTimeout(9000);
  await page.evaluate(() => {
    const p = window.__sp95.position;
    window.__sp95.setCamera(p.x + 1.7, p.y + 1.25, p.z - 2.4, p.x, p.y + 0.9, p.z - 0.35);
  });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'artifacts/steer-left.png' });
  await page.keyboard.up('a');

  await page.keyboard.down('d');
  await page.waitForTimeout(9000);
  await page.evaluate(() => {
    const p = window.__sp95.position;
    window.__sp95.setCamera(p.x - 1.7, p.y + 1.25, p.z - 2.4, p.x, p.y + 0.9, p.z - 0.35);
  });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'artifacts/steer-right.png' });
  await page.keyboard.up('d');

  // Vegetation, out in the country.
  await page.evaluate(() => window.__sp95.clearCamera());
  await page.evaluate(() => window.__sp95.teleport(-430, -260, 0.8));
  await page.waitForTimeout(4000);
  await page.evaluate(() => {
    const p = window.__sp95.position;
    window.__sp95.setCamera(p.x + 4, p.y + 14, p.z + 22, p.x, p.y + 2, p.z - 40);
  });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: 'artifacts/veg-forest.png' });
  console.log('ok');
} catch (error) {
  console.error(error.message);
} finally {
  await browser.close();
}
