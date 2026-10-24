import type { RoomSettings, RoomSummary } from '@shared/protocol';

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body as T;
}

export const listRooms = () => api<{ rooms: RoomSummary[] }>('/api/rooms');
export const getRoom = (code: string) => api<{ room: RoomSummary }>(`/api/rooms/${encodeURIComponent(code)}`);
export const createRoom = (settings: Omit<RoomSettings, 'map'> & { map?: string }) => api<{ room: RoomSummary }>('/api/rooms', { method: 'POST', body: JSON.stringify(settings) });

const NAME_KEY = 'play.name';
export const savedName = () => localStorage.getItem(NAME_KEY) ?? '';
export const saveName = (name: string) => localStorage.setItem(NAME_KEY, name);
