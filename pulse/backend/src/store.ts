import { query } from './db.js';

export interface Task {
  id: string;
  title: string;
  details: string;
  status: 'todo' | 'doing' | 'done';
  due: string | null; // YYYY-MM-DD
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const validId = (id: unknown): id is string => typeof id === 'string' && UUID.test(id);

const TASK = `id, title, details, status, to_char(due,'YYYY-MM-DD') AS due, position, created_at, updated_at`;
const NOTE = `id, title, body, cover, pinned, created_at, updated_at`;
const taskOut = (r: any): Task => ({
  id: r.id, title: r.title, details: r.details, status: r.status, due: r.due, position: r.position,
  createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
});
const noteOut = (r: any): Note => ({
  id: r.id, title: r.title, body: r.body, cover: r.cover, pinned: r.pinned,
  createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
});

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : undefined);
const STATUSES = ['todo', 'doing', 'done'];

/** Upsert with only the fields given; missing fields keep their value (or the column default on insert). */
export async function saveTask(id: string, body: Record<string, unknown>): Promise<Task> {
  const f: Record<string, unknown> = {};
  const title = str(body.title, 300);
  const details = str(body.details, 20_000);
  if (title !== undefined) f.title = title;
  if (details !== undefined) f.details = details;
  if (typeof body.status === 'string' && STATUSES.includes(body.status)) f.status = body.status;
  if (body.due === null || (typeof body.due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.due))) f.due = body.due;
  if (typeof body.position === 'number' && Number.isFinite(body.position)) f.position = body.position;
  return upsert('tasks', TASK, id, f, taskOut);
}

export async function saveNote(id: string, body: Record<string, unknown>): Promise<Note> {
  const f: Record<string, unknown> = {};
  const title = str(body.title, 300);
  const text = str(body.body, 500_000);
  const cover = str(body.cover, 60);
  if (title !== undefined) f.title = title;
  if (text !== undefined) f.body = text;
  if (cover !== undefined) f.cover = cover;
  if (typeof body.pinned === 'boolean') f.pinned = body.pinned;
  return upsert('notes', NOTE, id, f, noteOut);
}

async function upsert<T>(table: string, cols: string, id: string, f: Record<string, unknown>, out: (r: any) => T): Promise<T> {
  const names = Object.keys(f); // only whitelisted names from the savers above, never user input
  const insertCols = ['id', ...names].join(', ');
  const marks = ['$1', ...names.map((_, i) => `$${i + 2}`)].join(', ');
  const sets = [...names.map((n) => `${n} = EXCLUDED.${n}`), 'updated_at = now()'].join(', ');
  const { rows } = await query(
    `INSERT INTO ${table} (${insertCols}) VALUES (${marks}) ON CONFLICT (id) DO UPDATE SET ${sets} RETURNING ${cols}`,
    [id, ...names.map((n) => f[n])],
  );
  return out(rows[0]);
}

export async function removeTask(id: string) {
  return ((await query('DELETE FROM tasks WHERE id = $1', [id])).rowCount ?? 0) > 0;
}
export async function removeNote(id: string) {
  return ((await query('DELETE FROM notes WHERE id = $1', [id])).rowCount ?? 0) > 0;
}

export async function snapshot() {
  const [t, n] = await Promise.all([
    query(`SELECT ${TASK} FROM tasks ORDER BY status, position, created_at`),
    query(`SELECT ${NOTE} FROM notes ORDER BY updated_at DESC`),
  ]);
  return { tasks: t.rows.map(taskOut), notes: n.rows.map(noteOut) };
}
