import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto('http://127.0.0.1:3000/?fx=low', { waitUntil: 'load' });
await page.waitForFunction(() => window.__sp95?.ready === true, null, { timeout: 120000 });
await page.waitForTimeout(2500);
await page.screenshot({ path: 'artifacts/menu-bike.png' });
console.log(await page.evaluate(() => ({
  moto: Boolean(document.getElementById('btn-moto')),
  overflow: document.querySelector('.menu-card').scrollHeight > document.querySelector('.menu-card').clientHeight,
})));
await browser.close();
