import { chromium } from 'playwright';

// Capture du menu pause, pour juger la nouvelle organisation en groupes.
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1000, height: 680 } });
page.setDefaultTimeout(240_000);
try {
  await page.goto('http://127.0.0.1:3000/?map=suzuka&fx=full', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__sp95?.ready === true, null, { timeout: 180_000 });
  await page.click('#btn-free');
  await page.waitForTimeout(3000);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1200);
  await page.screenshot({ path: 'artifacts/pause-menu.png' });
  console.log(
    'PAUSE',
    JSON.stringify(
      await page.evaluate(() => {
        const card = document.querySelector('.pause-card');
        return {
          open: !document.getElementById('pause').classList.contains('hidden'),
          overflow: card.scrollHeight > card.clientHeight,
          groups: document.querySelectorAll('.pause-groups section').length,
        };
      }),
    ),
  );
} catch (error) {
  console.error('PAUSE ERROR', error);
} finally {
  await browser.close();
}
