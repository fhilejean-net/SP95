import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 900, height: 640 } });
page.setDefaultTimeout(180000);
try {
  await page.goto('http://127.0.0.1:3000/?fx=low', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__sp95?.ready === true, null, { timeout: 120000 });
  await page.click('#btn-moto');
  await page.waitForFunction(() => window.__sp95.vehicleKind === 'bike', null, { timeout: 20000 });
  await page.waitForTimeout(3000);
  const shots = [
    ['side', [2.6, 1.0, 0.0], [0, 0.85, 0]],
    ['front', [1.5, 1.25, -2.2], [0, 0.95, 0]],
    ['rear', [-1.4, 1.35, 2.4], [0, 0.9, 0]],
  ];
  for (const [name, off, look] of shots) {
    await page.evaluate(([o, l]) => {
      const p = window.__sp95.position;
      window.__sp95.setCamera(p.x + o[0], p.y + o[1], p.z + o[2], p.x + l[0], p.y + l[1], p.z + l[2]);
    }, [off, look]);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `artifacts/rider-bike-${name}.png` });
  }
  console.log('ok');
} catch (e) { console.error(e.message); } finally { await browser.close(); }
