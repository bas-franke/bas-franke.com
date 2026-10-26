// Art-direction screenshots of a race: gets past the nickname gate, then shoots one or more course positions.
//   node tools/racer/artshot.mjs <baseUrl> <outDir> <at,at,...> [track] [WxH] [waitMs]
// Example: node tools/racer/artshot.mjs http://127.0.0.1:5247 shots 0.1,0.3,0.55 redrock 1600x800
// Each shot is /race?go=<track>&autopilot&skipintro&at=<at>, saved as <outDir>/<track>-<at>.jpg. Prints page errors.

import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const [base, outDir, ats, track = 'redrock', size = '1600x800', wait = '16000'] = process.argv.slice(2);
if (!base || !outDir || !ats) {
  console.error('usage: node tools/racer/artshot.mjs <baseUrl> <outDir> <at,at,...> [track] [WxH] [waitMs]');
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });
const [width, height] = size.split('x').map(Number);
let browser;
for (const channel of ['chrome', 'msedge', undefined]) {
  try {
    browser = await chromium.launch({ channel, args: ['--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=d3d11', '--enable-unsafe-swiftshader'] });
    break;
  } catch {
    /* next */
  }
}
if (!browser) throw new Error('no browser');
const context = await browser.newContext({ viewport: { width, height } });
const page = await context.newPage();
page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') console.log(`[error] ${m.text()}`);
});

// The gate: pick a nickname once, the cookie carries it to every later page.
await page.goto(base, { waitUntil: 'load' });
const guest = page.getByTestId('gate-guest');
if (await guest.isVisible({ timeout: 3000 }).catch(() => false)) {
  await page.locator('input').first().fill('ArtBot');
  await guest.click();
  await page.waitForTimeout(800);
}

for (const at of ats.split(',')) {
  await page.goto(`${base}/race?go=${track}&autopilot&skipintro&at=${at}`, { waitUntil: 'load' });
  await page.waitForTimeout(Number(wait));
  const out = `${outDir}/${track}-${at}.jpg`;
  await page.screenshot({ path: out, type: 'jpeg', quality: 85 });
  console.log(`saved ${out}`);
}
await browser.close();
