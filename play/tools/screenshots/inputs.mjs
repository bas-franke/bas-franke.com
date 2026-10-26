// What each game's screenshots (and Last Light's key art) are made from, and a fingerprint over those files. The
// capture script stores the fingerprint of every game it shot in frontend/src/games/screenshots.lock.json; when a
// game's fingerprint no longer matches, its pictures are stale (`npm run screenshots:check`, `--stale`).
//
// Plain JavaScript on purpose: the checker runs with bare `node` in CI, before any dependency is installed.
// See ../../SCREENSHOTS.md.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** play/ */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const LOCK_PATH = path.join(ROOT, 'frontend/src/games/screenshots.lock.json');

/** Shared by the 3D room games: the engine (renderer, lighting, post-processing) and the HUD rules in styles.css. */
const ENGINE = ['frontend/src/engine/**', 'frontend/src/styles.css'];

/**
 * Per game: the files that change what its screenshots look like, as globs relative to play/ (`*` within one path
 * segment, `**` across segments, a leading `!` excludes). `routine: false` marks a game capture.mts cannot shoot yet:
 * the checker lists it but does not fail on it. Lobby-only files do not belong here.
 */
export const INPUTS = {
  rockets: {
    routine: true,
    globs: [...ENGINE, 'frontend/src/games/rockets/**', 'frontend/public/models/*.glb', 'backend/src/shared/rockets/**'],
  },
  zombies: {
    routine: true,
    globs: [
      ...ENGINE,
      'frontend/src/games/zombies/**',
      // The menu shows the art rather than appearing in it; the art manifest and reader are outputs; labs and audio
      // never reach a picture.
      '!frontend/src/games/zombies/menu/**',
      '!frontend/src/games/zombies/art.json',
      '!frontend/src/games/zombies/art.ts',
      '!frontend/src/games/zombies/*lab.ts',
      '!frontend/src/games/zombies/*lab.tsx',
      '!frontend/src/games/zombies/audio.ts',
      'frontend/public/models/zombies/**',
      'backend/src/shared/zombies/**',
    ],
  },
  garden: {
    routine: true,
    globs: [...ENGINE, 'frontend/src/games/garden/**', '!frontend/src/games/garden/lab/**', 'frontend/public/models/garden/**', 'backend/src/shared/garden/**'],
  },
  dustrunners: {
    routine: true,
    globs: ['frontend/src/games/dustrunners/**', 'frontend/src/racer/**', '!frontend/src/racer/audio/**', 'backend/src/shared/dustrunners/**'],
  },
};

/** Never inputs, wherever they turn up: build and editor leftovers that are not in git. */
const JUNK = /(^|\/)(node_modules|__pycache__|\.DS_Store|Thumbs\.db)(\/|$)|\.tsbuildinfo$/;

function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') {
        i++;
        re += '(?:.*/)?';
      } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

function walk(dir, out) {
  const abs = path.join(ROOT, dir);
  if (!existsSync(abs)) return;
  for (const e of readdirSync(abs, { withFileTypes: true })) {
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (JUNK.test(rel)) continue;
    if (e.isDirectory()) walk(rel, out);
    else if (e.isFile()) out.add(rel);
  }
}

/** The files a game's globs match, as sorted paths relative to play/ with forward slashes. */
export function inputFiles(game) {
  const def = INPUTS[game];
  if (!def) return [];
  const include = def.globs.filter((g) => !g.startsWith('!'));
  const exclude = def.globs.filter((g) => g.startsWith('!')).map((g) => globToRegExp(g.slice(1)));
  const candidates = new Set();
  for (const g of include) {
    // Walk only below the part of the glob without wildcards.
    const parts = g.split('/');
    const firstWild = parts.findIndex((p) => /[*?]/.test(p));
    if (firstWild < 0) {
      if (existsSync(path.join(ROOT, g))) candidates.add(g);
      continue;
    }
    walk(parts.slice(0, firstWild).join('/'), candidates);
  }
  const includeRe = include.map(globToRegExp);
  return [...candidates]
    .filter((f) => includeRe.some((r) => r.test(f)) && !exclude.some((r) => r.test(f)))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Text files hash with LF line endings, so a Windows checkout and CI agree; anything with a NUL byte is binary. */
function normalized(buf) {
  if (buf.subarray(0, 8000).includes(0)) return buf;
  return Buffer.from(buf.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
}

/** sha256 over the sorted relative paths and contents of a game's inputs. */
export function fingerprint(game) {
  const hash = createHash('sha256');
  for (const f of inputFiles(game)) {
    hash.update(`${f}\0`);
    hash.update(normalized(readFileSync(path.join(ROOT, f))));
    hash.update('\0');
  }
  return hash.digest('hex');
}

/** @returns {Record<string, { hash: string, at: string }>} */
export function readLock() {
  try {
    return JSON.parse(readFileSync(LOCK_PATH, 'utf8'));
  } catch {
    return {};
  }
}

/** Records the fingerprints of the games just captured; other games keep their entry. */
export function writeLock(update) {
  const lock = { ...readLock(), ...update };
  const ordered = {};
  for (const id of [...Object.keys(INPUTS), ...Object.keys(lock)]) if (lock[id] && !(id in ordered)) ordered[id] = lock[id];
  writeFileSync(LOCK_PATH, `${JSON.stringify(ordered, null, 2)}\n`);
}

/** Games (with a capture routine) whose fingerprint differs from the lock or that have no entry. */
export function staleGames(games = Object.keys(INPUTS)) {
  const lock = readLock();
  return games.filter((g) => INPUTS[g]?.routine && lock[g]?.hash !== fingerprint(g));
}
