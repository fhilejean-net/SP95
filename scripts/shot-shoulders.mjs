/**
 * Vue serrée des épaules, guidon braqué à fond : c'est la preuve visuelle de
 * l'entrée « Rider shoulder seam » du backlog (aucun trou à l'aisselle).
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
page.setDefaultTimeout(200000);

const shoot = async (key, file, side) => {
  await page.keyboard.down(key);
  await page.waitForTimeout(9000);
  await page.evaluate((s) => {
    const p = window.__sp95.position;
    window.__sp95.setCamera(p.x + 0.95 * s, p.y + 1.62, p.z - 1.35, p.x, p.y + 1.06, p.z - 0.15);
  }, side);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: file });
  await page.keyboard.up(key);
  await page.waitForTimeout(1200);
};

try {
  await page.goto('http://127.0.0.1:3000/?fx=low', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__sp95?.ready === true, null, { timeout: 120000 });
  await page.click('#btn-moto');
  await page.waitForFunction(() => window.__sp95.vehicleKind === 'bike', null, { timeout: 30000 });

  // `d` tourne le guidon vers la droite : on regarde l'épaule gauche, et l'inverse.
  await shoot('d', 'artifacts/steer-right.png', 1);
  await shoot('a', 'artifacts/steer-left.png', -1);

  // De face, braqué à fond : les deux épaules dans le même cadre, c'est là qu'un
  // trou à l'aisselle se voit le mieux.
  await page.keyboard.down('d');
  await page.waitForTimeout(6000);
  await page.evaluate(() => {
    const p = window.__sp95.position;
    window.__sp95.setCamera(p.x, p.y + 1.45, p.z - 2.1, p.x, p.y + 1.1, p.z - 0.1);
  });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'artifacts/shoulder-front.png' });
  await page.keyboard.up('d');
  console.log('ok');
} catch (error) {
  console.error(error.message);
} finally {
  await browser.close();
}
