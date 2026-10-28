import { chromium } from 'playwright';

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.setDefaultTimeout(180_000);
const errors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(msg.text());
});
page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

try {
  await page.goto('http://127.0.0.1:3000/?map=sp95&fx=low', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__sp95?.ready === true, null, { timeout: 180_000 });
  console.log('map', await page.evaluate(() => window.__sp95.map));
  await page.screenshot({ path: 'artifacts/flat-menu.png' });

  await page.click('#btn-free');
  await page.waitForTimeout(2200);
  await page.screenshot({ path: 'artifacts/flat-start.png' });
  console.log('pose', await page.evaluate(() => window.__sp95.position));

  // Vue haute : la piste entière, et le sol autour.
  const p = await page.evaluate(() => window.__sp95.position);
  await page.evaluate((pos) => {
    window.__sp95.setCamera(pos.x + 210, 230, pos.z + 150, pos.x + 40, 0, pos.z - 230);
  }, p);
  await page.waitForTimeout(1400);
  await page.screenshot({ path: 'artifacts/flat-overview.png' });

  // En piste : on roule tout droit puis on prend le premier virage.
  await page.evaluate(() => window.__sp95.clearCamera());
  await page.keyboard.down('KeyW');
  const ys = [];
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(400);
    ys.push(await page.evaluate(() => ({
      y: Number(window.__sp95.position.y.toFixed(2)),
      speed: Math.round(window.__sp95.speedKmh),
      x: Math.round(window.__sp95.position.x),
      z: Math.round(window.__sp95.position.z),
    })));
  }
  await page.keyboard.up('KeyW');
  console.log('run', JSON.stringify(ys));
  await page.screenshot({ path: 'artifacts/flat-drive.png' });

  // Collisions : on fonce dans le mur intérieur.
  await page.evaluate(() => window.__sp95.teleport(190, -20, 0));
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(3500);
  await page.keyboard.up('KeyW');
  console.log('wall', await page.evaluate(() => ({
    speed: Math.round(window.__sp95.speedKmh),
    y: Number(window.__sp95.position.y.toFixed(2)),
    x: Math.round(window.__sp95.position.x),
    z: Math.round(window.__sp95.position.z),
  })));
  await page.screenshot({ path: 'artifacts/flat-wall.png' });

  console.log('errors', errors.slice(0, 8));
} catch (error) {
  console.error('SHOT ERROR', error);
} finally {
  await browser.close();
}
