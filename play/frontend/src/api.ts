import type { BotDifficulty, RoomSettings, RoomSummary } from '@shared/protocol';
import { MAP_LIST } from '@shared/rockets/maps';

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body as T;
}

export const listRooms = () => api<{ rooms: RoomSummary[] }>('/api/rooms');
export const getRoom = (code: string) => api<{ room: RoomSummary }>(`/api/rooms/${encodeURIComponent(code)}`);
/** `map` is optional: the server falls back to a random map every match. */
export const createRoom = (settings: Omit<RoomSettings, 'map'> & { map?: string }) =>
  api<{ room: RoomSummary }>('/api/rooms', { method: 'POST', body: JSON.stringify(settings) });

/** Bot difficulties in picker order, with the one-line promise each makes. */
export const DIFFICULTIES: { id: BotDifficulty; label: string; blurb: string }[] = [
  { id: 'easy', label: 'Easy', blurb: 'Slow aim, stand-and-shoot. Good for learning rocket jumps.' },
  { id: 'normal', label: 'Normal', blurb: 'A fair fight. They strafe and rocket-jump after you.' },
  { id: 'hard', label: 'Hard', blurb: 'Sharp aim, fast reactions, bunny hops. Bring your best.' },
];

/** Bots a quick-play match fills in next to you. */
export const QUICK_BOTS = 4;

/** Router state that tells the room page to start the match as soon as it has joined. */
export interface QuickStart {
  quickStart: true;
}

/** A map id picked at random, never `avoid` when there is a choice. */
export function randomMapId(avoid?: string) {
  const pool = MAP_LIST.filter((m) => m.id !== avoid);
  return pool[Math.floor(Math.random() * pool.length)].id;
}

/** One-click Rockets: a room with bots on a random map. Returns the room code; the room page starts it. */
export async function quickPlay(difficulty: BotDifficulty = savedDifficulty()) {
  const nick = savedName() || 'Player';
  const { room } = await createRoom({
    name: `${nick}'s quick match`,
    game: 'rockets',
    maxPlayers: 8,
    bots: QUICK_BOTS,
    botDifficulty: difficulty,
    map: randomMapId(),
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
