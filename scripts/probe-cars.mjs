/**
 * Sonde du parc automobile : elle charge chaque voiture du registre, relève les
 * roues trouvées et leurs cotes, prend une capture de trois-quarts avant, fait
 * tourner les roues au gaz, ouvre le showroom, puis vérifie le chrono de Suzuka.
 *
 *   npm run dev            # dans un autre shell
 *   node scripts/probe-cars.mjs
 *   SP95_CARS=787b,911 node scripts/probe-cars.mjs   # une sélection
 *
 * Sur une machine sans les bibliothèques de Chromium, lancer avec
 * `LD_LIBRARY_PATH` pointant sur des copies locales de libnss3, libnspr4…
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const URL = process.env.SP95_URL ?? 'http://127.0.0.1:3000/?fx=low';
const TRACK_URL = process.env.SP95_TRACK_URL ?? 'http://127.0.0.1:3000/?map=suzuka&fx=low';
const SHOTS = (process.env.SP95_CARS ?? 'gt40,911,trueno,fk8,yaris,rs7,apollo').split(',');

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const logs = [];
page.on('console', (message) => logs.push(`${message.type()}: ${message.text()}`));
page.on('pageerror', (error) => logs.push(`pageerror: ${error.message}`));

mkdirSync('artifacts', { recursive: true });

const shot = async (name, timeout = 150_000) => {
  // Le rendu logiciel met parfois une minute à finir une image : une capture
  // qui traîne ne doit pas emporter la sonde avec elle.
  try {
    await page.screenshot({ path: `artifacts/${name}.png`, timeout });
    console.log(`  capture artifacts/${name}.png`);
  } catch (error) {
    console.log(`  capture ${name} ratée (${error.message.split('\n')[0]})`);
  }
};

const load = async (id) => {
  await page.evaluate((carId) => window.__sp95.setCar(carId), id);
  const ok = await page
    .waitForFunction(
      (carId) => window.__sp95.car === carId && window.__sp95.carModel === true,
      id,
      { timeout: 120_000 },
    )
    .then(() => true)
    .catch(() => false);
  await page.waitForTimeout(300);
  return ok;
};

const phase = async (label, run) => {
  try {
    await run();
  } catch (error) {
    console.log(`PHASE ${label} ÉCHOUÉE : ${error.message.split('\n')[0]}`);
  }
};

await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => window.__sp95?.ready === true, null, { timeout: 180_000 });

const ids = await page.evaluate(() => window.__sp95.cars);
console.log(`registre : ${ids.join(', ')} (${ids.length})`);

await phase('cotes', async () => {
  for (const id of ids) {
    const before = logs.length;
    const ok = await load(id);
    const state = await page.evaluate(() => ({
      car: window.__sp95.car,
      spec: window.__sp95.spec,
      mounts: window.__sp95.wheelMounts,
      spin: window.__sp95.wheelSpin,
    }));
    const fresh = logs.slice(before);
    const detected = (fresh.find((line) => line.includes('roues détectées')) ?? '(roues nommées)')
      .replace(/^log: /, '')
      .replace(`${id}: `, '');
    const errors = fresh.filter(
      (line) =>
        (line.startsWith('error') || line.startsWith('pageerror')) && !line.includes('favicon'),
    );
    const wheelbase = Math.abs(state.mounts[0].z - state.mounts[2].z);
    const track = Math.abs(state.mounts[0].x - state.mounts[1].x);
    const offCenter = Math.abs(state.mounts[0].z + state.mounts[1].z) / 2;
    console.log(
      `${ok ? 'OK  ' : 'FAIL'} ${id.padEnd(10)} ` +
        `empattement ${wheelbase.toFixed(2)} m (attendu ${state.spec.wheelbase.toFixed(2)}) · ` +
        `voie ${track.toFixed(2)} m (${state.spec.track.toFixed(2)}) · ` +
        `hors axe ${offCenter.toFixed(2)} m · ${state.spec.name}\n` +
        `     ${detected}` +
        (errors.length ? `\n     ERREURS ${errors.join(' | ')}` : ''),
    );
  }
});

await phase('captures', async () => {
  for (const id of SHOTS) {
    if (!ids.includes(id)) continue;
    if (!(await load(id))) {
      console.log(`  ${id} : pas de modèle, capture sautée`);
      continue;
    }
    await page.evaluate(() => window.__sp95.startFree());
    await page.waitForTimeout(500);
    // Trois-quarts avant : le nez du jeu regarde vers -Z, la caméra se place
    // donc devant à gauche, à hauteur de capot.
    await page.evaluate(() => {
      const p = window.__sp95.position;
      window.__sp95.setCamera(p.x - 5.4, p.y + 1.6, p.z - 5.4, p.x, p.y + 0.5, p.z);
    });
    await page.waitForTimeout(900);
    await shot(`car-${id}`);
  }
  await page.evaluate(() => window.__sp95.clearCamera());
});

await phase('roues qui tournent', async () => {
  if (!(await load('aventador'))) return;
  await page.evaluate(() => window.__sp95.startFree());
  await page.waitForTimeout(400);
  const before = await page.evaluate(() => window.__sp95.wheelSpin);
  await page.keyboard.down('ArrowUp');
  await page.waitForTimeout(3000);
  const after = await page.evaluate(() => window.__sp95.wheelSpin);
  const speed = await page.evaluate(() => window.__sp95.speedKmh);
  await page.keyboard.up('ArrowUp');
  const turned = after.map((value, index) => Math.abs(value - (before[index] ?? 0)));
  console.log(
    `rotation après 3 s de gaz (${speed.toFixed(0)} km/h) : ` +
      turned.map((value) => value.toFixed(1)).join(' / ') +
      ` → ${turned.some((value) => value > 0.5) ? 'OK' : 'FAIL'}`,
  );
});

await phase('showroom', async () => {
  await page.evaluate(() => window.__sp95.openShowroom());
  await page.waitForTimeout(900);
  const state = await page.evaluate(() => ({
    open: window.__sp95.showroomOpen,
    cards: document.querySelectorAll('#showroom-list .car-card').length,
    stats: document.querySelectorAll('.car-stat').length,
    name: document.querySelector('.showroom-name')?.textContent ?? '',
    drive: document.querySelector('#btn-showroom-drive')?.textContent ?? '',
    pick: document.querySelector('#btn-showroom-pick')?.textContent ?? '',
  }));
  console.log(
    `showroom : ${state.open ? 'ouvert' : 'FERMÉ'} · ${state.cards} cartes · ${state.stats} lignes de stats\n` +
      `     fiche « ${state.name} » · bouton « ${state.drive} » / « ${state.pick} »`,
  );
  await shot('showroom');
  await page.evaluate(() => {
    document.querySelector('#showroom-list .car-card[data-car="apollo"]')?.click();
  });
  await page.waitForTimeout(3000);
  const swapped = await page.evaluate(() => ({
    car: window.__sp95.car,
    name: document.querySelector('.showroom-name')?.textContent ?? '',
  }));
  console.log(`     clic sur la carte Apollo → ${swapped.car}, fiche « ${swapped.name} »`);
  await shot('showroom-apollo');
  await page.evaluate(() => document.getElementById('btn-showroom-close')?.click());
});

await phase('chrono Suzuka', async () => {
  await page.goto(TRACK_URL, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__sp95?.ready === true, null, { timeout: 240_000 });
  await page.evaluate(() => window.__sp95.startFree());
  await page.waitForTimeout(600);
  const before = await page.evaluate(() => ({
    timed: window.__sp95.timedLap,
    chrono: window.__sp95.chrono,
    hud: document.getElementById('race-panel')?.classList.contains('hidden'),
  }));
  await page.keyboard.down('ArrowUp');
  await page.waitForTimeout(14_000);
  await page.keyboard.up('ArrowUp');
  const after = await page.evaluate(() => ({
    speed: window.__sp95.speedKmh,
    chrono: window.__sp95.chrono,
    lap: document.getElementById('race-lap')?.textContent,
    time: document.getElementById('race-time')?.textContent,
    best: document.getElementById('race-best')?.textContent,
  }));
  console.log(
    `chrono : session ${before.timed ? 'chronométrée' : 'PAS chronométrée'} · panneau ` +
      `${before.hud ? 'caché' : 'visible'} · ligne franchie ${before.chrono?.armed} → ` +
      `${after.chrono?.armed} · tour ${after.chrono?.lap} en ${after.chrono?.current?.toFixed(2)} s ` +
      `(HUD ${after.lap} · ${after.time} · ${after.best}) à ${after.speed.toFixed(0)} km/h`,
  );
  await shot('chrono');
});

const errors = logs.filter(
  (line) => (line.startsWith('error') || line.startsWith('pageerror')) && !line.includes('favicon'),
);
console.log(errors.length ? `ERREURS CONSOLE :\n${errors.slice(0, 8).join('\n')}` : 'aucune erreur console');

await browser.close();
