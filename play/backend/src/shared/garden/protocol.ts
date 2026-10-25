// Garden Sentinels wire protocol. The server simulates at G.tickRate and sends a snapshot every G.snapEvery ticks;
// discrete things (builds, upgrades, missiles, deaths, leaks) go as events. Towers only change through events, so
// snapshots carry just their live state (target, disabled, shielded, buffed).

import type { GMode } from './constants.js';
import type { EnemyKind } from './enemies.js';
import type { Level, TargetMode, TowerKind } from './towers.js';

export type Phase = 'build' | 'wave' | 'over';

/** A tower as placed. `x`/`y` are its cell (col, row) on board `b`. */
export interface TowerInfo {
  id: number;
  k: TowerKind;
  lv: Level;
  b: number;
  x: number;
  y: number;
  /** Player who built it. */
  own: string;
  tm: TargetMode;
  /** Gold spent on it so far (sell value = spent * G.sellRefund). */
  spent: number;
}

export const EFlag = { slowed: 1, zapped: 2, charging: 4, stunned: 8, sent: 16 } as const;
export const TFlag = { disabled: 1, shielded: 2, buffed: 4 } as const;

export interface EnemySnap {
  id: number;
  k: EnemyKind;
  b: number;
  /** Route index on that board's map. */
  r: number;
  /** Metres along the route (2 decimals). */
  d: number;
  /** Lateral offset -1..1 of the path half-width. */
  o: number;
  /** Health 0..1 (2 decimals). */
  hp: number;
  /** EFlag bits. */
  f: number;
}

export interface TowerSnap {
  id: number;
  /** Enemy id it is aiming at / beaming (0 = none). Laser level 3: chain targets in `ch`. */
  tg: number;
  ch?: number[];
  /** TFlag bits. */
  f: number;
}

export interface PlayerSnap {
  id: string;
  gold: number;
  /** Versus: income paid at the start of the next wave. */
  inc: number;
  /** Wants the next wave now. */
  rd: 0 | 1;
  /** Board this player builds on (co-op: 0; -1 = spectator, a versus mid-match joiner). */
  b: number;
}

export interface BoardSnap {
  b: number;
  lives: number;
  /** Versus: eliminated. */
  out?: 1;
  /** [added] Enemies alive or still to spawn on this board in the current wave. */
  rem?: number;
  /** [added] Versus: sends queued at this board for its next wave, as [kind, count] (skitters counted singly). */
  inc?: [EnemyKind, number][];
}

export interface GSnapshot {
  tick: number;
  /** Server time in ms. */
  t: number;
  wave: number;
  ph: Phase;
  /** Build phase: seconds until the wave. Wave phase: enemies still to spawn or alive (across all boards). */
  left: number;
  /** [added] Enemies in the current wave in total (all boards, incl. sends and shed skitters); progress = 1 - left / tot. */
  tot?: number;
  bd: BoardSnap[];
  /**
   * Snapshots are per client: enemies and towers of the client's own board and the board it views (client msg 'view')
   * come every snapshot, other boards only every 4th. `en` / `tw` hold only the boards listed in `eb`
   * [added]; when `eb` is missing every board is included. Keep the last known state of boards not in `eb`.
   * `d` is rounded to 0.1 m, `o` and `hp` to 0.01.
   */
  eb?: number[];
  en: EnemySnap[];
  tw: TowerSnap[];
  pl: PlayerSnap[];
}

export interface GScore {
  id: string;
  kills: number;
  /** Damage dealt (rounded). */
  dmg: number;
  /** Gold spent on towers. */
  built: number;
  /** Versus: gold spent on sends. */
  sent: number;
  /** Shown on the after-match panel (the room page reads `points`). */
  points: number;
  /** Versus: finishing place (1 = winner). */
  place?: number;
}

export interface BoardInfo {
  b: number;
  /** Owner in versus; null in co-op. */
  own: string | null;
}

export type GEvent =
  | { k: 'build'; t: TowerInfo }
  | { k: 'up'; id: number; lv: Level; by: string; spent: number }
  | { k: 'sell'; id: number; by: string; refund: number }
  | { k: 'tm'; id: number; tm: TargetMode }
  /** A missile left tower `tw` for enemy `en`; it lands after `ft` seconds (a 'boom' follows). */
  | { k: 'msl'; tw: number; en: number; mid: number; ft: number }
  /** Splash at a world point on board `b` (radius r). */
  | { k: 'boom'; b: number; x: number; z: number; r: number; mid: number }
  /** A shield pulse zapped enemies (visual pulse on the bubble). */
  | { k: 'zap'; tw: number }
  /**
   * [added] An enemy entered board `b` on route `r` at `d` metres (shed skitters enter mid-route), lateral `o`, with
   * `max` health. `from` = sender id for versus sends. Sent before any other event about that enemy.
   */
  | { k: 'spawn'; en: number; kind: EnemyKind; b: number; r: number; d: number; o: number; max: number; from?: string }
  /**
   * An enemy died at world x/z on board `b` [b/x/z added], killed by tower `by` (0 = none). `gold` = what EACH recipient
   * got: co-op = every defender (`to` omitted); versus = only player `to` [added] (0 gold and no `to` if the board
   * has no owner). The [added] fields are optional in the type only for older fakes; the server always sends b/x/z.
   */
  | { k: 'die'; en: number; kind: EnemyKind; by: number; gold: number; b?: number; x?: number; z?: number; to?: string }
  /** An enemy reached the greenhouse on board `b` at world x/z [added]; `from` = sender id for versus sends [added]. */
  | { k: 'leak'; en: number; b: number; lives: number; x?: number; z?: number; from?: string }
  /** [added] Gold paid to player `id` outside kills: wave clear bonus, versus income, early-call bonus, sell refund. */
  | { k: 'gold'; id: string; n: number; why: 'clear' | 'income' | 'early' | 'refund' }
  /** A disruptor fired at a tower; `blocked` when a shield took it. */
  | { k: 'dis'; en: number; tw: number; blocked: 0 | 1 }
  /** A colossus cracked and shed skitters. */
  | { k: 'shed'; en: number; n: number }
  | { k: 'wave'; n: number; boss: 0 | 1 }
  /** Wave `n` cleared; every defender gets `bonus` (followed by 'gold' events). Versus: per board as it clears (`b` [added]). */
  | { k: 'clear'; n: number; bonus: number; b?: number }
  /** Versus: `from` sent `n` x `kind` at board `to`. */
  | { k: 'send'; from: string; to: number; kind: EnemyKind; n: number }
  /** Versus: board eliminated, finishing in `place`. */
  | { k: 'out'; b: number; place: number }
  | { k: 'ping'; id: string; b: number; x: number; z: number }
  | { k: 'deny'; id: string; why: string };

export type GardenServerMsg =
  | {
      k: 'init';
      /** Shape the room page reads for the after-match panel. */
      map: { id: string; name: string };
      mode: GMode;
      boards: BoardInfo[];
      towers: TowerInfo[];
      wave: number;
      scores: GScore[];
      /** [added] The receiving player's id and board (-1 = spectator), and the current phase. Always sent by the server. */
      you?: string;
      myBoard?: number;
      ph?: Phase;
    }
  | { k: 'snap'; s: GSnapshot }
  | { k: 'ev'; e: GEvent[] }
  | { k: 'score'; scores: GScore[] }
  /** Co-op: `win` = survived every wave. Versus: `winner` = last garden standing. */
  | { k: 'end'; win: boolean; winner: string | null; wave: number; scores: GScore[] };

export type GardenClientMsg =
  /** Build on your board (co-op: the shared board). */
  | { k: 'build'; t: TowerKind; x: number; y: number }
  | { k: 'up'; id: number }
  | { k: 'sell'; id: number }
  | { k: 'tm'; id: number; tm: TargetMode }
  /** Toggle "call the next wave early". The wave starts when every human is ready. */
  | { k: 'ready' }
  /** Versus: send enemies; `to` = target board, omitted = the next living opponent. */
  | { k: 'send'; e: EnemyKind; to?: number }
  /** Map ping everyone sees (world x/z). */
  | { k: 'ping'; x: number; z: number }
  /** [added] The board the camera is on (versus), so its enemies come in every snapshot. */
  | { k: 'view'; b: number }
  /** Asks for a fresh 'init' (a client that mounts mid-match may have been handed an old one by the room page). */
  | { k: 'sync' };
