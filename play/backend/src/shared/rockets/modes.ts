// Rockets game modes and teams: the rules every part of the game agrees on (server, bots, client, room page).
// A match always has a goal and a clock, so it ends in about seven minutes whatever happens. Goals are set so a
// full 8-player room usually reaches them near the end of the clock (bot matches measured 2-3.5 min at half these).

import type { GameMode, Team } from '../protocol.js';
import type { Vec3 } from '../math.js';
import type { MapData } from './map.js';

export interface ModeRules {
  id: GameMode;
  name: string;
  /** One line for the room page. */
  blurb: string;
  teams: boolean;
  /** What wins: frags (ffa: per player, tdm: per team), captures (ctf) or rounds (elim). */
  goal: 'frags' | 'captures' | 'rounds';
  /** First to this many wins outright. */
  limit: number;
  /** Match clock in seconds. When it runs out the leader wins; a tie goes to sudden death. */
  seconds: number;
  /** Longest sudden death before a still-level match is a draw. */
  overtime: number;
}

export const MODES: Record<GameMode, ModeRules> = {
  ffa: { id: 'ffa', name: 'Free for all', blurb: 'Everyone for themselves. First to 40 frags.', teams: false, goal: 'frags', limit: 40, seconds: 420, overtime: 60 },
  tdm: { id: 'tdm', name: 'Team deathmatch', blurb: 'Red against Blue. First team to 110 frags.', teams: true, goal: 'frags', limit: 110, seconds: 420, overtime: 60 },
  ctf: { id: 'ctf', name: 'Capture the flag', blurb: "Grab the enemy flag and bring it home while yours is safe. First to 5 captures.", teams: true, goal: 'captures', limit: 5, seconds: 420, overtime: 60 },
  elim: { id: 'elim', name: 'Elimination', blurb: 'Rounds with no respawns: last team standing takes the round. First to 7 rounds.', teams: true, goal: 'rounds', limit: 7, seconds: 480, overtime: 60 },
};

export const MODE_IDS = Object.keys(MODES) as GameMode[];

/** Elimination round rules. */
export const ELIM = {
  /** A round that is still undecided after this many seconds goes to the team with more total health left. */
  roundSeconds: 75,
  /** Pause between rounds (scores shown, everyone respawns at the end). */
  intermission: 4,
  /** Everyone starts each round with this much health and armor; there are no pickups. */
  health: 150,
  armor: 100,
} as const;

/** Capture-the-flag rules. */
export const CTF = {
  /** A dropped flag goes home by itself after this long. */
  returnSeconds: 20,
  /** Touch distance for taking, returning and capturing. */
  touchRadius: 1.4,
} as const;

export const TEAMS: Record<Team, { name: string; color: number; css: string }> = {
  0: { name: 'Red', color: 0xff4b3a, css: '#ff4b3a' },
  1: { name: 'Blue', color: 0x3d7bff, css: '#3d7bff' },
};

/**
 * Where each team's base (and flag) is: the spawn point farthest from the centre and its mirror image. Every map is
 * built with rotational symmetry, so the mirror of a spawn is (almost) always a spawn too.
 */
export function teamBases(map: MapData): [Vec3, Vec3] {
  const known = basesCache.get(map);
  if (known) return known;
  let best = map.spawns[0].pos;
  let bestScore = -Infinity;
  for (const s of map.spawns) {
    const mirror = map.spawns.find((o) => Math.hypot(o.pos.x + s.pos.x, o.pos.z + s.pos.z) < 1 && Math.abs(o.pos.y - s.pos.y) < 0.5);
    if (!mirror) continue;
    // Far from the centre and low (a flag on a tower top is no fun to defend or run).
    const score = Math.hypot(s.pos.x, s.pos.z) - s.pos.y * 2;
    if (score > bestScore) {
      bestScore = score;
      best = s.pos;
    }
  }
  const bases: [Vec3, Vec3] = [best, { x: -best.x, y: best.y, z: -best.z }];
  basesCache.set(map, bases);
  return bases;
}

const basesCache = new WeakMap<MapData, [Vec3, Vec3]>();

/** Which team's half of the map a point is on (the side of its base). */
export function sideOf(map: MapData, p: Vec3): Team {
  const [a] = teamBases(map);
  return p.x * a.x + p.z * a.z >= 0 ? 0 : 1;
}
