// Contract between the Garden Sentinels server (server.ts) and its bots (bots.ts). Every bot is a player with its own
// gold; the server calls think() a few times a second with a read-only view and applies the returned actions through
// the same code paths as human messages (so bots can never cheat).

import type { BotDifficulty } from '../../shared/protocol.js';
import type { GMode } from '../../shared/garden/constants.js';
import type { EnemyKind } from '../../shared/garden/enemies.js';
import type { GMapDef } from '../../shared/garden/maps.js';
import type { RouteGeom } from '../../shared/garden/board.js';
import type { Phase, TowerInfo } from '../../shared/garden/protocol.js';
import type { TargetMode, TowerKind } from '../../shared/garden/towers.js';

export interface BotEnemyView {
  id: number;
  kind: EnemyKind;
  b: number;
  route: number;
  /** Metres along the route. */
  d: number;
  hp: number;
  maxHp: number;
  x: number;
  z: number;
}

export interface BotView {
  mode: GMode;
  def: GMapDef;
  /** The board this bot builds on, and every board's routes (world space). */
  board: number;
  routes: RouteGeom[][];
  /** Cells free to build on for the bot's board right now (no tower, buildable): [col, row]. */
  free: [number, number][];
  /** cellToWorld for this bot's board. */
  toWorld(col: number, row: number): { x: number; z: number };
  wave: number;
  phase: Phase;
  /** Build phase: seconds to the next wave. */
  left: number;
  gold: number;
  income: number;
  lives: number;
  towers: TowerInfo[];
  enemies: BotEnemyView[];
  /** Versus: living opponents' boards with their lives. */
  opponents: { b: number; lives: number; owner: string }[];
  /** Number of defenders (co-op scaling). */
  players: number;
  /** Versus: sends still allowed this wave (sendCap minus sends made); 0 in co-op. */
  sendsLeft?: number;
}

export type BotAction =
  | { k: 'build'; t: TowerKind; x: number; y: number }
  | { k: 'up'; id: number }
  | { k: 'sell'; id: number }
  | { k: 'tm'; id: number; tm: TargetMode }
  | { k: 'ready' }
  | { k: 'send'; e: EnemyKind; to?: number };

export interface GardenBotBrain {
  think(view: BotView, dt: number): BotAction[];
}

export type CreateBot = (id: string, difficulty: BotDifficulty, seed: number) => GardenBotBrain;
