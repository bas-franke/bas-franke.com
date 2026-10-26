// Screenshots inside the caves and tunnel shortcuts, from the world lab with the camera placed by hand (the autopilot
// rarely drives the tunnel lane). Gets past the nickname gate first.
//   node tools/racer/caveshot.mjs <baseUrl> <outDir> <shot,shot,...> [track] [WxH] [waitMs]
// A shot is cave:<i>:<m> (m metres past cave i's entry, on the centre line) or tunnel:<i>:<m> (m metres past tunnel
// shortcut i's roof start, in its sunken lane); then optionally :<lookAhead>:<camera height>:<target height> (metres;
// look ahead 40 by default).
// Example: node tools/racer/caveshot.mjs http://127.0.0.1:5247 shots cave:0:20,cave:0:200,tunnel:0:-10 redrock
// Saves <outDir>/<track>-<kind><i>-<m>.jpg and prints the fps and page errors.

import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const [base, outDir, shots, track = 'redrock', size = '1600x800', wait = '9000'] = process.argv.slice(2);
if (!base || !outDir || !shots) {
  console.error('usage: node tools/racer/caveshot.mjs <baseUrl> <outDir> <shot,shot,...> [track] [WxH] [waitMs]');
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
const page = await (await browser.newContext({ viewport: { width, height } })).newPage();
page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') console.log(`[error] ${m.text()}`);
});

await page.goto(base, { waitUntil: 'load' });
const guest = page.getByTestId('gate-guest');
if (await guest.isVisible({ timeout: 3000 }).catch(() => false)) {
  await page.locator('input').first().fill('ArtBot');
  await guest.click();
  await page.waitForTimeout(800);
}

const open = async () => {
  await page.goto(`${base}/race/lab/world?track=${track}&at=0.05`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__lab, null, { timeout: 60000 });
  await page.waitForTimeout(Number(wait));
};
await open();
const info = await page.evaluate(() => {
  const t = window.__lab.track;
  return { length: t.length, caves: t.caves, tunnels: t.shortcuts.filter((c) => c.kind === 'tunnel') };
});
console.log(JSON.stringify(info));

// Another session's edit can hot-reload the page mid-shot: reopen the lab and try that shot again.
const once = async (shot) => {
  const [kind, idx, m, ahead = "40", up = "", look = ""] = shot.split(":");
  const ok = await page.evaluate(
    ({ kind, i, m, ahead, up, look }) => {
      const { track, camera, controls } = window.__lab;
      const tun = track.shortcuts.filter((c) => c.kind === 'tunnel')[i];
      const cave = track.caves[i];
      if (kind === 'tunnel' ? !tun : !cave) return false;
      const s = kind === 'tunnel' ? tun.roof0 + m : cave.s0 + m;
      const x = kind === 'tunnel' ? tun.side * (tun.xIn + (tun.xOut - tun.xIn) / 2) : 0;
      const p = track.toWorld(s, x, up !== "" ? Number(up) : kind === "tunnel" ? 2.2 : 3);
      const q = track.toWorld(s + ahead, x, look !== "" ? Number(look) : kind === "tunnel" ? 1.8 : 2.5);
      camera.position.copy(p);
      controls.target.copy(q);
      controls.update();
      return true;
    },
    { kind, i: Number(idx), m: Number(m), ahead: Number(ahead), up, look },
  );
  if (!ok) {
    console.log(`no ${kind} ${idx}`);
    return;
  }
  await page.waitForTimeout(1500);
  const fps = await page.evaluate(
    () =>
      new Promise((res) => {
        let n = 0;
        const t0 = performance.now();
        const f = () => (++n < 40 ? requestAnimationFrame(f) : res(Math.round((n * 1000) / (performance.now() - t0))));
        requestAnimationFrame(f);
      }),
  );
  const out = `${outDir}/${track}-${kind}${idx}-${m}${ahead !== "40" ? `-a${ahead}` : ""}${up ? `-h${up}` : ""}${look ? `-l${look}` : ""}.jpg`;
  await page.screenshot({ path: out, type: 'jpeg', quality: 85 });
  console.log(`saved ${out} (~${fps} fps)`);
};
for (const shot of shots.split(',')) {
  for (let tries = 0; tries < 3; tries++) {
    try {
      await once(shot);
      break;
    } catch (e) {
      console.log(`retrying ${shot}: ${String(e.message).slice(0, 120)}`);
      await open();
    }
  }
}
await browser.close();
