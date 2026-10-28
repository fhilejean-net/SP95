/**
 * Tour de piste au volant : capture l'écran tous les 3 s en roulant depuis la
 * ligne des stands, treillis de collision affiché, puis prend le premier virage
 * à gauche.
 *
 *   node scripts/tmp-track-tour.mjs
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.setDefaultNavigationTimeout(240_000);
page.on('pageerror', (error) => console.log(`pageerror: ${error.message}`));

await page.goto('http://127.0.0.1:3000/?map=suzuka&fx=low&collide', {
  waitUntil: 'load',
  timeout: 240_000,
});
await page.waitForFunction(() => window.__sp95?.ready === true, null, { timeout: 300_000 });
await page.evaluate(() => window.__sp95.startFree());
await page.waitForTimeout(600);
await page.keyboard.down('KeyW');

for (let i = 0; i < 12; i++) {
  // Le premier virage est un gauche : on braque à partir de la neuvième capture.
  if (i === 9) await page.keyboard.down('KeyA');
  await page.waitForTimeout(3000);
  const state = await page.evaluate(() => ({
    speed: Number(window.__sp95.speedKmh.toFixed(0)),
    x: Number(window.__sp95.position.x.toFixed(0)),
    y: Number(window.__sp95.position.y.toFixed(1)),
    z: Number(window.__sp95.position.z.toFixed(0)),
    contacts: window.__sp95.wheels.filter((wheel) => wheel.contact).length,
    loads: window.__sp95.wheels.map((wheel) => Math.round(wheel.load)),
  }));
  console.log(`t${i}`, JSON.stringify(state));
  await page.screenshot({ path: `artifacts/tour-${i}.png` });
}
await page.keyboard.up('KeyA');
await page.keyboard.up('KeyW');
await page.evaluate(() => window.__sp95.setCollisionView(false));
await page.waitForTimeout(700);
await page.screenshot({ path: 'artifacts/tour-clean.png' });
await browser.close();
