// The one client-side store. Tasks and notes live in memory, edits apply at once (optimistic), are sent to the server
// after a short pause per item (debounced, patches merged), and every other open tab gets the result over a WebSocket.
import { useSyncExternalStore } from 'react';
import { api, clientId } from './api';

export type Status = 'todo' | 'doing' | 'done';
export interface Task {
  id: string;
  title: string;
  details: string;
  status: Status;
  due: string | null;
  position: number;
  createdAt: string;
  updatedAt: string;
}
export interface Note {
  id: string;
  title: string;
  body: string;
  cover: string;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}
export type TaskPatch = Partial<Pick<Task, 'title' | 'details' | 'status' | 'due' | 'position'>>;
export type NotePatch = Partial<Pick<Note, 'title' | 'body' | 'cover' | 'pinned'>>;

export interface State {
  ready: boolean;
  /** WebSocket connected. */
  live: boolean;
  /** Unsent or in-flight edits. */
  pending: number;
  /** Time of the last successful save (ms), 0 if none yet. */
  savedAt: number;
  error: string;
  tasks: Task[];
  notes: Note[];
}

let state: State = { ready: false, live: false, pending: 0, savedAt: 0, error: '', tasks: [], notes: [] };
const listeners = new Set<() => void>();
const set = (patch: Partial<State>) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
};

export const getState = () => state;
export const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));
export function useStore<T>(select: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => select(state));
}

const uuid = () => crypto.randomUUID();
const byPos = (a: Task, b: Task) => a.position - b.position || a.createdAt.localeCompare(b.createdAt);
const byUpdated = (a: Note, b: Note) => b.updatedAt.localeCompare(a.updatedAt);

/** Tasks of one column, in board order. */
export const tasksIn = (s: State, status: Status) => s.tasks.filter((t) => t.status === status).sort(byPos);

// ---- saving -------------------------------------------------------------------------------------------------------

type Kind = 'tasks' | 'notes';
interface Pending {
  kind: Kind;
  id: string;
  patch: Record<string, unknown>;
  timer?: ReturnType<typeof setTimeout>;
  inflight: boolean;
}
const queue = new Map<string, Pending>();
const DEBOUNCE = 600;

const refreshPending = () => set({ pending: queue.size });

async function flush(key: string) {
  const p = queue.get(key);
  if (!p || p.inflight) return;
  clearTimeout(p.timer);
  const sent = p.patch;
  p.patch = {};
  p.inflight = true;
  try {
    await api(`/${p.kind}/${p.id}`, { method: 'PUT', body: sent });
    p.inflight = false;
    if (Object.keys(p.patch).length) return void schedule(key, 0); // edited again while saving
    queue.delete(key);
    set({ pending: queue.size, savedAt: Date.now(), error: '' });
  } catch (err) {
    p.inflight = false;
    p.patch = { ...sent, ...p.patch }; // keep the edits, retry shortly
    set({ error: err instanceof Error ? err.message : 'Could not save' });
    p.timer = setTimeout(() => void flush(key), 4000);
  }
}

function schedule(key: string, delay = DEBOUNCE) {
  const p = queue.get(key)!;
  clearTimeout(p.timer);
  p.timer = setTimeout(() => void flush(key), delay);
  refreshPending();
}

function queuePatch(kind: Kind, id: string, patch: Record<string, unknown>, delay?: number) {
  const key = `${kind}/${id}`;
  const p = queue.get(key) ?? { kind, id, patch: {}, inflight: false };
  p.patch = { ...p.patch, ...patch };
  queue.set(key, p);
  schedule(key, delay);
}

/** Saves everything waiting right now (e.g. when the tab is hidden). */
export function flushAll() {
  for (const key of queue.keys()) void flush(key);
}

// ---- local edits (optimistic) --------------------------------------------------------------------------------------

const now = () => new Date().toISOString();

export function createTask(init: TaskPatch = {}): Task {
  const status = init.status ?? 'todo';
  const col = tasksIn(state, status);
  const task: Task = {
    id: uuid(), title: '', details: '', status, due: null,
    position: init.position ?? (col.length ? col[col.length - 1].position + 1 : 1),
    createdAt: now(), updatedAt: now(), ...init,
  };
  set({ tasks: [...state.tasks, task] });
  queuePatch('tasks', task.id, { title: task.title, details: task.details, status: task.status, due: task.due, position: task.position }, 150);
  return task;
}

export function updateTask(id: string, patch: TaskPatch) {
  set({ tasks: state.tasks.map((t) => (t.id === id ? { ...t, ...patch, updatedAt: now() } : t)) });
  queuePatch('tasks', id, patch, 'title' in patch || 'details' in patch ? DEBOUNCE : 150);
}

/** Moves a task to `status`, placed before `beforeId` (or at the end), computing a fractional position. */
export function moveTask(id: string, status: Status, beforeId?: string | null) {
  const col = tasksIn(state, status).filter((t) => t.id !== id);
  const i = beforeId ? col.findIndex((t) => t.id === beforeId) : -1;
  const next = i === -1 ? col[col.length - 1] : col[i];
  const prev = i === -1 ? undefined : col[i - 1];
  const position = i === -1 ? (next ? next.position + 1 : 1) : prev ? (prev.position + next.position) / 2 : next.position - 1;
  updateTask(id, { status, position });
}

export function deleteTask(id: string) {
  set({ tasks: state.tasks.filter((t) => t.id !== id) });
  queue.delete(`tasks/${id}`);
  void api(`/tasks/${id}`, { method: 'DELETE' }).then(() => set({ savedAt: Date.now() })).catch(() => set({ error: 'Could not delete' }));
}

export function createNote(init: NotePatch = {}): Note {
  const note: Note = { id: uuid(), title: '', body: '', cover: '', pinned: false, createdAt: now(), updatedAt: now(), ...init };
  set({ notes: [note, ...state.notes] });
  queuePatch('notes', note.id, { title: note.title, body: note.body, cover: note.cover, pinned: note.pinned }, 150);
  return note;
}

export function updateNote(id: string, patch: NotePatch) {
  set({ notes: state.notes.map((n) => (n.id === id ? { ...n, ...patch, updatedAt: now() } : n)).sort(byUpdated) });
  queuePatch('notes', id, patch, 'title' in patch || 'body' in patch ? DEBOUNCE : 150);
}

export function deleteNote(id: string) {
  set({ notes: state.notes.filter((n) => n.id !== id) });
  queue.delete(`notes/${id}`);
  void api(`/notes/${id}`, { method: 'DELETE' }).then(() => set({ savedAt: Date.now() })).catch(() => set({ error: 'Could not delete' }));
}

// ---- remote changes ------------------------------------------------------------------------------------------------

/** Items with unsent local edits keep their local copy; the server catches up when our save lands. */
const dirty = (kind: Kind, id: string) => queue.has(`${kind}/${id}`);

function applyRemote(ev: Record<string, any>) {
  if (ev.from === clientId) return;
  switch (ev.type) {
    case 'task': {
      const t = ev.task as Task;
      if (dirty('tasks', t.id)) return;
      set({ tasks: state.tasks.some((x) => x.id === t.id) ? state.tasks.map((x) => (x.id === t.id ? t : x)) : [...state.tasks, t] });
      break;
    }
    case 'task-removed':
      set({ tasks: state.tasks.filter((t) => t.id !== ev.id) });
      break;
    case 'note': {
      const n = ev.note as Note;
      if (dirty('notes', n.id)) return;
      set({ notes: (state.notes.some((x) => x.id === n.id) ? state.notes.map((x) => (x.id === n.id ? n : x)) : [...state.notes, n]).sort(byUpdated) });
      break;
    }
    case 'note-removed':
      set({ notes: state.notes.filter((n) => n.id !== ev.id) });
      break;
  }
}

async function load() {
  const data = await api<{ tasks: Task[]; notes: Note[] }>('/state');
  // Keep local copies of anything with unsent edits; take the server's for the rest.
  const keepT = new Map(state.tasks.filter((t) => dirty('tasks', t.id)).map((t) => [t.id, t]));
  const keepN = new Map(state.notes.filter((n) => dirty('notes', n.id)).map((n) => [n.id, n]));
  set({
    ready: true,
    tasks: data.tasks.map((t) => keepT.get(t.id) ?? t),
    notes: data.notes.map((n) => keepN.get(n.id) ?? n).sort(byUpdated),
  });
}

let ws: WebSocket | undefined;
let retry = 0;
let started = false;

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/api/ws`);
  ws.onopen = () => {
    retry = 0;
    set({ live: true });
    void load().catch(() => {}); // catch up on whatever happened while we were away
  };
  ws.onmessage = (m) => {
    try {
      applyRemote(JSON.parse(m.data));
    } catch {
      // ignore malformed frames
    }
  };
  ws.onclose = () => {
    set({ live: false });
    setTimeout(connect, Math.min(15_000, 500 * 2 ** retry++));
  };
  ws.onerror = () => ws?.close();
}

/** Call once the user is logged in. */
export function startStore() {
  if (started) return;
  started = true;
  void load().catch((e) => set({ error: String(e.message ?? e) }));
  connect();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushAll();
    else if (!state.live) void load().catch(() => {});
  });
  addEventListener('pagehide', flushAll);
}
