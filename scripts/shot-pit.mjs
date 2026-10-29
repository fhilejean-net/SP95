/**
 * Captures de contrôle des stands et du panneau des secteurs.
 *
 *   node scripts/shot-pit.mjs
 */
import { chromium } from 'playwright';

const URL = process.env.SP95_URL ?? 'http://127.0.0.1:3000/?map=sp95&fx=low&fps=20';

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1024, height: 576 } });
page.setDefaultNavigationTimeout(240_000);
page.on('pageerror', (error) => console.log(`pageerror: ${error.message}`));
page.on('console', (message) => {
  const text = message.text();
  if (message.type() === 'error') console.log(`console error: ${text}`);
  else if (/Stands|Circuit|prop/i.test(text)) console.log(`log: ${text}`);
});

await page.goto(URL, { waitUntil: 'load', timeout: 240_000 });
await page.waitForFunction(() => window.__sp95?.ready === true, null, { timeout: 300_000 });
await page.evaluate(() => window.__sp95.startFree());
await page.waitForTimeout(900);

// 1. Depuis la voie, face aux garages : on doit voir les boxes ouverts et
//    l'outillage à l'intérieur.
await page.evaluate(() => window.__sp95.teleport(-21.4, -430, Math.PI / 2));
await page.waitForTimeout(1400);
await page.screenshot({ path: 'artifacts/pit-boxes.png', timeout: 120_000 });

// 2. Le long de la voie, vers la sortie.
await page.evaluate(() => window.__sp95.teleport(-24.2, -505, Math.PI));
await page.waitForTimeout(1400);
await page.screenshot({ path: 'artifacts/pit-lane.png', timeout: 120_000 });

// 3. Le raccordement, vu depuis la piste en direction de la voie.
await page.evaluate(() => window.__sp95.teleport(-14, -510, Math.PI / 2));
await page.waitForTimeout(4000);
await page.screenshot({ path: 'artifacts/pit-entry.png', timeout: 120_000 });

// 4. Le chrono : franchir la ligne lance le tour et les secteurs.
await page.evaluate(() => window.__sp95.teleport(0, -552, Math.PI));
await page.waitForTimeout(4000);
await page.keyboard.down('ArrowUp');
await page.waitForTimeout(14_000);
await page.keyboard.up('ArrowUp');
await page.waitForTimeout(1500);
await page.screenshot({ path: 'artifacts/sectors.png', timeout: 120_000 });
const state = await page.evaluate(() => ({
  chrono: window.__sp95.timedLap,
  panel: document.getElementById('sector-panel')?.className,
  rows: [1, 2, 3].map((index) => {
    const row = document.getElementById(`sector-row-${index}`);
    return row?.textContent?.replace(/\s+/g, ' ').trim();
  }),
  speed: window.__sp95.speedKmh,
}));
console.log(JSON.stringify(state));

await browser.close();
