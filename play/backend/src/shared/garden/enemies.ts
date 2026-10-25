// Garden Sentinels enemies ("cute alien threats"): four kinds plus a boss. Health grows per wave (waveHp); the wave
// list itself is built by waveSpawns, which the server uses and the HUD previews ("next wave: 12 runners").

export type EnemyKind = 'runner' | 'skitter' | 'disruptor' | 'brute' | 'colossus' | 'moth' | 'bloomkin';
export const ENEMY_KINDS: EnemyKind[] = ['runner', 'skitter', 'disruptor', 'brute', 'colossus', 'moth', 'bloomkin'];
export const isEnemyKind = (k: unknown): k is EnemyKind => typeof k === 'string' && (ENEMY_KINDS as string[]).includes(k);

export interface EnemyDef {
  kind: EnemyKind;
  name: string;
  /** Badge on the roster card: Fast, Swarm, Support, Armored, Boss. */
  tag: string;
  blurb: string;
  hp: number;
  /** Metres per second along the path. */
  speed: number;
  /** Damage reduction 0..1 (towers with `pierce` ignore part of it). */
  armor: number;
  /** Gold for the kill. */
  bounty: number;
  /** Lives lost when it reaches the greenhouse. */
  lives: number;
  /** Body radius (m), for splash and spacing. Model height is roughly radius * 2. */
  radius: number;
  /** Disruptor: range, seconds between bolts and how long a hit tower stays disabled. */
  disrupt?: { range: number; every: number; dur: number };
  /** Colossus: spawns this many skitters each time it loses a quarter of its health. */
  shed?: number;
  /**
   * Glow Moth: flies. It takes its route's air route (board.ts airRoute: straight from the portal mouth to the
   * greenhouse, at FLY_HEIGHT), ignores slow fields and sprinkler soak, and only towers with `air` can hit it.
   */
  fly?: boolean;
  /** Bloomkin: every `every` s heals enemies within `range` m (itself included) by `pct` of their max health. */
  heal?: { range: number; pct: number; every: number };
}

/** Height (m) flying enemies cruise at, for targeting ranges (3D distance) and rendering. */
export const FLY_HEIGHT = 2.4;

export const ENEMIES: Record<EnemyKind, EnemyDef> = {
  runner: { kind: 'runner', name: 'Runner', tag: 'Fast', blurb: 'Agile ground unit that follows the path.', hp: 60, speed: 3.5, armor: 0, bounty: 6, lives: 1, radius: 0.4 },
  skitter: { kind: 'skitter', name: 'Skitter', tag: 'Swarm', blurb: 'Small, quick unit that travels in packs.', hp: 20, speed: 3.1, armor: 0, bounty: 2, lives: 1, radius: 0.3 },
  disruptor: {
    kind: 'disruptor',
    name: 'Disruptor',
    tag: 'Support',
    blurb: 'Ranged unit that interferes with towers.',
    hp: 150,
    speed: 2.2,
    armor: 0.1,
    bounty: 12,
    lives: 2,
    radius: 0.45,
    disrupt: { range: 6, every: 4, dur: 3 },
  },
  brute: { kind: 'brute', name: 'Crystal Brute', tag: 'Armored', blurb: 'High health unit that resists damage.', hp: 620, speed: 1.2, armor: 0.5, bounty: 30, lives: 3, radius: 0.9 },
  colossus: {
    kind: 'colossus',
    name: 'Prism Colossus',
    tag: 'Boss',
    blurb: 'Every tenth wave. Sheds skitters as it cracks.',
    hp: 1600,
    speed: 1.0,
    armor: 0.4,
    bounty: 300,
    lives: 8,
    radius: 1.5,
    shed: 6,
  },
  moth: { kind: 'moth', name: 'Glow Moth', tag: 'Flying', blurb: 'Flies straight over the garden to the greenhouse.', hp: 45, speed: 2.0, armor: 0, bounty: 8, lives: 1, radius: 0.45, fly: true },
  bloomkin: {
    kind: 'bloomkin',
    name: 'Bloomkin',
    tag: 'Healer',
    blurb: 'Heals the enemies walking beside it.',
    hp: 220,
    speed: 1.6,
    armor: 0.1,
    bounty: 16,
    lives: 2,
    radius: 0.5,
    heal: { range: 3, pct: 0.02, every: 3 },
  },
};

/** Bounty multiplier for wave n (1-based): gold keeps pace with health. The server pays round(bounty * waveBounty(n)). */
export const waveBounty = (n: number) => 1 + 0.01 * (Math.max(1, n) - 1);

/** Health multiplier for wave n (1-based). */
export const waveHp = (n: number) => 1 + 0.1 * (n - 1) + 0.04 * (n - 1) * (n - 1);
/** Versus only: extra health ramp on top of waveHp (base waves and sends) so matches end around wave 13-16 (12-15 min). */
export const vsHpRamp = (n: number) => Math.pow(VS_RAMP, Math.max(0, n - VS_RAMP_FROM));
export const VS_RAMP = 1.06;
export const VS_RAMP_FROM = 6;

/** One group in a wave: `count` enemies of `kind` from route `route` (-1 = spread over every route), `gap` seconds apart, starting `at` seconds into the wave. */
export interface SpawnGroup {
  kind: EnemyKind;
  count: number;
  gap: number;
  at: number;
  route: number;
}

/** The base wave list (before co-op scaling). Bosses on every tenth wave. Deterministic. */
export function waveSpawns(n: number, routes: number): SpawnGroup[] {
  const g: SpawnGroup[] = [];
  const all = -1;
  const boss = n % 10 === 0;
  // Glow Moths from wave 8 (flying: they skip the paths) take the place of some runners; Bloomkin healers from wave 11.
  const moths = n >= 8 ? 2 + Math.floor((n - 8) / 3) : 0;
  // Boss waves halve the runners so the boss is the exam, not a 3x spike.
  g.push({ kind: 'runner', count: Math.max(3, Math.ceil((6 + Math.floor(n * 1.2) - moths) * (boss ? 0.5 : 1))), gap: Math.max(0.35, 1.1 - n * 0.02), at: 0, route: all });
  if (n >= 3) g.push({ kind: 'skitter', count: 2 + Math.floor(n / 3), gap: 2.2, at: 3, route: all });
  if (n >= 5) g.push({ kind: 'disruptor', count: 1 + Math.floor((n - 5) / 4), gap: 3, at: 6, route: all });
  // Brutes are slow (1.2 m/s): they lead their wave so one straggler cannot hold the wave open for minutes.
  if (n >= 7) g.push({ kind: 'brute', count: 1 + Math.floor((n - 7) / 3), gap: 2.5, at: 2, route: all });
  if (moths) g.push({ kind: 'moth', count: moths, gap: 1.5, at: 5, route: all });
  if (n >= 11) g.push({ kind: 'bloomkin', count: 1 + Math.floor((n - 11) / 5), gap: 4, at: 4, route: all });
  if (boss) g.push({ kind: 'colossus', count: 1 + Math.floor(n / 30), gap: 8, at: 12, route: n === 10 ? 0 : all });
  // Skitter groups are packs: each "count" is one pack of five.
  void routes;
  return g;
}

/** Skitters come in packs: one spawn of a skitter group puts this many on the path side by side. */
export const SKITTER_PACK = 5;

/**
 * Versus: enemies a player can send at an opponent. Sending costs gold now and raises your income every wave (payback
 * ~6 waves). Rules (server): a skitter send's `count` is packs of SKITTER_PACK; sent units have waveHp(n) health of
 * the wave they enter; they queue into the target's NEXT wave (shown as BoardSnap.inc) and enter from 4 s into it;
 * the defender earns 50% bounty for killing one; at most sendCap(n) sends per player per wave.
 */
export interface SendDef {
  kind: EnemyKind;
  count: number;
  cost: number;
  income: number;
  /**
   * Earliest wave the send can ENTER. A send always enters the target's next wave (server: sendWave() = wave + 1,
   * during the build phase before that wave and during the wave before it), so it can be bought once wave + 1 >= from;
   * from 1 means it can be bought in the very first build phase.
   */
  from: number;
}
export const SENDS: SendDef[] = [
  { kind: 'runner', count: 3, cost: 40, income: 7, from: 1 },
  { kind: 'skitter', count: 1, cost: 55, income: 9, from: 2 },
  { kind: 'disruptor', count: 1, cost: 80, income: 13, from: 4 },
  { kind: 'brute', count: 1, cost: 150, income: 25, from: 5 },
  { kind: 'moth', count: 2, cost: 70, income: 11, from: 6 },
  { kind: 'bloomkin', count: 1, cost: 110, income: 18, from: 9 },
  { kind: 'colossus', count: 1, cost: 900, income: 150, from: 12 },
];
/** Versus: sends one player may make per wave (counted from one wave start to the next). */
export const sendCap = (n: number) => 2 + Math.floor(Math.max(0, n) / 4);
/** Versus: share of the bounty a defender earns for a sent unit. */
export const SENT_BOUNTY = 0.5;
