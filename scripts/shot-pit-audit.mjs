/**
 * Captures de contrôle : portique, voie des stands, aire de gymkhana.
 *   node scripts/shot-pit-audit.mjs [prefix]
 */
import { chromium } from 'playwright';

const PREFIX = process.argv[2] ?? 'audit';
const URL = process.env.SP95_URL ?? 'http://127.0.0.1:3000/?map=sp95&fx=low&fps=20';

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.setDefaultNavigationTimeout(240_000);
page.on('pageerror', (error) => console.log(`pageerror: ${error.message}`));

await page.goto(URL, { waitUntil: 'load', timeout: 240_000 });
await page.waitForFunction(() => window.__sp95?.ready === true, null, { timeout: 300_000 });
await page.evaluate(() => window.__sp95.startFree());
await page.waitForTimeout(900);

const shots = [
  ['gantry', 0, -640, Math.PI],
  ['gantry-back', 0, -480, 0],
  ['pad', 40, -420, -Math.PI / 2],
  ['paddock', -30, -300, 0],
];

for (const [name, x, z, heading] of shots) {
  await page.evaluate(([tx, tz, th]) => window.__sp95.teleport(tx, tz, th), [x, z, heading]);
  await page.waitForTimeout(1400);
  await page.screenshot({ path: `artifacts/${PREFIX}-${name}.png`, timeout: 120_000 });
  console.log(`shot ${name}`);
}

await browser.close();
