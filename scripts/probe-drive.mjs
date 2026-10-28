import { chromium } from 'playwright';

// Conduite scriptée sur Suzuka : chute à travers la piste, et cadence en début
// puis en fin de session (une fuite ou une passe qui s'accumule se voit là).
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 700, height: 440 } });
page.setDefaultTimeout(240_000);
const samples = [];
try {
  await page.goto('http://127.0.0.1:3000/?map=suzuka&fx=full', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__sp95?.ready === true, null, { timeout: 180_000 });
  await page.click('#btn-free');
  await page.waitForTimeout(2500);
  await page.keyboard.down('w');
  for (let i = 0; i < 60; i++) {
    if (i === 18) await page.keyboard.down('d');
    if (i === 26) await page.keyboard.up('d');
    if (i === 30) await page.keyboard.down('a');
    if (i === 40) await page.keyboard.up('a');
    await page.waitForTimeout(400);
    samples.push(
      await page.evaluate(() => ({
        y: window.__sp95.position.y,
        fps: window.__sp95.debug.fps,
        calls: window.__sp95.debug.drawCalls,
        tris: window.__sp95.debug.triangles,
      })),
    );
  }
  await page.keyboard.up('w');
  const ys = samples.map((s) => s.y);
  let drops = 0;
  for (let i = 1; i < ys.length; i++) if (ys[i] < ys[i - 1] - 2) drops++;
  const half = Math.floor(samples.length / 2);
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  console.log(
    JSON.stringify(
      {
        drops,
        minY: +Math.min(...ys).toFixed(1),
        maxY: +Math.max(...ys).toFixed(1),
        fpsFirst: +mean(samples.slice(0, half).map((s) => s.fps)).toFixed(1),
        fpsLast: +mean(samples.slice(half).map((s) => s.fps)).toFixed(1),
        calls: samples.at(-1).calls,
        tris: samples.at(-1).tris,
        tail: samples.slice(-5).map((s) => `${s.y.toFixed(1)}@${s.fps.toFixed(0)}`),
      },
      null,
      1,
    ),
  );
} catch (error) {
  console.error('DRIVE ERROR', error);
} finally {
  await browser.close();
}
