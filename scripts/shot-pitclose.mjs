// Vues rapprochées : marquage de la voie des stands, bord du bac à gravier.
import { chromium } from 'playwright';
import { TRACK, cornerRadius, WALL_OFFSET } from '../src/world/trackLayout.ts';

const samples = TRACK.samples;
const right = (s) => ({ x: -s.tz, z: s.tx });
let tight = samples[0];
for (const sample of samples) if (cornerRadius(sample) < cornerRadius(tight)) tight = sample;
const outside = tight.curvature > 0 ? -1 : 1;

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.setDefaultTimeout(180_000);
const errors = [];
page.on('pageerror', (err) => errors.push(err.message));

const look = async (name, p, t, wait = 1200) => {
  await page.evaluate(
    ([pos, target]) => window.__sp95.setCamera(pos[0], pos[1], pos[2], target[0], target[1], target[2]),
    [p, t],
  );
  await page.waitForTimeout(wait);
  await page.screenshot({ path: `artifacts/${name}.png` });
  console.log('shot', name);
};

try {
  await page.goto('http://127.0.0.1:3000/?map=sp95&fx=low', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__sp95?.ready === true, null, { timeout: 180_000 });
  await page.click('#btn-free');
  await page.waitForTimeout(1800);

  const names = await page.evaluate(() => {
    const scene = window.__sp95three?.scene;
    const out = [];
    scene?.traverse?.((object) => {
      if (!object.name) return;
      if (/pit|gravel|sponsor|gantry/.test(object.name)) out.push(object.name);
    });
    return out;
  });
  console.log('meshes', names);

  // Marquage de la voie : rasante puis plongeante.
  await look('pit-paint', [-11.5, 2.4, -410], [-16.5, 0.3, -436]);
  await look('pit-top', [-13.2, 30, -398], [-13.2, 0, -400]);
  await look('pit-stall', [-12.6, 7.5, -466], [-15.4, 0, -474]);

  // Bord du bac à gravier, du dessus.
  const g = {
    x: tight.x + right(tight).x * WALL_OFFSET * outside,
    z: tight.z + right(tight).z * WALL_OFFSET * outside,
  };
  await look('gravel-top', [g.x, 14, g.z], [g.x, 0, g.z], 1400);
  await look('gravel-edge', [tight.x, 3.2, tight.z], [g.x, 0.4, g.z]);
} catch (error) {
  console.error('SHOT ERROR', error);
} finally {
  console.log('errors', errors.slice(0, 5));
  await browser.close();
}
