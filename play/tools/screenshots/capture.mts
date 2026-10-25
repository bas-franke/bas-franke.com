// Takes the screenshots the lobby shows for each game: a few Rockets maps, every Ruckus minigame and every Last Light map, captured from
// a real match against bots in a headless browser, and a few Dustrunners tracks mid-race with the AI flying our pod. Garden Sentinels: hard bots build up
// the gardens while we call every wave early. Starts its own backend and dev server on spare ports, so a dev
// server you have open is left alone.
//
//   npm run screenshots                          everything
//   npm run screenshots -- --only rockets        one game (rockets, ruckus, zombies, dustrunners, garden); zombies includes the art
//   npm run screenshots -- --only zombies-art    only Last Light's key art (menu and loading screens)
//   npm run screenshots -- --stale               only the games whose graphics changed since their last capture
//   npm run screenshots -- --maps foundry,orbit  which Rockets maps (default below)
//   npm run screenshots -- --browser msedge      chrome | msedge | chromium (default: first one that starts)
//   npm run screenshots -- --headful --verbose   watch it happen / see server output
//
// Output: frontend/public/screenshots/<game>-<variant>.jpg and frontend/src/games/screenshots.json; Last Light's key art in
// frontend/public/art/lastlight/<id>.jpg and frontend/src/games/zombies/art.json; the fingerprint of every game shot in
// frontend/src/games/screenshots.lock.json (inputs.mjs says which files count; `npm run screenshots:check` compares).
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
import { INPUTS, fingerprint, staleGames, writeLock } from './inputs.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outDir = path.join(root, 'frontend/public/screenshots');
const manifestPath = path.join(root, 'frontend/src/games/screenshots.json');
const artDir = path.join(root, 'frontend/public/art/lastlight');
const artManifestPath = path.join(root, 'frontend/src/games/zombies/art.json');
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
/** `--only zombies-art` (or zombies-art next to other games) shoots Last Light's key art without its lobby shots. */
const ART = 'zombies-art';
const onlyArg = option('only')?.split(',').filter(Boolean);
let only = (onlyArg?.filter((g) => g !== ART) ?? ALL_IDS) as AnyGame[];
let art = !!onlyArg?.includes(ART);
const staleOnly = flag('stale');
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

for (const g of only) if (!ALL_IDS.includes(g)) fail(`Unknown game "${g}". Games: ${ALL_IDS.join(', ')}, ${ART}.`);
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

async function createRoom(game: GameId, map?: string, bots = game === 'zombies' ? 3 : BOTS): Promise<string> {
  const res = await fetch(`${api}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `${GAMES[game].name} screenshots`, game, maxPlayers: GAMES[game].maxPlayers, bots, botDifficulty: 'normal', map }),
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

/** Dustrunners tracks shown: one room race per track, a few seconds after the green light with the pack in view. */
const RACER_SHOTS = [
  { track: 'falls', caption: 'Thunder Falls' },
  { track: 'redrock', caption: 'Redrock Run' },
  { track: 'mesa', caption: 'Mesa Run' },
  { track: 'spires', caption: 'Needle Spires' },
];

async function shootDustrunners(context: BrowserContext): Promise<Shot[]> {
  const shots: Shot[] = [];
  for (const { track, caption } of RACER_SHOTS) {
    log(`Dustrunners · ${caption}`);
    const code = await createRoom('dustrunners', track);
    // ?autopilot lets the racer AI fly our pod too (RaceView debug parameter), so the shot is mid-pack at speed.
    const page = await context.newPage();
    page.on('pageerror', (e) => console.error(`[page] ${e.message}`));
    await page.goto(`${site}/room/${code}?autopilot`, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('start').click({ timeout: 60_000 });
    type Dev = { __playClient?: { hud: { get(): { ready: boolean; phase: string } } } };
    await page.waitForFunction(() => (window as unknown as Dev).__playClient?.hud.get().ready === true, null, { timeout: 90_000 });
    // We are the only human, so the lights go as soon as we are loaded; then the intro fly-over and the countdown.
    await page.waitForFunction(() => (window as unknown as Dev).__playClient?.hud.get().phase === 'racing', null, { timeout: 60_000 });
    // A few seconds at speed: dust, trails and motion blur build up, the pack is still close.
    await sleep(5000);
    await page.addStyleTag({ content: '.menu-hint, .drn-menu-btn { display: none !important; }' });
    const file = `dustrunners-${track}.jpg`;
    await screenshot(page, file);
    shots.push({ file, caption });
    await page.close();
  }
  return shots;
}

/** Last Light: the hotel once the first wave is in, looking at the glass facade from the middle of the lobby. */
async function shootZombies(context: BrowserContext): Promise<Shot[]> {
  const shots: Shot[] = [];
  for (const m of ZMAP_LIST) {
    log(`Last Light · ${m.name}`);
    const page = await startMatch(context, await createRoom('zombies', m.id));
    // First wave after 6 s; give it time to rise and reach the boards.
    await sleep(17_000);
    // Face the sunlit glass facade (north, yaw 0), like the concept art.
    await page.evaluate(() => {
      const c = (window as unknown as { __zombies: { me: { yaw: number; pitch: number } } }).__zombies;
      c.me.yaw = 0;
      c.me.pitch = 0.04;
    });
    await sleep(900);
    const file = `zombies-${m.id}.jpg`;
    await screenshot(page, file);
    shots.push({ file, caption: m.name });
    await page.close();
  }
  return shots;
}

// ---- Last Light key art --------------------------------------------------------------------------------------------

type Vec = { x: number; y: number; z: number };
/**
 * Where an art shot's camera goes. Either a camera position and the point it looks at (`at: 'zombies'` aims at the
 * crowd nearest the facade), or `bot`: a three-quarter close-up of the living SWAT bot nearest the facade, `back`
 * metres in front of it and `side` metres to its right.
 */
type ArtCam = { from: Vec; at: Vec | 'zombies'; fov?: number } | { bot: { back: number; side: number; up: number }; fov?: number };

/**
 * The key art, in the order the menu shows it (the first is the default). Coordinates are the hotel's
 * (backend/src/shared/zombies/maps.ts): atrium x -12..12, z -18..18, 12 m high, glass facade at z = -18 (north,
 * where the zombies come in), lounge bar x 12.5..24.5 and restaurant x -24.5..-12.5 behind passages at z -3..3.
 */
const ART_SHOTS: { id: string; caption: string; cam: ArtCam }[] = [
  { id: 'hotel-facade', caption: 'They come through the glass', cam: { from: { x: 0.8, y: 0.55, z: 11 }, at: { x: 0, y: 2.4, z: -18 }, fov: 62 } },
  { id: 'swat-line', caption: 'Holding the line', cam: { bot: { back: 2.6, side: 1.3, up: 1.45 }, fov: 50 } },
  { id: 'reception', caption: 'The reception desk', cam: { from: { x: -4.2, y: 1.55, z: 5 }, at: { x: -9.6, y: 1.0, z: -6 }, fov: 60 } },
  { id: 'chandeliers', caption: 'Under the chandeliers', cam: { from: { x: 1.5, y: 1.1, z: 15 }, at: { x: 0, y: 8.5, z: -4 }, fov: 70 } },
  { id: 'columns', caption: 'Marble and gunfire', cam: { from: { x: -1.8, y: 1.3, z: -5 }, at: { x: -6, y: 2.2, z: -12.5 }, fov: 58 } },
  { id: 'mezzanine', caption: 'The view from the mezzanine', cam: { from: { x: -10.4, y: 6.4, z: 15.5 }, at: { x: 2, y: 1, z: -10 }, fov: 64 } },
  { id: 'lounge-bar', caption: 'The lounge bar', cam: { from: { x: 13.4, y: 1.6, z: 7.5 }, at: { x: 19.5, y: 1.1, z: -8 }, fov: 64 } },
  { id: 'restaurant', caption: 'The restaurant', cam: { from: { x: -13.4, y: 1.7, z: 8 }, at: { x: -20.5, y: 0.8, z: -4 }, fov: 64 } },
];
const ART_WIDTH = 1920;
const ART_HEIGHT = 1080;
const ART_QUALITY = 86;
/** Players (us + bots) in the art match: 7+ opens the restaurant as well as the lounge (zonesFor in maps.ts). */
const ART_BOTS = 8;

interface ZDev {
  cinematic?: { x: number; y: number; z: number; yaw: number; pitch: number; fov?: number } | null;
  hud: { get(): { ready: boolean; phase: string; hp: number; life: number } };
  zombies: Map<number, { pos: Vec }>;
  remotes: Map<string, { pos: Vec; yaw: number; life: number }>;
}

/** Last Light's key art: HUD-free 1920×1080 frames of one bot match, from the camera positions in ART_SHOTS. */
async function shootZombiesArt(browser: Browser): Promise<Shot[]> {
  log(`Last Light · key art (${ART_SHOTS.length} shots at ${ART_WIDTH}×${ART_HEIGHT})`);
  const context = await browser.newContext({ viewport: { width: ART_WIDTH, height: ART_HEIGHT }, deviceScaleFactor: 1 });
  await context.addInitScript(() => localStorage.setItem('play.name', 'Player'));
  const page = await startMatch(context, await createRoom('zombies', ZMAP_LIST[0].id, ART_BOTS));
  const hasHook = await page.evaluate(() => 'cinematic' in (window as unknown as { __zombies: ZDev }).__zombies);
  if (!hasHook) fail('window.__zombies has no `cinematic` camera (frontend/src/games/zombies/client.ts); the key art needs it.');
  await page.addStyleTag({ content: '.hud, .menu-hint, .hint-bar { display: none !important; }' });
  // Wait for the first wave to rise and reach the boards.
  await page
    .waitForFunction(() => {
      const c = (window as unknown as { __zombies: ZDev }).__zombies;
      return c.hud.get().phase === 'wave' && c.zombies.size >= 6;
    }, null, { timeout: 60_000, polling: 500 })
    .catch(() => log('  the first wave did not show up in a minute; shooting anyway'));
  await sleep(7000);
  mkdirSync(artDir, { recursive: true });
  const shots: Shot[] = [];
  for (const { id, caption, cam } of ART_SHOTS) {
    const placed = await page.evaluate((cam) => {
      const c = (window as unknown as { __zombies: ZDev }).__zombies;
      let from: Vec;
      let at: Vec;
      if ('bot' in cam) {
        const bots = [...c.remotes.values()].filter((r) => r.life === 0).sort((a, b) => a.pos.z - b.pos.z);
        const b = bots[0];
        if (!b) return null;
        // yaw 0 looks down -Z: forward (-sin, -cos), right (cos, -sin).
        const f = { x: -Math.sin(b.yaw), z: -Math.cos(b.yaw) };
        const r = { x: Math.cos(b.yaw), z: -Math.sin(b.yaw) };
        from = { x: b.pos.x + f.x * cam.bot.back + r.x * cam.bot.side, y: b.pos.y + cam.bot.up, z: b.pos.z + f.z * cam.bot.back + r.z * cam.bot.side };
        at = { x: b.pos.x, y: b.pos.y + 1.25, z: b.pos.z };
      } else {
        from = cam.from;
        if (cam.at === 'zombies') {
          const near = [...c.zombies.values()].sort((a, b) => a.pos.z - b.pos.z).slice(0, 6);
          if (!near.length) return null;
          at = { x: near.reduce((s, z) => s + z.pos.x, 0) / near.length, y: 1.2, z: near.reduce((s, z) => s + z.pos.z, 0) / near.length };
        } else at = cam.at;
      }
      const dx = at.x - from.x;
      const dy = at.y - from.y;
      const dz = at.z - from.z;
      c.cinematic = { x: from.x, y: from.y, z: from.z, yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)), fov: cam.fov };
      const s = c.hud.get();
      return { hp: s.hp, life: s.life };
    }, cam);
    if (!placed) {
      log(`  ${id}: nothing to aim at, skipped`);
      continue;
    }
    // Frames for the shadows, the post-processing history and the camera to settle.
    await sleep(1200);
    const file = `${id}.jpg`;
    await page.screenshot({ path: path.join(artDir, file), type: 'jpeg', quality: ART_QUALITY });
    shots.push({ file, caption });
    log(`  ${caption}${placed.life !== 0 || placed.hp < 70 ? ` (we were ${placed.life === 0 ? 'hurt' : 'down'}: check the picture for the red hurt effect)` : ''}`);
  }
  await page.evaluate(() => ((window as unknown as { __zombies: ZDev }).__zombies.cinematic = null));
  await context.close();
  if (!shots.length) fail('No Last Light key art was captured.');
  return shots;
}

/** Writes art.json and removes key art this run did not produce. */
function writeArt(shots: Shot[]) {
  for (const f of readdirSync(artDir)) if (/\.(jpe?g|png|webp)$/.test(f) && !shots.some((s) => s.file === f)) unlinkSync(path.join(artDir, f));
  writeFileSync(artManifestPath, `${JSON.stringify(shots, null, 2)}\n`);
}

// Garden Sentinels: hard bots build the gardens; we call every wave early so the towers pile up fast.
type GardenDev = {
  __garden?: {
    client: { memo: Map<number, { kind: string; x: number; z: number }>; origins: { x: number; z: number }[] };
    store: { get(): { phase: string; wave: number; you: string; players: { id: string; ready: boolean }[] } };
    actions: { ready(): void };
    lookAt(x: number, z: number, dist?: number): void;
    home(): void;
    state(): { towers: { id: number; k: string; lv: number; b: number; x: number; y: number }[]; enemies: number; snapshot: { en: { id: number; k: string }[] } | null };
    cellToWorld(b: number, col: number, row: number): { x: number; z: number } | null;
  };
};
interface GardenStatus {
  phase: string;
  wave: number;
  masterworks: number;
  enemies: number;
  boss: boolean;
}

async function gardenRoom(map: string, mode: 'coop' | 'vs'): Promise<string> {
  const res = await fetch(`${api}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Garden Sentinels screenshots', game: 'garden', maxPlayers: GAMES.garden.maxPlayers, bots: BOTS, botDifficulty: 'hard', mode, map }),
  });
  if (!res.ok) fail(`Creating a garden room failed: HTTP ${res.status} ${await res.text()}`);
  const { room } = (await res.json()) as { room: { code: string } };
  return room.code;
}

/** Calls the next wave as soon as a build phase starts (we are the only human, so the bots follow) and reports progress. */
async function gardenTick(page: Page): Promise<GardenStatus> {
  return page.evaluate(() => {
    const g = (window as unknown as GardenDev).__garden!;
    const s = g.store.get();
    if (s.phase === 'build' && !s.players.find((p) => p.id === s.you)?.ready) g.actions.ready();
    const st = g.state();
    return {
      phase: s.phase,
      wave: s.wave,
      masterworks: st.towers.filter((t) => t.lv === 3).length,
      enemies: st.enemies,
      boss: !!st.snapshot?.en.some((e) => e.k === 'colossus'),
    };
  });
}

async function gardenMatch(context: BrowserContext, map: string, mode: 'coop' | 'vs') {
  const page = await startMatch(context, await gardenRoom(map, mode));
  await page.waitForFunction(() => !!(window as unknown as GardenDev).__garden);
  await page.addStyleTag({ content: '.gs-hint { display: none !important; }' });
  return page;
}

async function shootGarden(context: BrowserContext): Promise<Shot[]> {
  // The first-match coach has no place in a screenshot.
  await context.addInitScript(() => localStorage.setItem('garden.coach.v1', JSON.stringify({ seen: [], kinds: [], off: true })));
  const shots = new Map<string, Shot>();
  const take = async (page: Page, file: string, caption: string) => {
    await sleep(700);
    await screenshot(page, file);
    shots.set(file, { file, caption });
    log(`  ${caption}`);
  };

  // Greenhouse Commons, co-op: the cover mid-wave, a masterwork close-up, and the boss on wave 10.
  log('Garden Sentinels · Greenhouse Commons (plays up to the wave 10 boss, a few minutes)');
  let page = await gardenMatch(context, 'greenhouse-commons', 'coop');
  let deadline = Date.now() + 12 * 60_000;
  while (Date.now() < deadline && shots.size < 3) {
    const s = await gardenTick(page);
    if (s.phase === 'over') break;
    if (!shots.has('garden-greenhouse.jpg') && s.phase === 'wave' && s.wave >= 6 && s.enemies >= 18) {
      await page.evaluate(() => (window as unknown as GardenDev).__garden!.home());
      await take(page, 'garden-greenhouse.jpg', 'Defend the greenhouse together');
    } else if (!shots.has('garden-masterwork.jpg') && s.phase === 'wave' && s.masterworks >= 3 && s.enemies >= 10) {
      // The masterwork with the most upgraded towers around it, from close up.
      await page.evaluate(() => {
        const g = (window as unknown as GardenDev).__garden!;
        const top = g.state().towers.filter((t) => t.lv === 3);
        const near = (a: (typeof top)[0]) => top.filter((t) => Math.hypot(t.x - a.x, t.y - a.y) <= 3).length;
        const best = top.sort((a, b) => near(b) - near(a))[0];
        const p = g.cellToWorld(best.b, best.x, best.y)!;
        g.lookAt(p.x, p.z, 16);
      });
      await take(page, 'garden-masterwork.jpg', 'Upgrade to masterworks');
    } else if (!shots.has('garden-boss.jpg') && s.boss) {
      // Let the boss walk into the tower fire first.
      await sleep(4000);
      const found = await page.evaluate(() => {
        const g = (window as unknown as GardenDev).__garden!;
        const boss = g.state().snapshot?.en.find((e) => e.k === 'colossus');
        const m = boss && g.client.memo.get(boss.id);
        if (!m) return false;
        g.lookAt(m.x, m.z, 24);
        return true;
      });
      if (found) await take(page, 'garden-boss.jpg', 'The Prism Colossus');
    }
    await sleep(400);
  }
  await page.close();

  // Lily Moat, co-op, a few waves in.
  log('Garden Sentinels · Lily Moat');
  page = await gardenMatch(context, 'lily-moat', 'coop');
  deadline = Date.now() + 6 * 60_000;
  while (Date.now() < deadline) {
    const s = await gardenTick(page);
    if (s.phase === 'over') break;
    if (s.phase === 'wave' && s.wave >= 4 && s.enemies >= 14) {
      await page.evaluate(() => (window as unknown as GardenDev).__garden!.home());
      await take(page, 'garden-lily-moat.jpg', 'Lily Moat');
      break;
    }
    await sleep(400);
  }
  await page.close();

  // Versus: six gardens side by side, everyone sending enemies at everyone else.
  log('Garden Sentinels · Versus');
  page = await gardenMatch(context, 'seedling-plot', 'vs');
  deadline = Date.now() + 6 * 60_000;
  while (Date.now() < deadline) {
    const s = await gardenTick(page);
    if (s.phase === 'over') break;
    if (s.phase === 'wave' && s.wave >= 4 && s.enemies >= 20) {
      await page.evaluate(() => {
        const g = (window as unknown as GardenDev).__garden!;
        const xs = g.client.origins.map((p) => p.x);
        const zs = g.client.origins.map((p) => p.z);
        g.lookAt((Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...zs) + Math.max(...zs)) / 2, Math.max(...xs) - Math.min(...xs) + 40);
      });
      await take(page, 'garden-versus.jpg', 'Last garden standing wins');
      break;
    }
    await sleep(400);
  }
  await page.close();

  if (!shots.size) fail('No Garden Sentinels shot was taken.');
  const order = ['garden-greenhouse.jpg', 'garden-boss.jpg', 'garden-lily-moat.jpg', 'garden-versus.jpg', 'garden-masterwork.jpg'];
  const missing = order.filter((f) => !shots.has(f));
  if (missing.length) log(`  missing: ${missing.join(', ')}; run again for those`);
  return order.filter((f) => shots.has(f)).map((f) => shots.get(f)!);
}

const shooters: Record<AnyGame, (context: BrowserContext) => Promise<Shot[]>> = {
  rockets: shootRockets,
  ruckus: shootRuckus,
  zombies: shootZombies,
  dustrunners: shootDustrunners,
  garden: shootGarden,
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

// The art comes with Last Light's screenshots: one fingerprint covers both.
if (only.includes('zombies')) art = true;
if (staleOnly) {
  const stale = staleGames(only) as AnyGame[];
  log(`stale: ${stale.length ? stale.join(', ') : 'none'}`);
  only = stale;
  art = only.includes('zombies') || !!onlyArg?.includes(ART);
  if (!only.length && !art) {
    log('nothing to do: the screenshots of every game match its current graphics');
    process.exit(0);
  }
}
// Fingerprints from before the run, so a file changed meanwhile still shows up as stale afterwards.
const prints = Object.fromEntries(only.filter((g) => g in INPUTS).map((g) => [g, fingerprint(g) as string]));

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
const artShots = art ? await shootZombiesArt(browser) : [];
if (art) writeArt(artShots);

// Record what the pictures were made from. Last Light counts only when its screenshots and its art were both redone.
const done = (Object.keys(update) as AnyGame[]).filter((g) => g in prints && update[g]!.length && (g !== 'zombies' || artShots.length));
if (done.length) writeLock(Object.fromEntries(done.map((g) => [g, { hash: prints[g], at: new Date().toISOString() }])));

await browser.close();
shutdown();
const total = Object.values(update).reduce((n, s) => n + s.length, 0);
log(`done: ${total} screenshots in ${path.relative(process.cwd(), outDir)}, manifest ${path.relative(process.cwd(), manifestPath)}`);
if (art) log(`key art: ${artShots.length} pictures in ${path.relative(process.cwd(), artDir)}, manifest ${path.relative(process.cwd(), artManifestPath)}`);
if (done.length) log(`fingerprints updated for ${done.join(', ')}`);
process.exit(0);
