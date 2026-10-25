// Lobby and room protocol shared by server and client. Game-specific messages live in <game>/protocol.ts and
// travel inside the { t: 'g', m } envelope; the room knows which game is running and routes them.

import type { Look } from './rockets/cosmetics.js';
import type { RocketsClientMsg, RocketsServerMsg } from './rockets/protocol.js';
import type { RuckusClientMsg, RuckusServerMsg } from './ruckus/protocol.js';
import type { ZombiesClientMsg, ZombiesServerMsg } from './zombies/protocol.js';
import type { GardenClientMsg, GardenServerMsg } from './garden/protocol.js';

export type GameId = 'rockets' | 'ruckus' | 'zombies' | 'garden';
export type BotDifficulty = 'easy' | 'normal' | 'hard';
export type RoomState = 'waiting' | 'playing';
/** Game modes: Rockets' (rules in shared/rockets/modes.ts) and Garden Sentinels' co-op / versus. Other games ignore the mode. */
export type RocketsMode = 'ffa' | 'tdm' | 'ctf' | 'elim';
export type GameMode = RocketsMode | 'coop' | 'vs';
/** 0 = Red, 1 = Blue (names and colours in shared/rockets/modes.ts TEAMS). */
export type Team = 0 | 1;

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
  zombies: {
    id: 'zombies',
    name: 'Last Light',
    tagline: 'A SWAT team, a grand hotel lobby, endless dead.',
    description:
      'Co-op zombie survival as a SWAT team holding the lobby of the Grand Meridian Hotel. Endless waves break in, one ' +
      'by one, through the boarded doors and windows. Earn points for every hit to buy guns old and new, ammo, grenades ' +
      'and armor, nail the barricades back up and revive each other. Everything breaks: marble, glass, columns, the ' +
      'reception desk. Bigger squads open the lounge bar and the restaurant.',
    minPlayers: 1,
    maxPlayers: 10,
    accent: '#c8463a',
    controls: [
      { keys: 'W A S D', does: 'Move (Shift: sprint)' },
      { keys: 'Mouse', does: 'Look, left click fires, right click aims' },
      { keys: 'E (hold)', does: 'Rebuild boards, buy, revive' },
      { keys: 'R / 1 2 / wheel', does: 'Reload, switch weapon' },
      { keys: 'G / V', does: 'Throw grenade, knife' },
      { keys: 'F / Tab', does: 'Flashlight, scores' },
    ],
  },
  garden: {
    id: 'garden',
    name: 'Garden Sentinels',
    tagline: 'Cozy sci-fi tower defense. Together or against each other.',
    description:
      'Cute crystal aliens march on your greenhouse. Build laser turrets, bubble shields, slow flowers, missile pods and ' +
      'energy beacons along the garden paths and upgrade them to masterworks. Defend one garden together in co-op, or ' +
      'each defend your own in versus and send enemies at everyone else: the last garden standing wins.',
    minPlayers: 1,
    maxPlayers: 6,
    accent: '#6baf4b',
    controls: [
      { keys: '1 - 5 / click', does: 'Pick a tower, click to build' },
      { keys: 'Click tower', does: 'Select: U upgrade, X sell' },
      { keys: 'R', does: 'Call the next wave early' },
      { keys: 'W A S D / drag', does: 'Pan (wheel zooms)' },
      { keys: 'Alt + click', does: 'Ping the map' },
      { keys: 'Tab', does: 'Scores' },
    ],
  },
};

export const GAME_IDS = Object.keys(GAMES) as GameId[];

/**
 * Single-player games that run entirely in the browser, outside the room system: the lobby lists them next to the
 * room games with a Play button that opens their own page.
 */
export type SoloGameId = 'dustrunners';

export interface SoloGameMeta {
  id: SoloGameId;
  name: string;
  tagline: string;
  description: string;
  /** Page the game lives on. */
  path: string;
  accent: string;
  controls: { keys: string; does: string }[];
}

export const SOLO_GAMES: Record<SoloGameId, SoloGameMeta> = {
  dustrunners: {
    id: 'dustrunners',
    name: 'Dustrunners',
    tagline: 'Podracing through red-rock canyons.',
    description:
      'Fly a twin-turbine pod through sun-baked canyons against seven rival pilots. Win cups in the career to earn ' +
      'credits for new pods and upgrades, or jump into a quick race or a time trial.',
    path: '/race',
    accent: '#ff9a3c',
    controls: [
      { keys: 'W / ↑', does: 'Thrust' },
      { keys: 'S / ↓', does: 'Air brake' },
      { keys: 'A D / ← →', does: 'Steer' },
      { keys: 'Space / Shift', does: 'Boost' },
    ],
  },
};

export const SOLO_GAME_IDS = Object.keys(SOLO_GAMES) as SoloGameId[];

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
  /** Map id of the room's game (Rockets, Last Light, Garden Sentinels), or 'random' for a different one every match. Other games ignore it. */
  map: string;
  /** Rockets game mode, or Garden Sentinels 'coop' / 'vs'. Other games ignore it. */
  mode: GameMode;
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
  /** Set in team modes. */
  team?: Team;
  /** Robot customisation (Rockets). */
  look?: Look;
}

export interface RoomView {
  code: string;
  name: string;
  game: GameId;
  state: RoomState;
  maxPlayers: number;
  botDifficulty: BotDifficulty;
  map: string;
  mode: GameMode;
  hostId: string | null;
  players: PlayerInfo[];
}

export type GameClientMsg = RocketsClientMsg | RuckusClientMsg | ZombiesClientMsg | GardenClientMsg;
export type GameServerMsg = RocketsServerMsg | RuckusServerMsg | ZombiesServerMsg | GardenServerMsg;

export type ClientMsg =
  | { t: 'setBots'; count: number; difficulty?: BotDifficulty }
  | { t: 'setMap'; map: string }
  /** Host only, while waiting. */
  | { t: 'setMode'; mode: GameMode }
  /** Any player, any time (also mid-match); the room keeps bots balanced around humans. */
  | { t: 'setTeam'; team: Team }
  /** The player's robot customisation; sent after joining and whenever it changes. */
  | { t: 'setLook'; look: Look }
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

/**
 * Player colours by room slot; also used to tint the 3D models. Picked so every pair stays apart (CIELAB dE >= 23)
 * for normal, protan and deutan vision: no red/green pairs, and the warm ones are separated by lightness.
 */
export const PLAYER_COLORS = [0xff7a59, 0x7cf4c9, 0xf6ff73, 0x3d7bff, 0xf78cff, 0xff8800, 0xb01e4a, 0xe60099];

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
