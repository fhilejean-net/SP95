import { chromium } from 'playwright';

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
try {
  await page.goto('http://127.0.0.1:3000/?fx=low', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__sp95?.ready === true, null, { timeout: 120_000 });
  await page.click('#btn-moto');
  await page.waitForFunction(() => window.__sp95.vehicleKind === 'bike', null, { timeout: 20_000 });
  await page.waitForTimeout(4000);
  await page.evaluate(() => {
    const p = window.__sp95.position;
    window.__sp95.setCamera(p.x + 3.4, p.y + 0.35, p.z + 2.2, p.x, p.y - 0.15, p.z);
  });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: 'artifacts/bike-three-quarter.png' });

  await page.evaluate(() => {
    const p = window.__sp95.position;
    window.__sp95.setCamera(p.x + 4.2, p.y + 0.1, p.z, p.x, p.y - 0.05, p.z);
  });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: 'artifacts/bike-profile.png' });
  console.log('ok');
} catch (error) {
  console.error(error);
} finally {
  await browser.close();
}
