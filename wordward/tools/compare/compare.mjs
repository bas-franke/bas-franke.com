// Wordward look-and-perf compare: renders a staged, repeatable scene in headless Chromium and puts it next to
// tools/compare/reference.webp, then times a run of frames.
//
//   node tools/compare/compare.mjs [--scene play|defeat|sentence|boss|bonk|menu|map] [--size 1536x1024] [--port 5201] [--frames 120]
//        [--seed 7] [--creatures 6] [--letters 3] [--chrome C:/path/chrome.exe] [--headed] [--keep]
//
// Starts its own Vite dev server for wordward/frontend (no backend: the game must run as a guest, so failed /api
// calls are expected and listed separately from real page errors). Needs the dev build: it drives `window.__ww`,
// the Game instance App.tsx exposes in dev.
//
// Outputs (tools/compare/out/, git-ignored), with <name> = <scene> at 1536x1024, else <scene>-<W>x<H>:
//   <name>-current.png   the game's viewport (canvas plus HTML HUD)
//   <name>-compare.png   reference left, current right, same height, labelled
//   <name>-perf.json     frame timing, draw calls, triangles, programs, memory, per-object breakdown, errors
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..'); // wordward/
const FRONTEND = join(ROOT, 'frontend');
const OUT = join(HERE, 'out');
const REFERENCE = join(HERE, 'reference.webp');

const HELP = `Wordward compare: screenshot a staged scene next to the reference and measure frame cost.

Usage: node tools/compare/compare.mjs [options]

  --scene NAME           what to stage (default play):
                           play:     free play, ~6 creatures at different depths, a few letters typed at the target
                           defeat:   play, but the target's every letter typed (shield word, then its word), the
                                     last one --settle frames before the shot: the defeat poof and ink mid-flight
                           sentence: a sentence convoy of ink slimes in its wide shield leads, --creatures escort it,
                                     --letters typed into the shield
                           boss:     the Bookwyrm (three heads, a shield each, spawned with the private spawnBoss())
                                     leads, --creatures escort it, --letters typed at the closest head
                           bonk:     play, but the closest creature reaches the defenders: dust and red flash
                           menu:     the home screen;  map: the campaign map
  --size WxH             viewport (default 1536x1024, the reference size; try 390x844 for a phone)
  --port N               port for the Vite dev server this script starts (default 5201; pick a unique one)
  --frames N             frames to time with __ww.engine.step(1/60) after the screenshot (default 120), after
                         10 warm-up frames reported apart as warmupMsMax (shader compiles land there)
  --seed N               seed for the Math.random replacement, so runs are repeatable (default 7)
  --creatures N          small creatures to spawn (default 6; 3 with sentence, 2 with boss)
  --letters N            correct letters typed at the target before the shot (default 3; play/sentence/boss)
  --settle N             frames stepped after the last letter (or the bonk) before the shot (default 4; 6 for
                         defeat and bonk; more = effects further along)
  --chrome PATH          Chromium executable (default: Playwright's chromium-1208 under %LOCALAPPDATA%)
  --headed               show the browser window
  --keep                 leave the browser and server running until Ctrl+C (to poke at it)
  --help                 this text

Outputs go to tools/compare/out/: <name>-current.png, <name>-compare.png, <name>-perf.json, where <name> is the
scene, plus -WxH when the size is not 1536x1024. Rendering is SwiftShader (software): ms timings are only
comparable between runs on this machine; draw calls, triangles, programs and memory counts are real.`;

// ---- args ------------------------------------------------------------------------------------------------------

const argv = process.argv.slice(2);
const args = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('--')) continue;
  const [k, inline] = a.slice(2).split('=');
  const next = argv[i + 1];
  if (inline !== undefined) args[k] = inline;
  else if (next !== undefined && !next.startsWith('--')) args[k] = argv[++i];
  else args[k] = true;
}
if (args.help || args.h) {
  console.log(HELP);
  process.exit(0);
}
const scene = String(args.scene ?? 'play');
const SCENES = ['play', 'defeat', 'sentence', 'boss', 'bonk', 'menu', 'map'];
if (!SCENES.includes(scene)) fail(`unknown --scene ${scene} (${SCENES.join('|')})`);
const [W, H] = String(args.size ?? '1536x1024').split('x').map(Number);
if (!(W > 0 && H > 0)) fail(`bad --size ${args.size} (want WxH)`);
const port = Number(args.port ?? 5201);
const frames = Number(args.frames ?? 120);
const seed = Number(args.seed ?? 7);
const creatures = Number(args.creatures ?? (scene === 'boss' ? 2 : scene === 'sentence' ? 3 : 6));
const letters = Number(args.letters ?? 3);
const settle = Number(args.settle ?? (scene === 'defeat' || scene === 'bonk' ? 6 : 4));
const name = W === 1536 && H === 1024 ? scene : `${scene}-${W}x${H}`;

function fail(msg) {
  console.error(`compare: ${msg}`);
  process.exit(1);
}

const require = createRequire(join(ROOT, 'package.json'));
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  fail('playwright is missing: run `npm install` in wordward/ (Node 24 on PATH)');
}

// ---- vite ------------------------------------------------------------------------------------------------------

const NODE24 = 'C:/Users/buunn/AppData/Local/Temp/claude/C--Projects-bas-franke-com/8dab55c6-e7c6-496f-b912-fb805e6169bc/scratchpad/node24/node-v24.22.1-win-x64/node.exe';
const nodeExe = existsSync(NODE24) ? NODE24 : process.execPath;
const base = `http://127.0.0.1:${port}`;
let viteLog = '';
const vite = spawn(nodeExe, ['node_modules/vite/bin/vite.js', '--strictPort', '--port', String(port), '--host', '127.0.0.1'], {
  cwd: FRONTEND,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
vite.stdout.on('data', (d) => (viteLog += d));
vite.stderr.on('data', (d) => (viteLog += d));
let viteExited = false;
vite.on('exit', () => (viteExited = true));

let browser;
async function cleanup() {
  try {
    await browser?.close();
  } catch {}
  if (!viteExited) {
    // On Windows a plain kill can leave esbuild children; taskkill /T takes the whole tree.
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(vite.pid), '/T', '/F'], { stdio: 'ignore' });
    else vite.kill();
  }
}
process.on('SIGINT', async () => {
  await cleanup();
  process.exit(130);
});

async function waitForVite() {
  const end = Date.now() + 60_000;
  while (Date.now() < end) {
    if (viteExited) throw new Error(`vite exited:\n${viteLog}`);
    try {
      const r = await fetch(base + '/');
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`vite did not answer on ${base} within 60 s:\n${viteLog}`);
}

// ---- in-page helpers -------------------------------------------------------------------------------------------

// Seeded Math.random (mulberry32) installed before any module runs.
const seedScript = (s) => {
  let a = s >>> 0;
  Math.random = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  // performance.now runs on a virtual clock once staging starts (__freezeClock), so time-driven shader uniforms
  // (toon.ts glow) do not depend on how long the run took. __realNow keeps the real one for timings.
  const realNow = performance.now.bind(performance);
  let virtual = 0;
  window.__realNow = realNow;
  window.__freezeClock = () => {
    virtual = 100000;
    performance.now = () => virtual;
    // Every manual engine step advances the virtual clock by its dt.
    const e = window.__ww.engine;
    const step = e.step.bind(e);
    e.step = (dt) => {
      virtual += dt * 1000;
      step(dt);
    };
  };
  // No animation frames at all: only the engine uses them, and idle frames with real dt (clouds drifting while the
  // page loads) would make shots differ run to run. The script drives every frame with __ww.engine.step.
  window.requestAnimationFrame = () => 0;
  window.cancelAnimationFrame = () => {};
  // Guest mode, fresh save every run.
  try {
    localStorage.clear();
  } catch {}
};

const GAME_SCENES = ['play', 'defeat', 'sentence', 'boss', 'bonk'];

async function stageGame(page) {
  // Prefer the real UI (so React's HUD state follows), fall back to the API.
  let viaUi = false;
  try {
    await page.locator('.mode-card.free').click({ timeout: 5000 });
    await page.locator('.start-row .btn.primary').click({ timeout: 5000 });
    viaUi = true;
  } catch {}
  return page.evaluate(
    ({ scene, viaUi, creatures, letters, settle }) => {
      const g = window.__ww;
      const notes = [];
      g.engine.stop(); // only our own fixed-dt steps from here on
      window.__freezeClock();
      const fallback = { direction: 'en-ro', categories: [] /* empty pool falls back to every entry */, mix: 'mixed', difficulty: 'normal', lenient: true, shields: true };
      if (!viaUi || g.state?.phase !== 'playing') {
        notes.push('UI start failed, used __ww.start()');
        g.start(fallback);
      }
      // The sentence scene restarts the round with sentences only, so the deck surely holds some.
      if (scene === 'sentence') g.start({ ...(g.settings ?? fallback), mix: 'sentences' });
      const step = (n) => {
        for (let i = 0; i < n; i++) g.engine.step(1 / 60);
      };
      // Past the wave banner, then hold back the game's own spawner.
      g.waveBreak = 0;
      g.spawnTimer = 1e9;
      step(2);
      g.bossPending = false;
      g.waveLeft = Math.max(g.waveLeft ?? 0, 1);
      const impact = 3.4;
      const top = g.top ?? 26;
      // The big one first, so it is the closest (the target) once spread.
      if (scene === 'boss') {
        g.state = { ...g.state, wave: 5 }; // three heads, as in free play's first boss wave
        try {
          g.spawnBoss();
        } catch (err) {
          notes.push(`spawnBoss failed: ${err.message}`);
        }
      } else if (scene === 'sentence') {
        try {
          g.spawn();
        } catch (err) {
          notes.push(`spawn failed: ${err.message}`);
        }
        g.settings = { ...g.settings, mix: 'words' }; // the escort are single creatures
      }
      const lead = g.enemies?.length ?? 0;
      for (let i = 0; i < creatures; i++) {
        try {
          g.spawn();
        } catch (err) {
          notes.push(`spawn failed: ${err.message}`);
          break;
        }
      }
      // Spread them over the field: closest about a quarter of the way up, farthest near the top. A boss or convoy
      // leads, a little further up so its tags and heads stay clear of the defenders.
      const list = g.enemies ?? [];
      list.forEach((e, i) => {
        const f = list.length > 1 ? i / (list.length - 1) : 0.5;
        e.y = impact + (top - impact) * (lead && i === 0 ? 0.3 : 0.22 + 0.7 * f);
        if (lead && i > 0) e.y = impact + (top - impact) * (0.45 + 0.5 * ((i - 1) / Math.max(1, list.length - 2)));
      });
      step(30);
      const spawned = list.length;
      const want = () => {
        const t = g.pickTarget?.();
        const part = t?.parts?.[t.partIdx];
        return { t, ch: part?.glyphs?.[part.pos]?.ch };
      };
      let typed = '';
      const calls = () => g.engine.renderer.info.render.calls;
      let callsBefore;
      const hit = (ch) => {
        g.type(ch);
        typed += ch;
      };
      if (scene === 'defeat') {
        // Every letter of the target (shield word, then the word itself) but the last, a pause so those effects
        // fade, then the last letter: the shot shows the defeat poof `settle` frames in.
        const { t } = want();
        let guard = 200;
        for (; guard > 0; guard--) {
          const { t: cur, ch } = want();
          if (!ch || cur !== t) break;
          const part = cur.parts[cur.partIdx];
          const last = cur.partIdx === cur.parts.length - 1 && part.glyphs.slice(part.pos + 1).every((x) => !x.typed);
          if (last) {
            step(40);
            callsBefore = calls();
            hit(ch);
            break;
          }
          hit(ch);
          step(2);
        }
        if (g.enemies.includes(t)) notes.push('defeat: the target survived');
      } else if (scene === 'bonk') {
        // The closest creature reaches the defenders.
        const { t } = want();
        if (t) {
          callsBefore = calls();
          t.y = impact + 0.02;
          for (let i = 0; i < 120 && g.enemies.includes(t); i++) step(1);
          if (g.enemies.includes(t)) notes.push('bonk: the creature never reached the line');
        }
      } else {
        // Type correct letters into the current target.
        for (let i = 0; i < letters; i++) {
          const { ch } = want();
          if (!ch) break;
          hit(ch);
          step(1);
        }
      }
      step(settle);
      // Draw calls of the shot frame, and of the frame before the defeat/bonk (their difference is what the effect
      // adds, minus the creature that left).
      const fx = g.effects?.root;
      let fxVisible = 0;
      fx?.traverse((o) => {
        let shown = o.isMesh && (o.geometry?.instanceCount ?? 1) > 0;
        for (let p = o; shown && p; p = p.parent) shown = p.visible;
        if (shown) fxVisible++;
      });
      return { enemies: spawned, kinds: g.enemies.map((e) => e.kind), typed, phase: g.state?.phase, callsBefore, callsAtShot: calls(), effectMeshesAtShot: fxVisible, notes };
    },
    { scene, viaUi, creatures, letters, settle },
  );
}

async function stageMenu(page) {
  return page.evaluate(() => {
    const g = window.__ww;
    g.engine.stop();
    window.__freezeClock();
    for (let i = 0; i < 30; i++) g.engine.step(1 / 60);
    return { phase: g.state?.phase };
  });
}

async function stageMap(page) {
  await page.locator('.mode-card.adventure').click({ timeout: 5000 });
  await page.waitForTimeout(300);
  return stageMenu(page);
}

// ---- main ------------------------------------------------------------------------------------------------------

const t0 = Date.now();
let exitCode = 0;
try {
  mkdirSync(OUT, { recursive: true });
  await waitForVite();
  const guess = `${process.env.LOCALAPPDATA}/ms-playwright/chromium-1208/chrome-win64/chrome.exe`;
  const executablePath = args.chrome || (existsSync(guess) ? guess : undefined);
  browser = await chromium.launch({
    executablePath,
    headless: !args.headed,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  const phone = W < 768;
  const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, isMobile: phone, hasTouch: phone });
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  const failedRequests = [];
  page.on('pageerror', (e) => pageErrors.push(e.stack?.split('\n').slice(0, 3).join(' | ') ?? e.message));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    // Failed /api loads are expected without a backend; they are counted under failedRequests.
    if (/Failed to load resource/.test(text)) return;
    consoleErrors.push(text.slice(0, 300));
  });
  page.on('response', (r) => {
    if (r.status() >= 400) failedRequests.push(`${r.status()} ${new URL(r.url()).pathname}`);
  });
  page.on('requestfailed', (r) => failedRequests.push(`failed ${new URL(r.url()).pathname}`));
  await page.addInitScript(seedScript, seed);
  await page.goto(base + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ww?.engine, null, { timeout: 30_000 });
  await page.waitForTimeout(500); // React StrictMode builds the Game twice in dev; let it settle on the last one
  // Wait for web fonts so the HUD text renders the same every run.
  await page.evaluate(() => document.fonts?.ready);

  const staged = GAME_SCENES.includes(scene) ? await stageGame(page) : scene === 'map' ? await stageMap(page) : await stageMenu(page);

  const currentPath = join(OUT, `${name}-current.png`);
  const shot = await page.screenshot({ path: currentPath, animations: 'disabled', timeout: 120_000 }); // SwiftShader is slow under load

  // Side-by-side composite on a canvas in a blank page (no image libraries needed).
  const ref = 'data:image/webp;base64,' + readFileSync(REFERENCE).toString('base64');
  const cur = 'data:image/png;base64,' + shot.toString('base64');
  const comp = await context.newPage();
  await comp.setContent('<html><body style="margin:0"></body></html>');
  const dataUrl = await comp.evaluate(
    async ({ ref, cur, label }) => {
      const load = (src) =>
        new Promise((ok, bad) => {
          const i = new Image();
          i.onload = () => ok(i);
          i.onerror = () => bad(new Error('image load failed'));
          i.src = src;
        });
      const [a, b] = await Promise.all([load(ref), load(cur)]);
      const h = a.naturalHeight;
      const wa = a.naturalWidth;
      const wb = Math.round((b.naturalWidth * h) / b.naturalHeight);
      const gap = 16;
      const c = document.createElement('canvas');
      c.width = wa + gap + wb;
      c.height = h;
      const x = c.getContext('2d');
      x.fillStyle = '#111';
      x.fillRect(0, 0, c.width, c.height);
      x.drawImage(a, 0, 0, wa, h);
      x.imageSmoothingQuality = 'high';
      x.drawImage(b, wa + gap, 0, wb, h);
      const tag = (text, left) => {
        x.font = 'bold 22px sans-serif';
        const w = x.measureText(text).width + 20;
        x.fillStyle = 'rgba(0,0,0,0.65)';
        x.fillRect(left + 10, h - 44, w, 34);
        x.fillStyle = '#fff';
        x.fillText(text, left + 20, h - 19);
      };
      tag('reference', 0);
      tag(label, wa + gap);
      return c.toDataURL('image/png');
    },
    { ref, cur, label: `current · ${scene} ${W}×${H}` },
  );
  await comp.close();
  const comparePath = join(OUT, `${name}-compare.png`);
  writeFileSync(comparePath, Buffer.from(dataUrl.split(',')[1], 'base64'));

  // Performance: fixed-dt steps, each timed in JS (simulation + renderer.render).
  const perf = await page.evaluate((frames) => {
    const g = window.__ww;
    const e = g.engine;
    const r = e.renderer;
    // Warm-up frames first, timed apart: they include shader compiles for anything new on screen (a hitch, not a
    // steady cost).
    const warm = [];
    for (let i = 0; i < 10; i++) {
      const t = window.__realNow();
      e.step(1 / 60);
      warm.push(window.__realNow() - t);
    }
    const ms = [];
    const calls = [];
    const tris = [];
    for (let i = 0; i < frames; i++) {
      const t = window.__realNow();
      e.step(1 / 60);
      ms.push(window.__realNow() - t);
      calls.push(r.info.render.calls);
      tris.push(r.info.render.triangles);
    }
    const sorted = (a) => [...a].sort((p, q) => p - q);
    const avg = (a) => (a.length ? a.reduce((p, q) => p + q, 0) / a.length : 0);
    const pct = (a, q) => sorted(a)[Math.min(a.length - 1, Math.floor(a.length * q))] ?? 0;
    // Visible renderables per top-level scene child: where the draw calls come from.
    const shown = (o) => {
      for (; o; o = o.parent) if (!o.visible) return false;
      return true;
    };
    const breakdown = {};
    let lights = 0;
    e.scene.traverse((o) => {
      if (o.isLight && shown(o)) lights++;
    });
    e.scene.children.forEach((top, idx) => {
      const key = top.name || `${idx}:${top.type}${top.children.length ? `(${top.children.length})` : ''}`;
      top.traverse((o) => {
        if (!(o.isMesh || o.isLine || o.isSprite || o.isPoints) || !shown(o)) return;
        // Counts objects with visible=true (frustum culling not applied), so the sum can exceed render.calls.
        const row = (breakdown[key] ??= { objects: 0, draws: 0, instances: 0, triangles: 0 });
        row.draws++;
        const geo = o.geometry;
        const count = o.isInstancedMesh ? o.count : 1;
        row.instances += count;
        if (geo && o.isMesh) {
          const n = geo.index ? geo.index.count : geo.attributes.position?.count ?? 0;
          row.triangles += Math.round(n / 3) * count;
        }
      });
      if (breakdown[key]) breakdown[key].objects++;
    });
    return {
      frames,
      warmupMsMax: +Math.max(...warm).toFixed(1),
      stepMsAvg: +avg(ms).toFixed(2),
      stepMsP50: +pct(ms, 0.5).toFixed(2),
      stepMsP95: +pct(ms, 0.95).toFixed(2),
      stepMsMax: +Math.max(...ms).toFixed(2),
      callsAvg: Math.round(avg(calls)),
      callsMax: Math.max(...calls),
      trianglesAvg: Math.round(avg(tris)),
      trianglesMax: Math.max(...tris),
      programs: r.info.programs?.length ?? 0,
      geometries: r.info.memory.geometries,
      textures: r.info.memory.textures,
      lights,
      shadows: r.shadowMap.enabled,
      pixelRatio: r.getPixelRatio(),
      canvas: `${r.domElement.width}x${r.domElement.height}`,
      breakdown,
    };
  }, frames);

  const result = {
    scene,
    size: `${W}x${H}`,
    seed,
    staged,
    perf,
    pageErrors,
    consoleErrors,
    failedRequests: [...new Set(failedRequests)],
    note: 'SwiftShader (software) rendering: ms timings are only comparable between runs on the same machine; calls/triangles/programs/memory are real.',
    when: new Date().toISOString(),
  };
  const perfPath = join(OUT, `${name}-perf.json`);
  writeFileSync(perfPath, JSON.stringify(result, null, 2));

  const { breakdown, ...flat } = perf;
  console.log(JSON.stringify({ scene, size: result.size, staged, ...flat }, null, 2));
  console.log('breakdown per top-level scene child (visible flag only, before frustum culling; name your groups for readable rows):');
  const rows = Object.entries(breakdown).sort((a, b) => b[1].draws - a[1].draws);
  console.table(Object.fromEntries(rows.slice(0, 12)));
  if (rows.length > 12) console.log(`  (+${rows.length - 12} more rows in the perf JSON)`);
  console.log(`page errors: ${pageErrors.length}${pageErrors.length ? '\n  ' + pageErrors.join('\n  ') : ''}`);
  console.log(`console errors: ${consoleErrors.length}${consoleErrors.length ? '\n  ' + consoleErrors.join('\n  ') : ''}`);
  console.log(`failed requests (expected without a backend): ${result.failedRequests.join(', ') || 'none'}`);
  console.log(`note: ${result.note}`);
  console.log(`wrote ${currentPath}\n      ${comparePath}\n      ${perfPath}  (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  if (pageErrors.length) exitCode = 2;

  if (args.keep) {
    console.log(`--keep: browser and ${base} stay up; Ctrl+C to stop.`);
    await new Promise(() => {});
  }
} catch (err) {
  console.error(`compare failed: ${err.stack ?? err}`);
  exitCode = 1;
} finally {
  await cleanup();
}
process.exit(exitCode);
