// Rockets perf harness: starts a match on each map in headless Chromium and reports what a frame costs.
//
//   node play/tools/perf/perf.mjs --web http://localhost:5173 [--maps foundry,pit] [--bots 7] [--warm 4000]
//        [--sample 5000] [--size 1280x720] [--breakdown] [--chrome C:/path/chrome.exe] [--json out.json]
//
// Needs a dev build (vite dev server plus the backend): it reads `window.__engine.stats` (engine.ts), which only
// exists in dev. Per map it prints draw calls and triangles (shadow pass included, so frames that refresh the
// shadow map show up in max), and the JS time per frame split into update (the game's frame callback) and render
// (renderer.render). Headless Chromium renders with SwiftShader, so render ms and FPS are inflated and only useful
// to compare runs; calls, triangles and update ms are meaningful.
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(fileURLToPath(new URL('../../package.json', import.meta.url)));
const { chromium } = require('playwright');

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1] ?? '']] : acc), []),
);
const ALL_MAPS = ['foundry', 'skyway', 'canyon', 'ziggurat', 'spires', 'fortress', 'pit', 'twin', 'downtown', 'orbit'];
const web = args.web ?? 'http://localhost:5173';
const maps = args.maps ? args.maps.split(',') : ALL_MAPS;
const bots = Number(args.bots ?? 7);
const warm = Number(args.warm ?? 4000);
const sample = Number(args.sample ?? 5000);
const [w, h] = (args.size ?? '1280x720').split('x').map(Number);

// Prefer the Chromium the repo's Playwright installed; fall back to Playwright's own lookup.
const guess = `${process.env.LOCALAPPDATA}/ms-playwright/chromium-1208/chrome-win64/chrome.exe`;
const executablePath = args.chrome || (existsSync(guess) ? guess : undefined);
const browser = await chromium.launch({ executablePath, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });

const results = [];
for (const map of maps) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(web);
  await page.evaluate(() => localStorage.setItem('play.name', 'Perf'));
  const code = await page.evaluate(
    async ({ map, bots }) => {
      const r = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Perf', game: 'rockets', maxPlayers: 8, bots, botDifficulty: 'normal', map }),
      }).then((r) => r.json());
      return r.room.code;
    },
    { map, bots },
  );
  await page.goto(`${web}/room/${code}`);
  await page.getByRole('button', { name: /^Start/ }).click({ timeout: 15000 });
  await page.waitForFunction(() => window.__engine?.stats.frames > 0, null, { timeout: 15000 });
  await page.waitForTimeout(warm);
  // Sample every frame from a rAF callback queued after the engine's own, so it sees that frame's numbers.
  const r = await page.evaluate(async (ms) => {
    const e = window.__engine;
    const calls = [], tris = [], upd = [], ren = [], dts = [];
    let last = performance.now();
    const shadow0 = e.stats.shadowFrames, frames0 = e.stats.frames;
    await new Promise((done) => {
      const end = last + ms;
      const step = (now) => {
        const s = e.stats;
        calls.push(s.calls);
        tris.push(s.triangles);
        upd.push(s.lastUpdateMs);
        ren.push(s.lastRenderMs);
        dts.push(now - last);
        last = now;
        if (now < end) requestAnimationFrame(step);
        else done();
      };
      requestAnimationFrame(step);
    });
    const sorted = (a) => [...a].sort((x, y) => x - y);
    const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    const p = (a, q) => sorted(a)[Math.min(a.length - 1, Math.floor(a.length * q))];
    const mem = e.renderer.info.memory;
    return {
      frames: calls.length,
      callsAvg: Math.round(avg(calls)), callsMax: Math.max(...calls),
      trisAvg: Math.round(avg(tris)), trisMax: Math.max(...tris),
      updateAvg: +avg(upd).toFixed(2), updateP95: +p(upd, 0.95).toFixed(2),
      renderAvg: +avg(ren).toFixed(2), renderP95: +p(ren, 0.95).toFixed(2),
      frameP50: +p(dts, 0.5).toFixed(1),
      shadowShare: +((e.stats.shadowFrames - shadow0) / Math.max(1, e.stats.frames - frames0)).toFixed(2),
      ratio: e.stats.ratio,
      geometries: mem.geometries, textures: mem.textures, programs: e.renderer.info.programs?.length ?? 0,
    };
  }, sample);
  if (args.breakdown !== undefined) {
    // Visible renderables per top-level scene child (and how many cast shadows): where the draw calls come from.
    const parts = await page.evaluate(() => {
      const out = {};
      const shown = (o) => { for (; o; o = o.parent) if (!o.visible) return false; return true; };
      for (const top of window.__engine.scene.children) {
        const key = top.name || top.type;
        top.traverse((o) => {
          if (!(o.isMesh || o.isLine || o.isSprite || o.isPoints) || !shown(o)) return;
          const row = (out[key] ??= { objects: 0, draws: 0, casters: 0 });
          row.draws++;
          if (o.castShadow) row.casters++;
        });
        if (out[key]) out[key].objects++;
      }
      return out;
    });
    console.log(`${map} breakdown:`);
    console.table(parts);
  }
  results.push({ map, ...r, errors: errors.slice(0, 3) });
  console.error(`${map}: ${r.callsAvg} calls (max ${r.callsMax}), ${(r.trisAvg / 1000).toFixed(0)}k tris, update ${r.updateAvg} ms (p95 ${r.updateP95}), render ${r.renderAvg} ms`);
  await page.close();
}
await browser.close();

console.table(results.map(({ errors, ...r }) => r));
for (const r of results) if (r.errors.length) console.log(`${r.map} errors:`, r.errors);
if (args.json) mkdirSync(dirname(args.json), { recursive: true });
if (args.json) writeFileSync(args.json, JSON.stringify(results, null, 2));
