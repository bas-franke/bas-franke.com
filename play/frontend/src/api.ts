import { GAMES, type BotDifficulty, type GameId, type RoomSettings, type RoomSummary } from '@shared/protocol';
import { MAP_LIST } from '@shared/rockets/maps';

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body as T;
}

export const listRooms = () => api<{ rooms: RoomSummary[] }>('/api/rooms');
export const getRoom = (code: string) => api<{ room: RoomSummary }>(`/api/rooms/${encodeURIComponent(code)}`);
export const createRoom = (settings: Omit<RoomSettings, 'map'> & { map?: string }) => api<{ room: RoomSummary }>('/api/rooms', { method: 'POST', body: JSON.stringify(settings) });

/** Bot difficulties in picker order, with the one-line promise each makes (see the profiles in bots.ts). */
export const DIFFICULTIES: { id: BotDifficulty; label: string; blurb: string }[] = [
  { id: 'easy', label: 'Easy', blurb: 'Slow aim, stand-and-shoot. Good for learning the ropes.' },
  { id: 'normal', label: 'Normal', blurb: 'A fair fight. They strafe and chase you.' },
  { id: 'hard', label: 'Hard', blurb: 'Sharp aim, fast reactions. Bring your best.' },
];

/** Bots a quick-play match fills in next to you, capped by the game's seats. */
const QUICK_BOTS = 4;
export const quickBots = (game: GameId) => Math.max(GAMES[game].minPlayers - 1, Math.min(QUICK_BOTS, GAMES[game].maxPlayers - 1));

/** Router state that tells the room page to start the match as soon as it has joined. */
export interface QuickStart {
  quickStart: true;
}

/** A map id picked at random, never `avoid` when there is a choice. */
export function randomMapId(avoid?: string) {
  const pool = MAP_LIST.filter((m) => m.id !== avoid);
  return pool[Math.floor(Math.random() * pool.length)].id;
}

/**
 * One-click play for any game: a room with bots and the saved difficulty. No map is sent, so games with maps pick a
 * random one every match. Returns the room code; the room page starts the match when it arrives with QuickStart.
 */
export async function quickPlay(game: GameId) {
  const meta = GAMES[game];
  const { room } = await createRoom({
    name: `Quick ${meta.name.toLowerCase()}`,
    game,
    maxPlayers: meta.maxPlayers,
    bots: quickBots(game),
    botDifficulty: savedDifficulty(),
  });
  return room.code;
}

const NAME_KEY = 'play.name';
const DIFFICULTY_KEY = 'play.difficulty';

// Storage can throw (blocked site data, private windows): these are conveniences, so fall back quietly.
function read(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}

export const savedName = () => read(NAME_KEY) ?? '';
export const saveName = (name: string) => write(NAME_KEY, name);
export const savedDifficulty = (): BotDifficulty => {
  const d = read(DIFFICULTY_KEY);
  return d === 'easy' || d === 'hard' ? d : 'normal';
};
export const saveDifficulty = (d: BotDifficulty) => write(DIFFICULTY_KEY, d);
