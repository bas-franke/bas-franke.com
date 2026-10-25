// Takes the screenshots the lobby shows for each game: a few Rockets maps, every Ruckus minigame and every Last Light map, captured from
// a real match against bots in a headless browser, and a few Dustrunners tracks mid-race with the AI flying. Starts its own backend and dev server on spare ports, so a dev
// server you have open is left alone.
//
//   npm run screenshots                          everything
//   npm run screenshots -- --only rockets        one game (rockets, ruckus, zombies, dustrunners)
//   npm run screenshots -- --maps foundry,orbit  which Rockets maps (default below)
//   npm run screenshots -- --browser msedge      chrome | msedge | chromium (default: first one that starts)
//   npm run screenshots -- --headful --verbose   watch it happen / see server output
//
// Output: frontend/public/screenshots/<game>-<variant>.jpg and frontend/src/games/screenshots.json.
// See ../../SCREENSHOTS.md for when to run this and how to add a game.

import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, type BrowserContext, type Page, chromium } from 'playwright';
import { GAME_IDS, GAMES, SOLO_GAME_IDS, SOLO_GAMES, type GameId, type SoloGameId } from '../../backend/src/shared/protocol.js';
import { MAP_LIST } from '../../backend/src/shared/rockets/maps.js';
import { MINIGAME_IDS, MINIGAMES, type MinigameId } from '../../backend/src/shared/ruckus/world.js';
import { ZMAP_LIST } from '../../backend/src/shared/zombies/maps.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outDir = path.join(root, 'frontend/public/screenshots');
const manifestPath = path.join(root, 'frontend/src/games/screenshots.json');
const tsxCli = path.join(root, 'backend/node_modules/tsx/dist/cli.mjs');
const viteCli = path.join(root, 'frontend/node_modules/vite/bin/vite.js');

const BACKEND_PORT = Number(process.env.PLAY_SHOT_BACKEND_PORT ?? 3034);
const FRONTEND_PORT = Number(process.env.PLAY_SHOT_FRONTEND_PORT ?? 5205);
const WIDTH = 1280;
const HEIGHT = 720;
const JPEG_QUALITY = 84;
/** Rockets maps shown by default: a classic arena, a floating one, a warm one and the space one. */
const DEFAULT_MAPS = ['foundry', 'skyway', 'canyon', 'orbit'];
/** Bots in the room (plus you): enough for action in every shot. */
const BOTS = 5;

interface Shot {
  file: string;
  caption: string;
}
type AnyGame = GameId | SoloGameId;
type Manifest = Partial<Record<AnyGame, Shot[]>>;
const ALL_IDS: AnyGame[] = [...GAME_IDS, ...SOLO_GAME_IDS];
const gameName = (id: AnyGame) => (id in GAMES ? GAMES[id as GameId] : SOLO_GAMES[id as SoloGameId]).name;

// ---- arguments ---------------------------------------------------------------------------------------------------

const argv = process.argv.slice(2);
const option = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] ?? '') : undefined;
};
const flag = (name: string) => argv.includes(`--${name}`);
const only = (option('only')?.split(',').filter(Boolean) ?? ALL_IDS) as AnyGame[];
const maps = option('maps')?.split(',').filter(Boolean) ?? DEFAULT_MAPS;
const browserPreference = option('browser');
const headless = !flag('headful');
const verbose = flag('verbose');

function fail(message: string): never {
  console.error(`\n[screenshots] ${message}`);
  shutdown();
  process.exit(1);
}
const log = (message: string) => console.log(`[screenshots] ${message}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

for (const g of only) if (!ALL_IDS.includes(g)) fail(`Unknown game "${g}". Games: ${ALL_IDS.join(', ')}.`);
for (const m of maps) if (!MAP_LIST.some((x) => x.id === m)) fail(`Unknown map "${m}". Maps: ${MAP_LIST.map((x) => x.id).join(', ')}.`);
if (!existsSync(tsxCli) || !existsSync(viteCli)) fail('Dependencies are missing. Run `npm run install:all` in play/ first.');

// ---- servers -----------------------------------------------------------------------------------------------------

const children: ChildProcess[] = [];
let shuttingDown = false;

function start(name: string, args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  child.stdout?.on('data', (chunk: Buffer) => verbose && process.stdout.write(`[${name}] ${chunk}`));
  child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(`[${name}] ${chunk}`));
  child.on('exit', (code) => {
    if (!shuttingDown && code) fail(`${name} exited with code ${code}.`);
  });
  return child;
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

async function waitFor(url: string, what: string, timeoutMs = 90_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not listening yet */
    }
    await sleep(300);
  }
  fail(`${what} did not answer at ${url} within ${timeoutMs / 1000}s.`);
}

const api = `http://127.0.0.1:${BACKEND_PORT}`;
const site = `http://127.0.0.1:${FRONTEND_PORT}`;

async function createRoom(game: GameId, map?: string): Promise<string> {
  const res = await fetch(`${api}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `${GAMES[game].name} screenshots`, game, maxPlayers: GAMES[game].maxPlayers, bots: game === 'zombies' ? 3 : BOTS, botDifficulty: 'normal', map }),
  });
  if (!res.ok) fail(`Creating a ${game} room failed: HTTP ${res.status} ${await res.text()}`);
  const { room } = (await res.json()) as { room: { code: string } };
  return room.code;
}

// ---- browser -----------------------------------------------------------------------------------------------------

async function launch(): Promise<Browser> {
  const order = browserPreference ? [browserPreference] : ['chrome', 'msedge', 'chromium'];
  const errors: string[] = [];
  for (const channel of order) {
    try {
      const browser = await chromium.launch({
        channel: channel === 'chromium' ? undefined : channel,
        headless,
        args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
      });
      log(`browser: ${channel}${headless ? ' (headless)' : ''}`);
      return browser;
    } catch (e) {
      errors.push(`  ${channel}: ${(e as Error).message.split('\n')[0]}`);
    }
  }
  return fail(`No browser could be started:\n${errors.join('\n')}\nInstall Chrome or Edge, or run \`npx playwright install chromium\` in play/.`);
}

/** Opens the waiting room as the host (name already saved), starts the match and waits for the game to render. */
async function startMatch(context: BrowserContext, code: string): Promise<Page> {
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error(`[page] ${e.message}`));
  await page.goto(`${site}/room/${code}`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('start').click({ timeout: 60_000 });
  await page.waitForFunction(() => (window as unknown as { __playClient?: { hud: { get(): { ready: boolean } } } }).__playClient?.hud.get().ready === true, null, {
    timeout: 90_000,
  });
  // Dev-only hints have no place in a screenshot.
  await page.addStyleTag({ content: '.hint-bar, .menu-hint, .hud .out { display: none !important; }' });
  return page;
}

async function screenshot(page: Page, file: string) {
  await page.screenshot({ path: path.join(outDir, file), type: 'jpeg', quality: JPEG_QUALITY });
}

// ---- games -------------------------------------------------------------------------------------------------------

async function shootRockets(context: BrowserContext): Promise<Shot[]> {
  const shots: Shot[] = [];
  for (const map of maps) {
    const name = MAP_LIST.find((m) => m.id === map)!.name;
    log(`Rockets · ${name}`);
    const page = await startMatch(context, await createRoom('rockets', map));
    await page.waitForFunction(() => !!(window as unknown as { __rockets?: { hud: { get(): { mapName: string } } } }).__rockets?.hud.get().mapName);
    // Give the bots a few seconds to spread out and start firing.
    await sleep(3500);
    // Camera: a little above the highest spawn point, facing the centre of the map. Uses the client's debug camera
    // when it has one, else turns the player's own head.
    await page.evaluate(() => {
      interface Dev {
        map: { spawns: { pos: { x: number; y: number; z: number } }[] };
        me: { yaw: number; pitch: number };
        debugCam?: { x: number; y: number; z: number; yaw: number; pitch: number } | null;
      }
      const c = (window as unknown as { __rockets: Dev }).__rockets;
      const spawn = [...c.map.spawns].sort((a, b) => b.pos.y - a.pos.y)[0];
      const { x, z } = spawn.pos;
      const y = spawn.pos.y + 2.6;
      const distance = Math.hypot(x, z) || 1;
      const cam = { x, y, z, yaw: Math.atan2(x, z), pitch: -Math.atan2(y - 2, distance) * 0.6 };
      if ('debugCam' in c) c.debugCam = cam;
      else {
        c.me.yaw = cam.yaw;
        c.me.pitch = cam.pitch;
      }
    });
    // If a bot just rocketed us, wait for the respawn so the HUD is not the death screen.
    await page
      .waitForFunction(() => !(window as unknown as { __rockets: { hud: { get(): { dead: boolean } } } }).__rockets.hud.get().dead, null, { timeout: 15_000 })
      .catch(() => undefined);
    await sleep(700);
    const file = `rockets-${map}.jpg`;
    await screenshot(page, file);
    shots.push({ file, caption: name });
    await page.close();
  }
  return shots;
}

async function shootRuckus(context: BrowserContext): Promise<Shot[]> {
  log('Ruckus · one match, a shot of every minigame (takes a few minutes)');
  const page = await startMatch(context, await createRoom('ruckus'));
  const got = new Map<MinigameId, Shot>();
  const deadline = Date.now() + 12 * 60_000;
  while (Date.now() < deadline && got.size < MINIGAME_IDS.length) {
    const hud = await page.evaluate(() => {
      const s = (window as unknown as { __playClient: { hud: { get(): { phase: string; mg: string | null; left: number; ended: unknown } } } }).__playClient.hud.get();
      return { phase: s.phase, mg: s.mg as MinigameId | null, left: s.left, ended: !!s.ended };
    });
    if (hud.ended) break;
    // A few seconds into the play phase the pawns have spread out and the arena shows what the minigame is about.
    if (hud.phase === 'play' && hud.mg && !got.has(hud.mg) && MINIGAMES[hud.mg].seconds - hud.left >= 4) {
      // The chase camera follows our pawn; a spectator's view of the whole arena makes the better picture.
      await page.evaluate(() => {
        const c = (window as unknown as { __playClient: { me?: { participating: boolean } } }).__playClient;
        if (c.me) c.me.participating = false;
      });
      await sleep(1300);
      const file = `ruckus-${hud.mg}.jpg`;
      await screenshot(page, file);
      got.set(hud.mg, { file, caption: MINIGAMES[hud.mg].name });
      log(`  ${MINIGAMES[hud.mg].name}`);
    }
    await sleep(400);
  }
  await page.close();
  if (!got.size) fail('No Ruckus round reached the play phase.');
  const missing = MINIGAME_IDS.filter((id) => !got.has(id));
  if (missing.length) log(`  missing (round ended too fast): ${missing.join(', ')}; run again for those`);
  return MINIGAME_IDS.filter((id) => got.has(id)).map((id) => got.get(id)!);
}

/** Dustrunners tracks shown, each a little way into the run so the scenery and the pack are in view. */
const RACER_SHOTS = [
  { track: 'falls', at: 0.3, caption: 'Thunder Falls' },
  { track: 'redrock', at: 0.12, caption: 'Redrock Run' },
  { track: 'mesa', at: 0.2, caption: 'Mesa Run' },
  { track: 'spires', at: 0.2, caption: 'Needle Spires' },
];

async function shootDustrunners(context: BrowserContext): Promise<Shot[]> {
  const shots: Shot[] = [];
  for (const { track, at, caption } of RACER_SHOTS) {
    log(`Dustrunners · ${caption}`);
    const page = await context.newPage();
    page.on('pageerror', (e) => console.error(`[page] ${e.message}`));
    await page.goto(`${site}/race?go=${track}&autopilot&at=${at}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as unknown as { __racer?: unknown }).__racer, null, { timeout: 90_000 });
    // A few seconds at speed: dust, trails and motion blur build up.
    await sleep(6000);
    await page.addStyleTag({ content: '.hud-pause-btn { display: none !important; }' });
    const file = `dustrunners-${track}.jpg`;
    await screenshot(page, file);
    shots.push({ file, caption });
    await page.close();
  }
  return shots;
}

/** Last Light: every map once the first wave is in, looking at the nearest window from the middle of the room. */
async function shootZombies(context: BrowserContext): Promise<Shot[]> {
  const shots: Shot[] = [];
  for (const m of ZMAP_LIST) {
    log(`Last Light · ${m.name}`);
    const page = await startMatch(context, await createRoom('zombies', m.id));
    // First wave after 6 s; give it time to rise and reach the boards.
    await sleep(17_000);
    await page.evaluate(() => {
      interface Dev {
        world: { windows: { inside: { x: number; z: number } }[] };
        me: { yaw: number; pitch: number; body: { pos: { x: number; z: number } } };
      }
      const c = (window as unknown as { __zombies: Dev }).__zombies;
      const p = c.me.body.pos;
      const w = [...c.world.windows].sort((a, b) => Math.hypot(a.inside.x - p.x, a.inside.z - p.z) - Math.hypot(b.inside.x - p.x, b.inside.z - p.z))[0];
      c.me.yaw = Math.atan2(-(w.inside.x - p.x), -(w.inside.z - p.z));
      c.me.pitch = 0.02;
    });
    await sleep(900);
    const file = `zombies-${m.id}.jpg`;
    await screenshot(page, file);
    shots.push({ file, caption: m.name });
    await page.close();
  }
  return shots;
}

const shooters: Record<AnyGame, (context: BrowserContext) => Promise<Shot[]>> = {
  rockets: shootRockets,
  ruckus: shootRuckus,
  zombies: shootZombies,
  dustrunners: shootDustrunners,
};

// ---- output ------------------------------------------------------------------------------------------------------

function readManifest(): Manifest {
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
  } catch {
    return {};
  }
}

function writeManifest(update: Manifest) {
  const previous = readManifest();
  const next: Manifest = {};
  for (const id of ALL_IDS) next[id] = update[id] ?? previous[id] ?? [];
  writeFileSync(manifestPath, `${JSON.stringify(next, null, 2)}\n`);
}

/** Removes a game's old screenshots that this run did not produce. */
function prune(game: AnyGame, keep: Shot[]) {
  for (const f of readdirSync(outDir)) {
    if (f.startsWith(`${game}-`) && !keep.some((s) => s.file === f)) unlinkSync(path.join(outDir, f));
  }
}

// ---- main --------------------------------------------------------------------------------------------------------

mkdirSync(outDir, { recursive: true });
log(`backend on ${api}, dev server on ${site}`);
start('backend', [tsxCli, 'backend/src/index.ts'], { PORT: String(BACKEND_PORT), HOST: '127.0.0.1', CREATE_RATE_LIMIT: '100' });
await waitFor(`${api}/api/health`, 'The backend');
start('vite', [viteCli, 'frontend', '--config', 'frontend/vite.screenshots.config.ts', '--host', '127.0.0.1', '--port', String(FRONTEND_PORT), '--strictPort', '--clearScreen', 'false'], {
  PLAY_BACKEND_PORT: String(BACKEND_PORT),
});
await waitFor(site, 'The dev server');

const browser = await launch();
const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
await context.addInitScript(() => localStorage.setItem('play.name', 'Player'));

const update: Manifest = {};
for (const game of ALL_IDS) {
  if (!only.includes(game)) continue;
  const shoot = shooters[game];
  if (!shoot) {
    log(`${gameName(game)}: no capture routine yet (add one to tools/screenshots/capture.mts)`);
    continue;
  }
  update[game] = await shoot(context);
}
for (const [game, shots] of Object.entries(update) as [AnyGame, Shot[]][]) prune(game, shots);
writeManifest(update);

await browser.close();
shutdown();
const total = Object.values(update).reduce((n, s) => n + s.length, 0);
log(`done: ${total} screenshots in ${path.relative(process.cwd(), outDir)}, manifest ${path.relative(process.cwd(), manifestPath)}`);
process.exit(0);
