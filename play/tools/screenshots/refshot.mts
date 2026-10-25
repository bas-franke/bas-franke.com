// Reference-shot harness for Last Light (dev tool, not part of `npm run screenshots`): renders the hotel atrium from a fixed
// first-person vantage at the size of a target image, writes the shot, a side-by-side with the target and similarity
// numbers, so visual work can be judged "closer or further" against a reference picture.
//
//   node backend/node_modules/tsx/dist/cli.mjs tools/screenshots/refshot.mts --out <dir> [options]   (from play/, Node 22+)
//
// Options:
//   --out <dir>            where shot.jpg, side.jpg and score.json go (default: ./refshot-out)
//   --target <file>        reference image (default: $REFSHOT_TARGET or the lobby target in the session scratchpad)
//   --quality high|medium|low   game graphics quality (default high)
//   --nohud                hide the HUD (viewmodel stays)
//   --cam x,z,yaw,pitch[,fov]   player position (feet, metres) and view (radians; yaw 0 = north, + turns left), fov in degrees (vertical)
//   --bot1 x,z,yaw[,pitch] / --bot2 ...   where the two visible teammates stand (bot1 = Botticelli, bot2 = Sgt. Pepper)
//   --zombies              keep the zombies (default: none, like the target)
//   --settle <ms>          wait after posing before the shot (default 2500)
//   --serve                only start backend + Vite on the ports and keep them running (Ctrl+C / kill to stop)
//   --keep                 start the servers detached when they are not up yet and leave them running after the shot
//   --headful --verbose --browser chrome|msedge|chromium
//
// Ports: REFSHOT_BACKEND_PORT / REFSHOT_FRONTEND_PORT (default 3060 / 5260). When both already answer (a `--serve` or
// `--keep` run), the shot reuses them, which saves the ~10 s server start. The dev server watches files, so edits made
// since show up in the next shot (a fresh page each run).
//
// How the framing works without touching the game: the dev build exposes the client as window.__zombies; this tool
// wraps its onMessage so every server snapshot is rewritten before the client sees it (our position, the teammates'
// positions/poses/weapons, wave 5 with 67 left, MP5SD with 40/277, 1860 points, no zombies, no events), renames the
// bots through ctx.room(), and sets yaw/pitch/fov on the client. The server's match goes on unseen.

import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { type BrowserContext, type Page, chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tsxCli = path.join(root, 'backend/node_modules/tsx/dist/cli.mjs');
const viteEntry = path.join(root, 'frontend/node_modules/vite/dist/node/index.js');

const argv = process.argv.slice(2);
const option = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] ?? '') : undefined;
};
const flag = (name: string) => argv.includes(`--${name}`);
const nums = (s: string | undefined) => (s ? s.split(',').map(Number) : undefined);

const BACKEND_PORT = Number(process.env.REFSHOT_BACKEND_PORT ?? 3060);
const FRONTEND_PORT = Number(process.env.REFSHOT_FRONTEND_PORT ?? 5260);
const DEFAULT_TARGET = 'C:/Users/buunn/AppData/Local/Temp/claude/C--Projects-bas-franke-com/6d2f0dca-f6ce-459f-af70-07900d270e46/ref/lobby_target.webp';
const target = path.resolve(option('target') ?? process.env.REFSHOT_TARGET ?? DEFAULT_TARGET);
const outDir = path.resolve(option('out') ?? 'refshot-out');
const quality = option('quality') ?? 'high';
const noHud = flag('nohud');
const serveOnly = flag('serve');
const keep = flag('keep');
const headless = !flag('headful');
const verbose = flag('verbose');
const settle = Number(option('settle') ?? 2500);
/** ANGLE backend: OpenGL compiles the game's shaders much faster than D3D11's FXC (which can stall loading long enough to drop the socket). */
const angle = option('angle');
const WIDTH = 1728;
const HEIGHT = 910;

// Fitted against the target's columns (x = ±6, z = -4/-12) and the centrepiece (0, -8).
const DEFAULT_CAM = [3.2, 0.3, 0.075, -0.03, 72];
const DEFAULT_BOT1 = [0.4, -3.3, -0.15, 0];
const DEFAULT_BOT2 = [5.0, -10.4, 0, 0];
const bot1 = nums(option('bot1')) ?? DEFAULT_BOT1;
const bot2 = nums(option('bot2')) ?? DEFAULT_BOT2;
interface Pose {
  spec: string;
  cam: number[];
  bots: number[][];
}
/**
 * --cam one pose, or --cams "pose;pose;..." for several shots from one match (shot-1.jpg, side-1.jpg, ...). A pose is
 * "x,z,yaw,pitch,fov", optionally followed by "@bot1@bot2" ("x,z,yaw[,pitch]") to move the teammates for that shot.
 */
const cams: Pose[] = (option('cams')?.split(';').filter(Boolean) ?? [option('cam') ?? DEFAULT_CAM.join(',')]).map((spec) => {
  const [c, b1, b2] = spec.split('@').map((p) => (p ? p.split(',').map(Number) : undefined));
  const cam = c!.length >= 5 ? c! : [...c!, ...DEFAULT_CAM.slice(c!.length)];
  return { spec, cam, bots: [b1 ?? bot1, b2 ?? bot2] };
});

const log = (m: string) => console.log(`[refshot] ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function fail(message: string): never {
  console.error(`\n[refshot] ${message}`);
  shutdown();
  process.exit(1);
}

// ---- servers -----------------------------------------------------------------------------------------------------

const api = `http://127.0.0.1:${BACKEND_PORT}`;
const site = `http://127.0.0.1:${FRONTEND_PORT}`;
const children: ChildProcess[] = [];
let shuttingDown = false;

/** Vite through its JS API: the normal frontend config, our port, /api proxied to our backend, no HMR but file watching on. */
const viteScript = `
const { createServer } = await import(${JSON.stringify(pathToFileURL(viteEntry).href)});
const server = await createServer({
  configFile: ${JSON.stringify(path.join(root, 'frontend/vite.config.ts'))},
  root: ${JSON.stringify(path.join(root, 'frontend'))},
  clearScreen: false,
  // Own dependency cache per port: other dev servers on the same checkout re-optimising the shared one break pages.
  cacheDir: ${JSON.stringify(path.join(root, `frontend/node_modules/.vite-refshot-${FRONTEND_PORT}`))},
  server: { host: '127.0.0.1', port: ${FRONTEND_PORT}, strictPort: true, hmr: false,
    proxy: { '/api': { target: 'http://127.0.0.1:${BACKEND_PORT}', ws: false } } },
});
await server.listen();
// The game socket goes through a relay that answers the backend's heartbeat pings itself: a page busy compiling
// shaders for half a minute stops reading its socket, and the backend would drop it for missing pongs.
const { WebSocketServer, WebSocket } = (await import(${JSON.stringify(pathToFileURL(path.join(root, 'backend/node_modules/ws/index.js')).href)})).default;
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
server.httpServer.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/api/ws')) return;
  wss.handleUpgrade(req, socket, head, (client) => {
    const up = new WebSocket('ws://127.0.0.1:${BACKEND_PORT}' + req.url, { perMessageDeflate: false });
    const queue = [];
    up.on('open', () => { for (const [d, b] of queue.splice(0)) up.send(d, { binary: b }); });
    up.on('message', (d, b) => client.readyState === 1 && client.send(d, { binary: b }));
    client.on('message', (d, b) => (up.readyState === 1 ? up.send(d, { binary: b }) : queue.push([d, b])));
    up.on('close', (code, reason) => client.readyState <= 1 && client.close(code >= 1000 && code < 5000 && code !== 1005 && code !== 1006 ? code : 1000, reason));
    client.on('close', () => up.readyState <= 1 && up.terminate());
    up.on('error', () => client.terminate());
    client.on('error', () => up.terminate());
  });
});
console.log('vite ready');
`;

function start(name: string, args: string[], env: NodeJS.ProcessEnv, detached: boolean) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: detached ? 'ignore' : ['ignore', 'pipe', 'pipe'],
    detached,
    windowsHide: true,
  });
  if (detached) {
    child.unref();
    return;
  }
  children.push(child);
  child.stdout?.on('data', (c: Buffer) => verbose && process.stdout.write(`[${name}] ${c}`));
  child.stderr?.on('data', (c: Buffer) => process.stderr.write(`[${name}] ${c}`));
  child.on('exit', (code) => {
    if (!shuttingDown && code) fail(`${name} exited with code ${code}.`);
  });
}

function shutdown() {
  shuttingDown = true;
  for (const c of children) if (c.exitCode === null) c.kill();
}
process.on('exit', shutdown);
process.on('SIGINT', () => {
  shutdown();
  process.exit(130);
});

async function up(url: string) {
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
}
async function waitFor(url: string, what: string, timeoutMs = 90_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await up(url)) return;
    await sleep(300);
  }
  fail(`${what} did not answer at ${url} within ${timeoutMs / 1000}s.`);
}

async function ensureServers() {
  const backendUp = await up(`${api}/api/health`);
  const viteUp = await up(site);
  if (backendUp && viteUp) {
    log(`reusing servers on ${BACKEND_PORT}/${FRONTEND_PORT}`);
    return;
  }
  if (backendUp !== viteUp) fail(`Only one of the ports ${BACKEND_PORT}/${FRONTEND_PORT} answers; free them or pick other REFSHOT_*_PORT values.`);
  const detached = keep;
  log(`starting backend on ${BACKEND_PORT} and Vite on ${FRONTEND_PORT}${detached ? ' (detached, left running)' : ''}`);
  start('backend', [tsxCli, 'backend/src/index.ts'], { PORT: String(BACKEND_PORT), HOST: '127.0.0.1', CREATE_RATE_LIMIT: '1000' }, detached);
  await waitFor(`${api}/api/health`, 'The backend');
  start('vite', ['--input-type=module', '-e', viteScript], {}, detached);
  await waitFor(site, 'The dev server');
}

// ---- browser -----------------------------------------------------------------------------------------------------

/**
 * A persistent profile per frontend port keeps Chrome's GPU shader cache between runs: the first load compiles
 * every shader (minutes under load on D3D11), later ones mostly hit the cache.
 */
async function launch(): Promise<BrowserContext> {
  const userDataDir = path.join(os.tmpdir(), `refshot-chrome-${FRONTEND_PORT}`);
  const pref = option('browser');
  const errors: string[] = [];
  for (const channel of pref ? [pref] : ['chrome', 'msedge', 'chromium']) {
    try {
      return await chromium.launchPersistentContext(userDataDir, {
        channel: channel === 'chromium' ? undefined : channel,
        headless,
        viewport: { width: WIDTH, height: HEIGHT },
        deviceScaleFactor: 1,
        args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', ...(angle ? [`--use-angle=${angle}`] : []), '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows'],
      });
    } catch (e) {
      errors.push(`  ${channel}: ${(e as Error).message.split('\n')[0]}`);
    }
  }
  return fail(`No browser could be started:\n${errors.join('\n')}`);
}

async function createRoom(): Promise<string> {
  const res = await fetch(`${api}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'refshot', game: 'zombies', maxPlayers: 8, bots: 3, botDifficulty: 'normal', map: 'hotel' }),
  });
  if (!res.ok) fail(`Creating a room failed: HTTP ${res.status} ${await res.text()}`);
  return ((await res.json()) as { room: { code: string } }).room.code;
}

interface Stage {
  cam: number[];
  bots: number[][];
  names: string[];
  colors: number[];
  zombies: boolean;
  banner?: boolean;
}

/** Runs in the page: rewrites snapshots and the room so the client shows the staged scene. */
function stage(cfg: Stage) {
  type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
  const c = (window as Any).__zombies as Any;
  const you: string = c.ctx.you;
  const room0 = c.ctx.room.bind(c.ctx);
  const bots = () => (room0().players as Any[]).filter((p) => p.id !== you).map((p) => p.id as string);
  const rename = (room: Any) => ({
    ...room,
    players: room.players.map((p: Any) => {
      const i = bots().indexOf(p.id);
      if (p.id === you) return { ...p, name: 'Marvin' };
      return i >= 0 && i < cfg.names.length ? { ...p, name: cfg.names[i], color: cfg.colors[i] ?? p.color } : p;
    }),
  });
  c.ctx.room = () => rename(room0());
  const onRoom = c.onRoom.bind(c);
  c.onRoom = (room: Any) => onRoom(rename(room));
  for (const id of [...c.remotes.keys()]) c.removeRemote(id);

  (window as Any).__refshot = cfg;
  const patch = (s: Any) => {
    const cfg = (window as Any).__refshot as Stage;
    const [cx, cz] = cfg.cam;
    s.wave = 5;
    s.ph = 'wave';
    s.left = 67;
    if (!cfg.zombies) s.zb = [];
    const ids = bots();
    for (const p of s.pl) {
      for (const k of ['a', 'r', 'sp', 'u']) delete p[k];
      p.v = [0, 0, 0];
      p.w = 'mp7';
      p.st = 0;
      if (p.id === you) {
        p.p = [cx, 0, cz];
        continue;
      }
      const pose = cfg.bots[ids.indexOf(p.id)];
      if (!pose) {
        p.st = 2;
        p.p = [0, 0, 17];
        continue;
      }
      p.p = [pose[0], 0, pose[1]];
      p.y = pose[2];
      p.pt = pose[3] ?? 0;
    }
    if (s.me) Object.assign(s.me, { hp: 100, ar: 0, pts: 1860, sl: ['mp7', 'm1911'], cur: 0, mag: [40, 8], res: [277, 64], rl: 0, bo: undefined, pr: undefined });
  };
  const onMessage = c.onMessage.bind(c);
  c.onMessage = (m: Any) => {
    if (m.k === 'ev' || m.k === 'score' || m.k === 'end') return;
    if (m.k === 'snap') patch(m.s);
    onMessage(m);
  };
  c.me.pending = [];
  const updateCamera = c.updateCamera.bind(c);
  c.updateCamera = (dt: number, now: number) => {
    const cfg = (window as Any).__refshot as Stage & { banner?: boolean };
    const [, , yaw, pitch, fov] = cfg.cam;
    // The wave banner stays fully faded in (it normally lives 3.8 s).
    if (cfg.banner) c.hud.get().banner && performance.now() - c.hud.get().banner.at > 1500 && c.hud.set({ banner: { text: 'Wave 5', sub: 'They are coming', at: performance.now() - 1200 } });
    c.me.yaw = yaw;
    c.me.pitch = pitch;
    updateCamera(dt, now);
    const cm = c.engine.camera;
    if (fov && cm.fov !== fov) {
      cm.fov = fov;
      cm.updateProjectionMatrix();
    }
  };
  const ids = bots();
  const scores = [
    { id: you, points: 1860 },
    { id: ids[0], points: 3020 },
    { id: ids[2], points: 2300 },
    { id: ids[1], points: 2890 },
  ].filter((s) => s.id).map((s) => ({ ...s, kills: Math.round(s.points / 60), heads: 0, downs: 0, revives: 0 }));
  c.hud.set({ scores, feed: [], popups: [], banner: { text: 'Wave 5', sub: 'They are coming', at: performance.now() - 1200 }, deny: null, prompt: null });
}

// ---- comparison --------------------------------------------------------------------------------------------------

interface Score {
  score: number;
  ssim: number;
  mae: number;
  hist: number;
  lumTarget: number;
  lumShot: number;
  grid: number[][];
}

/** Runs in a blank page: scores the shot against the target and returns the side-by-side as a JPEG data URL. */
async function compare(a: { target: string; shot: string; w: number; h: number }): Promise<{ s: Score; side: string }> {
  const load = (src: string) =>
    new Promise<HTMLImageElement>((ok, bad) => {
      const i = new Image();
      i.onload = () => ok(i);
      i.onerror = () => bad(new Error('image load failed'));
      i.src = src;
    });
  const [t, s] = await Promise.all([load(a.target), load(a.shot)]);
  const pixels = (img: HTMLImageElement, w: number, h: number) => {
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const g = cv.getContext('2d')!;
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, 0, 0, w, h);
    return g.getImageData(0, 0, w, h).data;
  };
  const gray = (d: Uint8ClampedArray) => {
    const o = new Float32Array(d.length / 4);
    for (let i = 0; i < o.length; i++) o[i] = 0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2];
    return o;
  };
  const W = 216;
  const H = 114;
  const gt = gray(pixels(t, W, H));
  const gs = gray(pixels(s, W, H));
  let mae = 0;
  for (let i = 0; i < gt.length; i++) mae += Math.abs(gt[i] - gs[i]);
  mae /= gt.length;
  // SSIM over 8×8 windows (stride 4), averaged over two scales (216×114 and 108×57) so fine detail that can never
  // line up (marble cracks, city windows) weighs less than layout and large shapes.
  const C1 = (0.01 * 255) ** 2;
  const C2 = (0.03 * 255) ** 2;
  const ssimAt = (a: Float32Array, b: Float32Array, W: number, H: number) => {
    let sum = 0;
    let n = 0;
    for (let y = 0; y + 8 <= H; y += 4)
      for (let x = 0; x + 8 <= W; x += 4) {
        let ma = 0;
        let mb = 0;
        for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) (ma += a[(y + j) * W + x + i]), (mb += b[(y + j) * W + x + i]);
        ma /= 64;
        mb /= 64;
        let va = 0;
        let vb = 0;
        let cov = 0;
        for (let j = 0; j < 8; j++)
          for (let i = 0; i < 8; i++) {
            const da = a[(y + j) * W + x + i] - ma;
            const db = b[(y + j) * W + x + i] - mb;
            va += da * da;
            vb += db * db;
            cov += da * db;
          }
        sum += ((2 * ma * mb + C1) * (2 * cov / 63 + C2)) / ((ma * ma + mb * mb + C1) * (va / 63 + vb / 63 + C2));
        n++;
      }
    return sum / n;
  };
  const ssim = 0.5 * ssimAt(gt, gs, W, H) + 0.5 * ssimAt(gray(pixels(t, W / 2, H / 2 + 0.5 | 0)), gray(pixels(s, W / 2, H / 2 + 0.5 | 0)), W / 2, H / 2 + 0.5 | 0);
  // Colour histogram: 6×6×6 RGB bins at 432×228, half the L1 distance (0 = same palette, 1 = disjoint).
  const hw = 432;
  const hh = 228;
  const hist = (d: Uint8ClampedArray) => {
    const h = new Float32Array(216);
    for (let i = 0; i < d.length; i += 4) h[Math.floor(d[i] / 42.67) * 36 + Math.floor(d[i + 1] / 42.67) * 6 + Math.floor(d[i + 2] / 42.67)]++;
    for (let i = 0; i < h.length; i++) h[i] /= d.length / 4;
    return h;
  };
  const ht = hist(pixels(t, hw, hh));
  const hs = hist(pixels(s, hw, hh));
  let hd = 0;
  for (let i = 0; i < ht.length; i++) hd += Math.abs(ht[i] - hs[i]);
  hd /= 2;
  // Mean luminance per 3×3 cell: shot minus target (positive = shot brighter).
  const grid: number[][] = [];
  for (let gy = 0; gy < 3; gy++) {
    const row: number[] = [];
    for (let gx = 0; gx < 3; gx++) {
      let d = 0;
      let k = 0;
      for (let y = Math.floor((gy * H) / 3); y < Math.floor(((gy + 1) * H) / 3); y++)
        for (let x = Math.floor((gx * W) / 3); x < Math.floor(((gx + 1) * W) / 3); x++) (d += gs[y * W + x] - gt[y * W + x]), k++;
      row.push(Math.round(d / k));
    }
    grid.push(row);
  }
  const mean = (g: Float32Array) => g.reduce((p, v) => p + v, 0) / g.length;
  const score = 100 * (0.4 * ssim + 0.3 * Math.max(0, 1 - mae / 64) + 0.3 * (1 - hd));
  // Side by side, target left, shot right, at the full size.
  const cv = document.createElement('canvas');
  cv.width = a.w * 2;
  cv.height = a.h;
  const g = cv.getContext('2d')!;
  g.drawImage(t, 0, 0, a.w, a.h);
  g.drawImage(s, a.w, 0, a.w, a.h);
  g.font = 'bold 22px sans-serif';
  g.fillStyle = 'rgba(0,0,0,0.6)';
  g.fillRect(0, 0, 120, 34);
  g.fillRect(a.w, 0, 420, 34);
  g.fillStyle = '#fff';
  g.fillText('TARGET', 10, 25);
  g.fillText(`SHOT  score ${score.toFixed(1)}`, a.w + 10, 25);
  return {
    s: { score, ssim, mae, hist: hd, lumTarget: mean(gt), lumShot: mean(gs), grid },
    side: cv.toDataURL('image/jpeg', 0.85),
  };
}

// ---- main --------------------------------------------------------------------------------------------------------

if (!existsSync(tsxCli) || !existsSync(viteEntry)) fail('Dependencies are missing. Run `npm run install:all` in play/ first.');
if (!serveOnly && !existsSync(target)) fail(`Target image not found: ${target}`);
if (!['high', 'medium', 'low'].includes(quality)) fail('--quality is high, medium or low');

await ensureServers();
if (serveOnly) {
  log(`serving: backend ${api}, Vite ${site}. Leave this running; shots with the same REFSHOT_*_PORT reuse it.`);
  await new Promise(() => undefined);
}

const t0 = Date.now();
const context = await launch();
// The dev server watches files (other sessions edit them), and Vite's client would reload the page on every change.
// Its reloads are patched to be skipped once window.__refshotNoReload is set (after the match starts); before that
// they go through (the dependency optimiser needs one on a cold cache).
await context.route(/\/@vite\/client(\?|$)/, async (route) => {
  const res = await route.fetch();
  const body = (await res.text()).replaceAll('location.reload()', '(window.__refshotNoReload || location.reload())');
  await route.fulfill({ response: res, body });
});
// tsx (esbuild keepNames) wraps named inner functions in __name(); functions sent to page.evaluate need it to exist.
await context.addInitScript('window.__name = (f) => f;');
await context.addInitScript((q) => {
  localStorage.setItem('play.name', 'Marvin');
  localStorage.setItem('lastlight.quality.v1', q);
}, quality);
const page: Page = await context.newPage();
page.on('pageerror', (e) => console.error(`[page] ${e.message}`));
if (verbose) {
  page.on('console', (m) => !m.text().includes('GL_INVALID') && console.log(`[console.${m.type()}] ${m.text().slice(0, 300)}`));
  page.on('websocket', (ws) => {
    log(`websocket ${ws.url()}`);
    ws.on('close', () => log(`websocket closed ${ws.url()}`));
  });
  page.on('framenavigated', (f) => f === page.mainFrame() && log(`navigated ${f.url()}`));
}
await page.goto(`${site}/room/${await createRoom()}`, { waitUntil: 'domcontentloaded' });
await page.getByTestId('start').click({ timeout: 90_000 });
await page.evaluate(() => ((window as unknown as { __refshotNoReload: boolean }).__refshotNoReload = true));
await page
  .waitForFunction(() => (window as unknown as { __zombies?: { hud: { get(): { ready: boolean } } } }).__zombies?.hud.get().ready === true, null, {
    timeout: 120_000,
    polling: 250,
  })
  .catch(async () => {
    mkdirSync(outDir, { recursive: true });
    await page.screenshot({ path: path.join(outDir, 'stuck.jpg'), type: 'jpeg' });
    const state = await page.evaluate(() => {
      const c = (window as unknown as { __zombies?: { hud: { get(): unknown } } }).__zombies;
      return c ? JSON.stringify(c.hud.get()).slice(0, 400) : `no window.__zombies (url ${location.href})`;
    });
    fail(`The match did not get ready in 120 s: ${state}. Screenshot: ${path.join(outDir, 'stuck.jpg')}`);
  });
// The bots' survivors come in once their models are ready and the first snapshots are in.
await page.waitForFunction(() => ((window as unknown as { __zombies: { remotes: Map<string, unknown> } }).__zombies.remotes.size ?? 0) >= 2, null, { timeout: 60_000 }).catch(() => log('teammates did not show up; shooting anyway'));
log(`match ready after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
await page.addStyleTag({ content: `.hint-bar, .menu-hint, .hud .out, .ll-feed { display: none !important; }${noHud ? ' .hud, .ll-hud { display: none !important; }' : ''}` });
const names = ['Botticelli', 'Sgt. Pepper', 'Trustar'];
const colors = [0xff5a3c, 0x46e0b4, 0xf2c94c];
await page.evaluate(stage, { cam: cams[0].cam, bots: cams[0].bots, names, colors, zombies: flag('zombies'), banner: true } as Stage);
mkdirSync(outDir, { recursive: true });
const cmp = await context.newPage();
const ext = path.extname(target).slice(1).toLowerCase();
const targetUrl = `data:${ext === 'jpg' ? 'image/jpeg' : `image/${ext}`};base64,${readFileSync(target).toString('base64')}`;
const results: (Score & Pose)[] = [];
for (let i = 0; i < cams.length; i++) {
  const suffix = cams.length > 1 ? `-${i + 1}` : '';
  await page.evaluate((v) => {
    Object.assign((window as unknown as { __refshot: object }).__refshot, v);
  }, cams[i]);
  // Settle: snapshots carry the new pose, shadows/TAA/exposure catch up.
  await sleep(i === 0 ? settle : Math.max(1200, settle / 2));
  if (verbose)
    log(
      `remotes: ${await page.evaluate(() =>
        JSON.stringify(
          [...(window as unknown as { __zombies: { remotes: Map<string, { name: string; pos: { x: number; z: number }; yaw: number; inst: { root: { visible: boolean } } }> } }).__zombies.remotes.values()].map((r) => [
            r.name,
            +r.pos.x.toFixed(2),
            +r.pos.z.toFixed(2),
            +r.yaw.toFixed(2),
            r.inst.root.visible,
          ]),
        ),
      )}`,
    );
  const t1 = Date.now();
  const shotBuf = await page.screenshot({ type: 'jpeg', quality: 90 });
  writeFileSync(path.join(outDir, `shot${suffix}.jpg`), shotBuf);
  if (verbose) log(`screenshot took ${Date.now() - t1} ms`);
  const { s, side } = await cmp.evaluate(compare, { target: targetUrl, shot: `data:image/jpeg;base64,${shotBuf.toString('base64')}`, w: WIDTH, h: HEIGHT });
  writeFileSync(path.join(outDir, `side${suffix}.jpg`), Buffer.from(side.split(',')[1], 'base64'));
  results.push({ ...s, ...cams[i] });
  if (cams.length > 1) log(`${suffix.slice(1)}: SCORE ${s.score.toFixed(2)} (ssim ${s.ssim.toFixed(3)}, mae ${s.mae.toFixed(1)}, hist ${s.hist.toFixed(3)}) ${cams[i].spec}`);
}
await context.close();
const s = results.length === 1 ? results[0] : [...results].sort((a, b) => b.score - a.score)[0];
writeFileSync(path.join(outDir, 'score.json'), `${JSON.stringify({ ...s, all: results.length > 1 ? results : undefined, quality, hud: !noHud, at: new Date().toISOString() }, null, 2)}
`);
if (results.length > 1) log(`best: ${s.spec}`);
console.log(`[refshot] SCORE ${s.score.toFixed(2)}  (ssim ${s.ssim.toFixed(3)}, mae ${s.mae.toFixed(1)}, hist ${s.hist.toFixed(3)}; higher score = closer)`);
console.log(`[refshot] mean luminance: target ${s.lumTarget.toFixed(1)}, shot ${s.lumShot.toFixed(1)}`);
console.log(`[refshot] luminance shot-minus-target per 3x3 cell (rows top..bottom): ${s.grid.map((r) => r.join(' ')).join(' | ')}`);
console.log(`[refshot] wrote shot/side jpgs and score.json to ${outDir} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
shutdown();
process.exit(0);
