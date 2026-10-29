// Captures ciblées : portique, ligne des stands, bac à gravier, panneaux du mur.
import { chromium } from 'playwright';
import { TRACK, cornerRadius, WALL_OFFSET } from '../src/world/trackLayout.ts';

const samples = TRACK.samples;
const right = (s) => ({ x: -s.tz, z: s.tx });

// Virage le plus serré (bac à gravier) et virage moyen.
let tight = samples[0];
let tightIndex = 0;
for (let i = 0; i < samples.length; i++) {
  if (cornerRadius(samples[i]) < cornerRadius(tight)) {
    tight = samples[i];
    tightIndex = i;
  }
}
const outside = tight.curvature > 0 ? -1 : 1;

const start = samples[0];
const startRight = right(start);
const beam = { x: start.x + start.tx * 8, z: start.z + start.tz * 8 };

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

const look = async (name, px, py, pz, tx, ty, tz, wait = 1200) => {
  await page.evaluate(
    ([p, t]) => window.__sp95.setCamera(p[0], p[1], p[2], t[0], t[1], t[2]),
    [[px, py, pz], [tx, ty, tz]],
  );
  await page.waitForTimeout(wait);
  await page.screenshot({ path: `artifacts/${name}.png` });
  console.log('shot', name);
};

try {
  await page.goto('http://127.0.0.1:3000/?map=sp95&fx=low', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__sp95?.ready === true, null, { timeout: 180_000 });
  await page.click('#btn-free');
  await page.waitForTimeout(2000);

  // 1. Portique, de trois quarts arrière.
  await look(
    'detail-gantry',
    beam.x - start.tx * 34 - startRight.x * 16,
    5.5,
    beam.z - start.tz * 34 - startRight.z * 16,
    beam.x,
    6.6,
    beam.z,
  );
  // 2. Portique de face, sous la poutre.
  await look('detail-gantry-face', beam.x, 2.4, beam.z + 26, beam.x, 5.6, beam.z);

  // 3. Ligne des stands : vue plongeante sur la voie et les garages.
  await look('detail-pitlane', -6, 14, -360, -26, 1, -420);
  // 4. Les stands vus du cockpit, au niveau de la voie.
  await look('detail-pitlane-low', -8, 2.2, -300, -22, 2.4, -420);

  // 5. Bac à gravier du virage le plus serré, vu de l'extérieur.
  const g = {
    x: tight.x + startRight.x * WALL_OFFSET * outside,
    z: tight.z + startRight.z * WALL_OFFSET * outside,
  };
  await look(
    'detail-gravel',
    g.x + startRight.x * 22 * outside - tight.tx * 30,
    16,
    g.z + startRight.z * 22 * outside - tight.tz * 30,
    tight.x + startRight.x * 10 * outside,
    0,
    tight.z + startRight.z * 10 * outside,
  );

  // 6. Panneaux du mur : rasants, comme en roulant.
  const p = samples[Math.floor(samples.length * 0.72)];
  const pr = right(p);
  await look(
    'detail-boards',
    p.x - pr.x * WALL_OFFSET + p.tx * 26,
    1.3,
    p.z - pr.z * WALL_OFFSET + p.tz * 26,
    p.x - pr.x * WALL_OFFSET,
    1.6,
    p.z - pr.z * WALL_OFFSET,
  );

  // 7. Depuis la voiture, sur la ligne droite des stands.
  await page.evaluate(() => window.__sp95.clearCamera());
  await page.evaluate(([x, z, h]) => window.__sp95.teleport(x, z, h), [start.x, start.z, TRACK.spawn.heading]);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: 'artifacts/detail-cockpit.png' });

  console.log('tight corner at index', tightIndex, 'radius', cornerRadius(tight).toFixed(1));
  console.log('errors', errors.slice(0, 8));
} catch (error) {
  console.error('SHOT ERROR', error);
} finally {
  await browser.close();
}
