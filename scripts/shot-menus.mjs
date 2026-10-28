import { chromium } from 'playwright';

// Contrôle visuel des deux écrans : pause et showroom. Mesure le débordement et
// le nombre de colonnes réellement calculées, pour ne pas juger à l'œil seul.
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1100, height: 720 } });
page.setDefaultTimeout(240_000);
const measure = (selector) =>
  page.evaluate((sel) => {
    const node = document.querySelector(sel);
    if (!node) return null;
    const box = node.getBoundingClientRect();
    return {
      w: Math.round(box.width),
      h: Math.round(box.height),
      overflow: node.scrollHeight > node.clientHeight + 2,
      insideViewport: box.top >= 0 && box.bottom <= window.innerHeight + 1 && box.left >= 0 && box.right <= window.innerWidth + 1,
    };
  }, selector);
try {
  // Le rendu logiciel tourne à 2 fps : sans ça la capture tombe sur la
  // première image de l'animation d'apparition (opacité 0).
  await page.addStyleTag({ content: '* { animation: none !important; transition: none !important; }' });
  await page.goto('http://127.0.0.1:3000/?map=suzuka&fx=full', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__sp95?.ready === true, null, { timeout: 180_000 });
  await page.click('#btn-free');
  await page.waitForTimeout(2600);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(4000);
  await page.screenshot({ path: 'artifacts/menu-pause.png' });
  console.log('PAUSE', JSON.stringify(await measure('.pause-card')));
  console.log('PAUSE_COLS', await page.evaluate(() => getComputedStyle(document.querySelector('.pause-grid')).gridTemplateColumns));

  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.__sp95?.ready === true, null, { timeout: 180_000 });
  await page.addStyleTag({ content: '* { animation: none !important; transition: none !important; }' });
  await page.click('#btn-cars');
  await page.waitForTimeout(4000);
  await page.screenshot({ path: 'artifacts/menu-showroom.png' });
  console.log('SHOWROOM', JSON.stringify(await measure('.showroom-card')));
  console.log(
    'SHOWROOM_STATE',
    JSON.stringify(
      await page.evaluate(() => ({
        cards: document.querySelectorAll('#showroom-list .car-card').length,
        cardsOverflow: (() => {
          const list = document.querySelector('.showroom-list');
          return list.scrollHeight > list.clientHeight + 2;
        })(),
        footerVisible: (() => {
          const foot = document.querySelector('.showroom-foot');
          const box = foot.getBoundingClientRect();
          return box.bottom <= window.innerHeight + 1;
        })(),
      })),
    ),
  );
} catch (error) {
  console.error('MENUS ERROR', error);
} finally {
  await browser.close();
}
