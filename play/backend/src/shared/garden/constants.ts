// Garden Sentinels: numbers shared by the server simulation and the client. Keep free of Node and DOM APIs.

/** Game modes: everyone defends one garden together, or every player defends their own and sends enemies at the others. */
export type GMode = 'coop' | 'vs';
export const GMODES: Record<GMode, { name: string; blurb: string }> = {
  coop: { name: 'Co-op', blurb: 'Defend one garden together. Shared lives, your own gold.' },
  vs: { name: 'Versus', blurb: 'Everyone defends their own garden and sends enemies at the others. Last garden standing wins.' },
};
export const isGMode = (m: unknown): m is GMode => m === 'coop' || m === 'vs';

export const G = {
  /** Simulation rate (Hz) and how often a snapshot goes out (every Nth tick). */
  tickRate: 20,
  snapEvery: 2,
  /** Size of one grid cell in metres. Towers take one cell. */
  cell: 2,
  /** Gap between boards in versus (metres). */
  boardGap: 14,
  lives: 20,
  /** Seconds before the first wave, between waves, and the gold bonus per second skipped by calling a wave early. */
  firstBuild: 25,
  betweenWaves: 10,
  earlyBonusPerSec: 2,
  /** Versus: the next build phase starts this many seconds after a wave's last spawn even if some board still has
   * enemies on its path (they keep walking), so one board flooded with sends cannot stall everyone. */
  vsOvertime: 12,
  /** Co-op: during a wave, once every human is ready, the spawns are done and at most this many enemies are left, the
   * next wave starts over them (overlapping); every defender gets this wave's clear bonus plus overlapBonus. */
  overlapLeft: 3,
  overlapBonus: 10,
  /** Co-op ends in victory after this wave; versus keeps going until one garden is left. */
  coopWaves: 30,
  /** Gold each player starts with, by mode. */
  startGold: { coop: 260, vs: 350 } as Record<GMode, number>,
  /** Gold every player gets when a wave is cleared: base + per wave. */
  clearBonus: 25,
  clearBonusPerWave: 3,
  /** Versus: income paid to each player at the start of every wave (base; sends raise it). */
  baseIncome: 40,
  /**
   * Sunburst, every player's ability: an aimed strike from the sky on their own board (co-op: the shared board).
   * Damage base + perWave x wave, ignores armour, hits flyers; `start` charges at the start, one more every `every`
   * waves cleared, at most `max` held.
   */
  sun: { radius: 4.5, base: 250, perWave: 40, start: 1, every: 5, max: 2 },
  /** Share of the gold spent on a tower that selling returns. */
  sellRefund: 0.7,
  /** A board is eliminated (versus) or the match is lost (co-op) at 0 lives. */
} as const;

/** Co-op scaling with the number of players (humans + bots) defending: enemy health and count multipliers (the server
 * rounds counts; bosses are not multiplied). Read at each wave start only. */
export const coopHp = (players: number) => 1 + 0.4 * (Math.max(1, players) - 1);
/** Co-op: extra health for small teams (1-2 defenders) in waves 3-8, tapering off over waves 9-11, scaled by how
 * much gold the defenders sit on at the wave start: from nothing at an average of (200 + 25 x wave) unspent gold to
 * the full +35% (solo) / +20% (duo) at twice that. A garden that spends keeps the normal curve; one that hoards five
 * level-1 towers and 600+ gold gets pushed. */
export const coopEarly = (wave: number, players: number, avgGold = 0) => {
  const k = players <= 1 ? 0.35 : players === 2 ? 0.2 : 0;
  const f = wave < 3 ? 0 : wave <= 8 ? 1 : wave <= 11 ? (11 - wave) / 3 : 0;
  const base = 200 + 25 * wave;
  const idle = Math.min(1, Math.max(0, (avgGold - base) / base));
  return 1 + k * f * idle;
};
export const coopCount = (players: number) => 1 + 0.22 * (Math.max(1, players) - 1);
/** Co-op: how much of a kill bounty every defender receives (a kill pays everyone, so nobody steals kills). */
export const coopBountyShare = (players: number) => (1 + 0.25 * (Math.max(1, players) - 1)) / Math.max(1, players);
