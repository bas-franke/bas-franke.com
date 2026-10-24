// Wordward real frame rate: runs a staged, repeatable play scene on the hardware GPU with the game's own
// requestAnimationFrame loop (nothing is stepped by hand) and reports what a player would get.
//
//   node tools/compare/fps.mjs [--device desktop|phone|both] [--scene play|boss|menu] [--seconds 8] [--port 5211]
//        [--ratio N] [--vsync] [--profile] [--headed] [--seed 7] [--creatures 6] [--cpu 4] [--json]
//
// Like compare.mjs it starts its own Vite dev server for wordward/frontend and drives `window.__ww` (dev build), but
// the browser uses the real GPU (ANGLE on D3D11, no SwiftShader), Math.random is seeded only while the scene is
// staged, and the game then runs on its own: creatures are frozen in place (speed 0) but animate, a correct letter is
// typed every --type-ms so beams and glyph effects are in the frame, and defeated creatures are replaced.
//
// Reported per device: fps (average, 1% low), frame-interval percentiles from rAF timestamps, the engine's JS
// update/render time per frame (engine.stats), GPU time per frame (EXT_disjoint_timer_query_webgl2, when the driver
// exposes it), draw calls, triangles, programs, lights, canvas size, the pixel ratio the governor settled on, the
// engine quality tier and the GPU name (WEBGL_debug_renderer_info).
//
// By default the frame rate is uncapped (--disable-gpu-vsync --disable-frame-rate-limit) so the numbers show
// headroom above 60; --vsync keeps the display cap. --ratio pins the pixel ratio (the governor is switched off), which
// is what you want for before/after comparisons. --profile then freezes one frame and GPU-times it with one thing
// removed at a time (library, floor, creatures, effects, defenders, sprites, transparent, each light, the floor's bump,
// the warm grade, the toon patch) and lists triangles per library mesh and per creature kind.
//
// "phone" = 390x844 viewport, deviceScaleFactor 3, touch, mobile UA, CPU throttled 4x through CDP
// (Emulation.setCPUThrottlingRate). The GPU is still this machine's, so phone numbers are optimistic on fill rate
// and only approximate a mid-range phone's CPU side.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
// --frontend DIR runs another copy of wordward/frontend (e.g. a snapshot with the old files, for before/after).
const FRONTEND = process.argv.includes('--frontend') ? resolve(process.argv[process.argv.indexOf('--frontend') + 1]) : join(ROOT, 'frontend');
const OUT = join(HERE, 'out');

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
  console.log(readHelp());
  process.exit(0);
}
function readHelp() {
  return `Wordward fps: real frame rate on the hardware GPU (see the header of tools/compare/fps.mjs).

  --device desktop|phone|both   1536x1024, or 390x844 @3x + touch + 4x CPU throttle (default both)
  --scene play|boss|menu        what runs (default play)
  --seconds N                   measured seconds per run, after 2 s warm-up (default 8)
  --ratio N                     pin the renderer pixel ratio (governor off); default: the governor decides
  --vsync                       keep the display's frame cap (default: uncapped, shows headroom)
  --profile                     also freeze a frame and GPU-time it with one group/light/feature removed at a time
  --bench-ratio N               pixel ratio for the --profile benchmark (default: the current one)
  --creatures N                 creatures kept on the field (default 6; 2 with boss)
  --type-ms N                   a correct letter every N ms (default 350; 0 = none)
  --quality low|high             force the engine's quality tier (?quality=); default: the engine detects it
  --shot [TAG]                  also save a screenshot after the measurement (out/fps-<scene>-<device>[-quality][-TAG].png)
  --cpu N                       phone CPU throttle rate (default 4)
  --frontend DIR                another copy of wordward/frontend to serve (node_modules may be a junction)
  --port N                      Vite port (default 5211)   --seed N  (default 7)   --headed   --json`;
}
const fail = (m) => {
  console.error(`fps: ${m}`);
  process.exit(1);
};
const device = String(args.device ?? 'both');
const scene = String(args.scene ?? 'play');
if (!['play', 'boss', 'menu'].includes(scene)) fail(`unknown --scene ${scene}`);
const seconds = Number(args.seconds ?? 8);
const port = Number(args.port ?? 5211);
const seed = Number(args.seed ?? 7);
const creatures = Number(args.creatures ?? (scene === 'boss' ? 2 : 6));
const typeMs = Number(args['type-ms'] ?? 350);
const cpu = Number(args.cpu ?? 4);
const ratio = args.ratio !== undefined ? Number(args.ratio) : null;

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
      if ((await fetch(base + '/')).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`vite did not answer on ${base} within 60 s:\n${viteLog}`);
}

// ---- in-page ---------------------------------------------------------------------------------------------------

// Seeded Math.random (mulberry32) for building the scene; the real one is restored once staging is done.
const seedScript = (s) => {
  const real = Math.random;
  let a = s >>> 0;
  Math.random = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  window.__realRandom = real;
  try {
    localStorage.clear();
  } catch {}
};

/** Stages the scene and installs the probes: rAF timestamps, engine stats per frame, GPU timer queries. */
async function stage(page) {
  if (scene !== 'menu') {
    try {
      await page.locator('.mode-card.free').click({ timeout: 5000 });
      await page.locator('.start-row .btn.primary').click({ timeout: 5000 });
    } catch {}
  }
  return page.evaluate(
    ({ scene, creatures, typeMs, ratio }) => {
      const g = window.__ww;
      const e = g.engine;
      const r = e.renderer;
      const notes = [];
      if (ratio !== null) {
        // Pin the resolution: the governor only keeps the fps estimate.
        e.govern = (dt) => {
          e.fps += (1 / Math.max(dt, 1e-3) - e.fps) * Math.min(1, dt * 2);
        };
        r.setPixelRatio(ratio);
        e.fit();
        if (e.stats) e.stats.ratio = ratio;
      }
      if (scene !== 'menu') {
        if (g.state?.phase !== 'playing') {
          notes.push('UI start failed, used __ww.start()');
          g.start({ direction: 'en-ro', categories: [], mix: 'words', difficulty: 'normal', lenient: true, shields: true });
        }
        g.settings = { ...g.settings, mix: 'words' };
        g.waveBreak = 0;
        g.spawnTimer = 1e9;
        g.bossPending = false;
        g.waveLeft = 1e6;
        const impact = 3.4;
        const top = g.top ?? 26;
        if (scene === 'boss') {
          g.state = { ...g.state, wave: 5 };
          try {
            g.spawnBoss();
          } catch (err) {
            notes.push(`spawnBoss failed: ${err.message}`);
          }
        }
        const lead = scene === 'boss' ? 1 : 0;
        const place = () => {
          const list = g.enemies ?? [];
          list.forEach((en, i) => {
            en.speed = 0;
            if (en.__placed) return;
            en.__placed = true;
            const k = lead ? Math.max(0, i - 1) : i;
            const n = Math.max(1, creatures - 1);
            en.y = lead && i === 0 ? impact + (top - impact) * 0.3 : impact + (top - impact) * (0.22 + 0.7 * ((k % (n + 1)) / n));
          });
        };
        const fill = () => {
          let guard = 10;
          while ((g.enemies?.length ?? 0) < creatures + lead && guard-- > 0) {
            try {
              g.spawn();
            } catch (err) {
              notes.push(`spawn failed: ${err.message}`);
              break;
            }
          }
          place();
        };
        fill();
        // Keep the round alive: refill the field, keep the hearts topped up.
        setInterval(() => {
          if (window.__pauseStage) return;
          fill();
          if (g.state?.hp !== undefined && g.state.hp < 3) g.state = { ...g.state, hp: g.state.maxHp ?? 5 };
        }, 200);
        if (typeMs > 0) {
          setInterval(() => {
            if (window.__pauseStage) return;
            const t = g.pickTarget?.();
            const part = t?.parts?.[t.partIdx];
            const ch = part?.glyphs?.[part.pos]?.ch;
            if (ch) g.type(ch);
          }, typeMs);
        }
      }
      Math.random = window.__realRandom;

      // ---- probes ----
      const probe = (window.__probe = { on: false, t: [], update: [], render: [], calls: [], tris: [], gpu: [] });
      const gl = r.getContext();
      const tq = gl.getExtension('EXT_disjoint_timer_query_webgl2');
      const pending = [];
      const render = r.render.bind(r);
      r.render = (sc, cam) => {
        let q = null;
        if (tq && probe.on) {
          q = gl.createQuery();
          gl.beginQuery(tq.TIME_ELAPSED_EXT, q);
        }
        render(sc, cam);
        if (q) {
          gl.endQuery(tq.TIME_ELAPSED_EXT);
          pending.push(q);
        }
        // Resolve finished queries (in order).
        while (pending.length) {
          const p = pending[0];
          if (!gl.getQueryParameter(p, gl.QUERY_RESULT_AVAILABLE)) break;
          const disjoint = gl.getParameter(tq.GPU_DISJOINT_EXT);
          const ns = gl.getQueryParameter(p, gl.QUERY_RESULT);
          if (!disjoint && probe.on) probe.gpu.push(ns / 1e6);
          gl.deleteQuery(p);
          pending.shift();
        }
      };
      const loop = (ts) => {
        if (probe.on) {
          probe.t.push(ts);
          const s = e.stats;
          probe.update.push(s.lastUpdateMs);
          probe.render.push(s.lastRenderMs);
          probe.calls.push(s.calls);
          probe.tris.push(s.triangles);
        }
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      return {
        enemies: g.enemies?.length ?? 0,
        kinds: (g.enemies ?? []).map((x) => x.kind),
        gpu: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
        gpuTimer: !!tq,
        dpr: window.devicePixelRatio,
        notes,
      };
    },
    { scene, creatures, typeMs, ratio },
  );
}

/** Measures `ms` of frames; returns the summary. */
async function measure(page, ms) {
  await page.evaluate(() => {
    const p = window.__probe;
    for (const k of ['t', 'update', 'render', 'calls', 'tris', 'gpu']) p[k] = [];
    p.on = true;
  });
  await page.waitForTimeout(ms);
  return page.evaluate(() => {
    const p = window.__probe;
    p.on = false;
    const e = window.__ww.engine;
    const r = e.renderer;
    const dts = [];
    for (let i = 1; i < p.t.length; i++) dts.push(p.t[i] - p.t[i - 1]);
    const sorted = (a) => [...a].sort((x, y) => x - y);
    const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
    const pct = (a, q) => (a.length ? sorted(a)[Math.min(a.length - 1, Math.floor(a.length * q))] : 0);
    const span = (p.t.at(-1) - p.t[0]) / 1000;
    // 1% low: average fps over the slowest 1% of frames.
    const slow = sorted(dts).slice(Math.floor(dts.length * 0.99));
    let lights = 0;
    e.scene.traverse((o) => {
      if (o.isLight && o.visible) lights++;
    });
    const f = (n, d = 1) => +n.toFixed(d);
    return {
      frames: dts.length,
      fpsAvg: f(dts.length / span),
      fps1Low: f(1000 / avg(slow)),
      frameMsP50: f(pct(dts, 0.5), 2),
      frameMsP95: f(pct(dts, 0.95), 2),
      frameMsP99: f(pct(dts, 0.99), 2),
      frameMsMax: f(Math.max(...dts), 2),
      updateMsAvg: f(avg(p.update), 2),
      renderCallMsAvg: f(avg(p.render), 2),
      gpuMsAvg: p.gpu.length ? f(avg(p.gpu), 2) : null,
      gpuMsP95: p.gpu.length ? f(pct(p.gpu, 0.95), 2) : null,
      calls: Math.round(avg(p.calls)),
      triangles: Math.round(avg(p.tris)),
      programs: r.info.programs?.length ?? 0,
      textures: r.info.memory.textures,
      geometries: r.info.memory.geometries,
      lights,
      ratio: r.getPixelRatio(),
      canvas: `${r.domElement.width}x${r.domElement.height}`,
      quality: e.quality ?? null,
      floor: e.scene.getObjectByName('floor')?.material?.type ?? null,
    };
  });
}

/**
 * Freezes one frame (the engine loop stops, staging timers pause) and renders it repeatedly with GPU timer queries:
 * the full frame, then with one thing removed at a time (a group hidden, a light off, the floor's bump map off,
 * plain ACES instead of the warm grade, Lambert instead of the patched toon shader). A frozen frame makes the deltas
 * clean; the live --profile toggles were too noisy. Also lists triangles per mesh of the library and the creatures.
 */
async function profile(page, benchRatio) {
  return page.evaluate(async (benchRatio) => {
    const g = window.__ww;
    const e = g.engine;
    const r = e.renderer;
    const sc = e.scene;
    const cam = e.camera;
    const gl = r.getContext();
    const tq = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    window.__pauseStage = true;
    e.stop();
    const ratio0 = r.getPixelRatio();
    if (benchRatio) {
      r.setPixelRatio(benchRatio);
      e.fit();
    }
    const wait = () => new Promise((ok) => setTimeout(ok, 16));
    const bench = async (n = 40) => {
      for (let i = 0; i < 4; i++) r.render(sc, cam); // program compiles land here
      const qs = [];
      let cpu = 0;
      for (let i = 0; i < n; i++) {
        let q = null;
        if (tq) {
          q = gl.createQuery();
          gl.beginQuery(tq.TIME_ELAPSED_EXT, q);
        }
        const t = performance.now();
        r.render(sc, cam);
        cpu += performance.now() - t;
        if (q) {
          gl.endQuery(tq.TIME_ELAPSED_EXT);
          qs.push(q);
        }
      }
      const ms = [];
      for (let guard = 0; guard < 200 && qs.length; guard++) {
        await wait();
        while (qs.length && gl.getQueryParameter(qs[0], gl.QUERY_RESULT_AVAILABLE)) {
          const q = qs.shift();
          if (!gl.getParameter(tq.GPU_DISJOINT_EXT)) ms.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
          gl.deleteQuery(q);
        }
      }
      return { ms, cpu: cpu / n, calls: r.info.render.calls, tris: r.info.render.triangles };
    };
    const med = (a) => {
      const s = [...a].sort((x, y) => x - y);
      return s.length ? s[Math.floor(s.length / 2)] : null;
    };
    // A and B interleaved over several rounds, so GPU clock changes and other load hit both alike.
    const ab = async (apply, rounds = 4) => {
      const A = [];
      const B = [];
      let cpuA = 0;
      let cpuB = 0;
      let info;
      for (let k = 0; k < rounds; k++) {
        const a = await bench();
        A.push(...a.ms);
        cpuA += a.cpu / rounds;
        const undo = apply();
        const b = await bench();
        undo();
        B.push(...b.ms);
        cpuB += b.cpu / rounds;
        info = b;
      }
      const ga = med(A);
      const gb = med(B);
      const f = (n) => (n === null ? null : +n.toFixed(3));
      return { gpuMs: f(gb), dGpuMs: ga !== null && gb !== null ? f(ga - gb) : null, pct: ga ? Math.round((100 * (ga - gb)) / ga) : null, cpuMs: f(cpuB), dCpuMs: f(cpuA - cpuB), calls: info.calls, tris: info.tris };
    };
    // Keep the GPU busy for a moment so it is at full clock.
    for (let i = 0; i < 3; i++) await bench(60);
    const hideAll = (list) => {
      const shown = list.filter((o) => o && o.visible);
      shown.forEach((o) => (o.visible = false));
      return () => shown.forEach((o) => (o.visible = true));
    };
    const find = (pred) => {
      const out = [];
      sc.traverse((o) => pred(o) && out.push(o));
      return out;
    };
    const floor = sc.getObjectByName('floor');
    const lights = find((o) => o.isLight && o.visible);
    const configs = {
      'hide library': () => hideAll([sc.getObjectByName('library')]),
      'hide floor': () => hideAll([floor]),
      'hide creatures': () => hideAll((g.enemies ?? []).map((x) => x.root)),
      'hide effects': () => hideAll([g.effects?.root]),
      'hide defenders': () => hideAll([sc.getObjectByName('wizard'), sc.getObjectByName('robot')]),
      'hide sprites': () => hideAll(find((o) => o.isSprite)),
      'hide transparent': () => hideAll(find((o) => (o.isMesh || o.isSprite) && o.material && !Array.isArray(o.material) && o.material.transparent)),
      'hide shields': () => hideAll(find((o) => o.isMesh && o.material?.uniforms?.runes)),
      ...Object.fromEntries(
        (sc.getObjectByName('library')?.children ?? [])
          .filter((o) => o.isMesh && o.visible)
          .map((o, i) => [`library part ${i}: ${o.isInstancedMesh ? `inst×${o.count} ` : ''}${o.material?.type}${o.material?.transparent ? ' transparent' : ''}`, () => hideAll([o])]),
      ),
      ...Object.fromEntries(lights.map((l, i) => [`light off: ${l.type}${l.name ? ' ' + l.name : ''} #${i}`, () => hideAll([l])])),
      'floor without bump': () => {
        const m = floor?.material;
        const b = m?.bumpMap;
        if (!m || !b) return () => {};
        m.bumpMap = null;
        m.needsUpdate = true;
        return () => {
          m.bumpMap = b;
          m.needsUpdate = true;
        };
      },
      'floor anisotropy 2': () => {
        const t = floor?.material?.map;
        if (!t) return () => {};
        const a = t.anisotropy;
        t.anisotropy = 2;
        t.needsUpdate = true;
        return () => {
          t.anisotropy = a;
          t.needsUpdate = true;
        };
      },
      'floor unlit (Basic, same map)': () => {
        const Basic = find((o) => o.material?.isMeshBasicMaterial)[0]?.material.constructor;
        const m = floor?.material;
        if (!Basic || !m) return () => {};
        floor.material = new Basic({ map: m.map });
        return () => (floor.material = m);
      },
      'floor drawn after opaques': () => {
        if (!floor) return () => {};
        const o = floor.renderOrder;
        floor.renderOrder = 5;
        return () => (floor.renderOrder = o);
      },
      'ACES without warm grade': () => {
        const tm = r.toneMapping;
        r.toneMapping = 4; // ACESFilmicToneMapping
        return () => (r.toneMapping = tm);
      },
      'toon -> Lambert': () => {
        const Lambert = find((o) => o.material?.isMeshLambertMaterial)[0]?.material.constructor;
        if (!Lambert) return () => {};
        const swaps = [];
        const cache = new Map();
        sc.traverse((o) => {
          const m = o.material;
          if (!m || !m.isMeshToonMaterial) return;
          let l = cache.get(m);
          if (!l) {
            l = new Lambert({ color: m.color, map: m.map, vertexColors: m.vertexColors, side: m.side });
            cache.set(m, l);
          }
          swaps.push([o, m]);
          o.material = l;
        });
        return () => swaps.forEach(([o, m]) => (o.material = m));
      },
    };
    const rows = { 'full frame (A/A noise check)': await ab(() => () => {}) };
    for (const [name, apply] of Object.entries(configs)) rows[name] = await ab(apply);

    // Triangles per mesh (instances included) for the library and the creatures.
    const tri = (o) => {
      const geo = o.geometry;
      if (!geo || !o.isMesh) return 0;
      const n = geo.index ? geo.index.count : geo.attributes.position?.count ?? 0;
      const count = o.isInstancedMesh ? o.count : geo.isInstancedBufferGeometry ? geo.instanceCount : 1;
      return Math.round(n / 3) * count;
    };
    const meshes = (root) => {
      const out = {};
      root?.traverse((o) => {
        if (!o.isMesh || !o.visible) return;
        const m = o.material;
        const key = `${o.name || o.parent?.name || ''} ${o.isInstancedMesh ? `inst×${o.count}` : ''} ${m?.type ?? ''}${m?.transparent ? ' transparent' : ''}`.trim();
        const row = (out[key] ??= { meshes: 0, tris: 0 });
        row.meshes++;
        row.tris += tri(o);
      });
      return out;
    };
    const library = meshes(sc.getObjectByName('library'));
    const creatures = {};
    for (const en of g.enemies ?? []) {
      let draws = 0;
      let tris = 0;
      en.root.traverse((o) => {
        if (o.isMesh && o.visible && (!o.material || o.material.visible !== false)) {
          draws++;
          tris += tri(o);
        }
      });
      const row = (creatures[en.kind] ??= { count: 0, draws: 0, tris: 0 });
      row.count++;
      row.draws += draws;
      row.tris += tris;
    }
    if (benchRatio) {
      r.setPixelRatio(ratio0);
      e.fit();
    }
    e.start(e.onFrame);
    window.__pauseStage = false;
    return { gpuTimer: !!tq, benchRatio: benchRatio ?? ratio0, rows, library, creatures };
  }, benchRatio);
}

async function run(kind) {
  const phone = kind === 'phone';
  const [W, H] = phone ? [390, 844] : [1536, 1024];
  const context = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: phone ? 3 : 1,
    isMobile: phone,
    hasTouch: phone,
    userAgent: phone ? 'Mozilla/5.0 (Linux; Android 14; Pixel 7a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36' : undefined,
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(seedScript, seed);
  await page.goto(base + '/' + (args.quality ? `?quality=${args.quality}` : ''), { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ww?.engine, null, { timeout: 30_000 });
  await page.waitForTimeout(500);
  const cdp = await context.newCDPSession(page);
  if (phone && cpu > 1) {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
  }
  const staged = await stage(page);
  await page.waitForTimeout(2000);
  const m = await measure(page, seconds * 1000);
  if (args.shot) {
    const shot = join(OUT, `fps-${scene}-${kind}${args.quality ? '-' + args.quality : ''}${args.shot === true ? '' : '-' + args.shot}.png`);
    await page.screenshot({ path: shot });
    console.error(`screenshot: ${shot}`);
  }
  if (phone && cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 }); // the GPU benchmark wants a steady CPU
  const prof = args.profile ? await profile(page, args['bench-ratio'] ? Number(args['bench-ratio']) : null) : undefined;
  await context.close();
  return { device: kind, size: `${W}x${H}${phone ? `@3x cpu/${cpu}` : ''}`, staged, ...m, profile: prof, errors };
}

// ---- main ------------------------------------------------------------------------------------------------------
let exitCode = 0;
try {
  mkdirSync(OUT, { recursive: true });
  await waitForVite();
  const guess = `${process.env.LOCALAPPDATA}/ms-playwright/chromium-1208/chrome-win64/chrome.exe`;
  const executablePath = args.chrome || (existsSync(guess) ? guess : undefined);
  const flags = ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'];
  if (!args.vsync) flags.push('--disable-gpu-vsync', '--disable-frame-rate-limit');
  browser = await chromium.launch({ executablePath, headless: !args.headed, args: flags });
  const kinds = device === 'both' ? ['desktop', 'phone'] : [device];
  const results = [];
  for (const k of kinds) results.push(await run(k));
  const out = { scene, seconds, ratio: ratio ?? 'governor', vsync: !!args.vsync, when: new Date().toISOString(), results };
  const path = join(OUT, `fps-${scene}.json`);
  writeFileSync(path, JSON.stringify(out, null, 2));
  if (args.json) console.log(JSON.stringify(out, null, 2));
  else {
    for (const r of results) {
      const { profile: prof, staged, errors, ...flat } = r;
      console.log(`\n== ${r.device} ${r.size}  gpu: ${staged.gpu}${staged.gpuTimer ? '' : ' (no GPU timer)'}  enemies: ${staged.enemies}${staged.notes.length ? '  notes: ' + staged.notes.join('; ') : ''}`);
      console.table({ [r.device]: Object.fromEntries(Object.entries(flat).filter(([k]) => !['device', 'size'].includes(k))) });
      if (prof) {
        console.log(`frozen-frame GPU benchmark at pixel ratio ${prof.benchRatio} (median ms per render; dGpuMs/pct = what the removed thing costs; the A/A row shows the noise):`);
        console.table(prof.rows);
        console.log('library meshes:');
        console.table(prof.library);
        console.log('creatures:');
        console.table(prof.creatures);
      }
      if (errors.length) console.log(`page errors:\n  ${errors.join('\n  ')}`);
    }
    console.log(`wrote ${path}`);
  }
  if (results.some((r) => r.errors.length)) exitCode = 2;
} catch (err) {
  console.error(`fps failed: ${err.stack ?? err}`);
  exitCode = 1;
} finally {
  await cleanup();
}
process.exit(exitCode);
