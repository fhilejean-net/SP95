/**
 * Capture des panneaux de freinage : contrôle de la séquence 150/100/50 m, puis
 * comparaison côte à côte des chevrons d'un virage à gauche et d'un virage à
 * droite, sans que nombre ni unité ne soient retournés.
 *
 *   node --experimental-strip-types scripts/shot-braking.mjs
 */
import { chromium } from 'playwright';
import { brakingMarkers, sampleAtDistance } from '../src/world/brakingMarkers.ts';

const URL = process.env.SP95_URL ?? 'http://127.0.0.1:3000/?map=sp95&fx=low';
const markers = brakingMarkers();
const board150 = markers.find((marker) => marker.value === 150);
if (!board150) throw new Error('aucun panneau 150 m dans le plan');

const behind = sampleAtDistance(board150.distance - 9);
const aim = sampleAtDistance(board150.distance + 104);
const heading = Math.atan2(-behind.tx, -behind.tz);

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
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__sp95?.ready === true, null, { timeout: 180_000 });
  await page.click('#btn-free');
  await page.waitForTimeout(1600);
  await page.evaluate(
    ([x, z, h]) => window.__sp95.teleport(x, z, h),
    [behind.x, behind.z, heading],
  );
  await page.waitForTimeout(1200);

  // Vue conducteur : la planche 150 au premier plan, les deux suivantes derrière.
  await page.evaluate(
    ([px, py, pz, tx, ty, tz]) => window.__sp95.setCamera(px, py, pz, tx, ty, tz),
    [behind.x, 2.6, behind.z, aim.x, 1.1, aim.z],
  );
  await page.waitForTimeout(1400);
  await page.screenshot({ path: 'artifacts/braking-markers.png' });

  // Vue en enfilade, dans l'axe : les trois annonces et les deux côtés de la
  // piste tiennent dans le même cadre.
  const wide = sampleAtDistance(board150.distance - 26);
  const target = sampleAtDistance(board150.distance + 62);
  await page.evaluate(
    ([px, py, pz, tx, ty, tz]) => window.__sp95.setCamera(px, py, pz, tx, ty, tz),
    [wide.x, 4.2, wide.z, target.x, 0.9, target.z],
  );
  await page.waitForTimeout(1400);
  await page.screenshot({ path: 'artifacts/braking-markers-wide.png' });

  // Planche de contrôle des deux signes : un virage à gauche et un à droite,
  // cadrés à la même échelle pour comparer les chevrons sans retourner le texte.
  const directionExamples = [
    {
      label: 'Virage à gauche · 150 m',
      marker: markers.find((marker) => marker.value === 150 && marker.direction === -1 && marker.side === -1),
    },
    {
      label: 'Virage à droite · 100 m',
      marker: markers.find((marker) => marker.value === 100 && marker.direction === 1 && marker.side === -1),
    },
  ];
  const closeups = [];
  for (const example of directionExamples) {
    const board = example.marker;
    if (!board) throw new Error(`panneau introuvable pour ${example.label}`);
    await page.evaluate(
      ([px, py, pz, tx, ty, tz]) => window.__sp95.setCamera(px, py, pz, tx, ty, tz),
      [
        board.x + board.fx * 7.5,
        1.9,
        board.z + board.fz * 7.5,
        board.x,
        1.12,
        board.z,
      ],
    );
    await page.waitForTimeout(1200);
    const shot = await page.screenshot();
    closeups.push({ label: example.label, data: shot.toString('base64') });
  }
  if (closeups.length === directionExamples.length) {
    const strip = await browser.newPage({ viewport: { width: 1290, height: 420 } });
    await strip.setContent(
      `<body style="margin:0;background:#0d0f12;display:flex;gap:8px;padding:10px;font:600 22px system-ui;color:#e8e6df">` +
        closeups
          .map(
            (entry) =>
              `<figure style="margin:0;flex:1"><img src="data:image/png;base64,${entry.data}" style="width:100%;display:block;border-radius:4px"><figcaption style="padding:6px 2px">${entry.label}</figcaption></figure>`,
          )
          .join('') +
        '</body>',
    );
    await strip.screenshot({ path: 'artifacts/braking-directions-strip.png' });
    await strip.close();
  }

  console.log('panneaux', markers.length, '· premier 150 m à', behind.x.toFixed(0), behind.z.toFixed(0));
  console.log('errors', errors.slice(0, 6));
} catch (error) {
  console.error('SHOT ERROR', error);
} finally {
  await browser.close();
}
