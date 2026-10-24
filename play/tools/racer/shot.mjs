// Screenshot a racer page in a real (headless) Chrome: node tools/racer/shot.mjs <url> <out.png> [waitMs] [WxH]
// Example: node tools/racer/shot.mjs "http://127.0.0.1:5191/race/lab/world?track=falls" shot.png 4000 1600x900
// Prints console errors from the page. Uses the playwright package in play/node_modules.

import { chromium } from 'playwright';

const [url, out, wait = '4000', size = '1600x900'] = process.argv.slice(2);
if (!url || !out) {
  console.error('usage: node tools/racer/shot.mjs <url> <out.png> [waitMs] [WxH]');
  process.exit(1);
}
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
const page = await browser.newPage({ viewport: { width, height } });
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') console.log(`[${m.type()}] ${m.text()}`);
});
page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(Number(wait));
const fps = await page.evaluate(
  () =>
    new Promise((res) => {
      let n = 0;
      const t0 = performance.now();
      const f = () => (++n < 30 ? requestAnimationFrame(f) : res(Math.round((n * 1000) / (performance.now() - t0))));
      requestAnimationFrame(f);
    }),
);
await page.screenshot({ path: out });
console.log(`saved ${out} (~${fps} fps)`);
await browser.close();
