// Lobby and room protocol shared by server and client. Game-specific messages live in <game>/protocol.ts and
// travel inside the { t: 'g', m } envelope; the room knows which game is running and routes them.

import type { RocketsClientMsg, RocketsServerMsg } from './rockets/protocol.js';
import type { RuckusClientMsg, RuckusServerMsg } from './ruckus/protocol.js';

export type GameId = 'rockets' | 'ruckus';
export type BotDifficulty = 'easy' | 'normal' | 'hard';
export type RoomState = 'waiting' | 'playing';

export interface GameMeta {
  id: GameId;
  name: string;
  tagline: string;
  description: string;
  /** Humans + bots needed before the host can start. */
  minPlayers: number;
  maxPlayers: number;
  /** Accent colour for the lobby card and HUD. */
  accent: string;
  controls: { keys: string; does: string }[];
}

export const GAMES: Record<GameId, GameMeta> = {
  rockets: {
    id: 'rockets',
    name: 'Rockets',
    tagline: 'Rocket arena. Nothing but rockets.',
    description:
      'A fast first-person arena where everyone carries a rocket launcher with infinite ammo. Splash damage throws ' +
      'players around, so fire at your own feet to rocket-jump onto the high ground. Most frags when the clock runs out wins.',
    minPlayers: 2,
    maxPlayers: 8,
    accent: '#ff7a59',
    controls: [
      { keys: 'W A S D', does: 'Move' },
      { keys: 'Mouse', does: 'Look' },
      { keys: 'Space', does: 'Jump (hold to bunny-hop)' },
      { keys: 'Left click', does: 'Fire rocket' },
      { keys: 'Tab', does: 'Scoreboard' },
    ],
  },
  ruckus: {
    id: 'ruckus',
    name: 'Ruckus',
    tagline: 'Party minigames, one ruckus after another.',
    description:
      'A party game in rounds. Every round is a different minigame: pass the bomb before it blows, survive the crumbling ' +
      'floor, grab the most coins, dodge the sweeper, or shove everyone off the platform. Points for placement each round; ' +
      'the highest total after the last round takes the crown.',
    minPlayers: 2,
    maxPlayers: 8,
    accent: '#7cf4c9',
    controls: [
      { keys: 'W A S D', does: 'Move' },
      { keys: 'Space / Left click', does: 'Dash (shoves nearby players)' },
      { keys: 'Tab', does: 'Scores' },
    ],
  },
};

export const GAME_IDS = Object.keys(GAMES) as GameId[];

export const LIMITS = {
  roomNameMax: 24,
  playerNameMax: 16,
  chatMax: 200,
  minPlayers: 2,
  maxPlayers: 8,
} as const;

export interface RoomSettings {
  name: string;
  game: GameId;
  maxPlayers: number;
  bots: number;
  botDifficulty: BotDifficulty;
  /** Rockets map id, or 'random' for a different one every match. Other games ignore it. */
  map: string;
}

/** What the lobby list shows. */
export interface RoomSummary {
  code: string;
  name: string;
  game: GameId;
  humans: number;
  bots: number;
  maxPlayers: number;
  state: RoomState;
  createdAt: number;
}

export interface PlayerInfo {
  id: string;
  name: string;
  bot: boolean;
  /** 0xRRGGBB */
  color: number;
  connected: boolean;
  ping: number;
}

export interface RoomView {
  code: string;
  name: string;
  game: GameId;
  state: RoomState;
  maxPlayers: number;
  botDifficulty: BotDifficulty;
  map: string;
  hostId: string | null;
  players: PlayerInfo[];
}

export type GameClientMsg = RocketsClientMsg | RuckusClientMsg;
export type GameServerMsg = RocketsServerMsg | RuckusServerMsg;

export type ClientMsg =
  | { t: 'setBots'; count: number; difficulty?: BotDifficulty }
  | { t: 'setMap'; map: string }
  | { t: 'start' }
  | { t: 'stop' }
  | { t: 'chat'; text: string }
  | { t: 'ping'; at: number }
  | { t: 'g'; m: GameClientMsg };

export type ServerMsg =
  | { t: 'welcome'; you: string; room: RoomView; serverTime: number }
  | { t: 'room'; room: RoomView }
  | { t: 'chat'; from: string; text: string; system?: boolean }
  | { t: 'pong'; at: number; serverTime: number }
  | { t: 'error'; message: string }
  | { t: 'closed'; reason: string }
  | { t: 'g'; m: GameServerMsg };

/** Player colours by room slot; also used to tint the 3D models. */
export const PLAYER_COLORS = [0xff7a59, 0x7cf4c9, 0xffd166, 0x6ea8fe, 0xf78cff, 0x9bf06b, 0xff5c8a, 0xc4b5fd];

export const BOT_NAMES = [
  'Botticelli',
  'Sgt. Pepper',
  'Toaster',
  'Marvin',
  'Clanker',
  'Bitsy',
  'Rust Bucket',
  'Gizmo',
  'Sprocket',
  'Beep',
  'Widget',
  'Dynamo',
];

export function sanitizeName(raw: unknown, fallback: string, max: number = LIMITS.playerNameMax): string {
  if (typeof raw !== 'string') return fallback;
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
  return cleaned || fallback;
}

export const colorHex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;
