import { Router } from 'express';
import type { ApiDeps } from './deps.js';
import { fail, iso } from './util.js';

/** Personal scratch pad. One string in `settings.notes`, unrelated to trading. */
const KEY = 'notes';
const MAX_CHARS = 50_000;

const readText = (value: unknown): string => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const text = (value as { text?: unknown }).text;
  return typeof text === 'string' ? text : '';
};

export function notesRoutes(deps: ApiDeps) {
  const r = Router();

  r.get('/notes', async (_req, res) => {
    const { rows } = await deps.query('SELECT value, updated_at FROM settings WHERE key = $1', [KEY]);
    if (!rows.length) {
      res.json({ text: '', updatedAt: null });
      return;
    }
    res.json({ text: readText(rows[0].value), updatedAt: iso(rows[0].updated_at) });
  });

  r.put('/notes', async (req, res) => {
    const raw = req.body && typeof req.body === 'object' ? (req.body as { text?: unknown }).text : undefined;
    if (typeof raw !== 'string') fail('Send { text }.');
    const text = raw as string;
    if (text.length > MAX_CHARS) fail(`Notes can be at most ${MAX_CHARS} characters.`);
    await deps.query(
      `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [KEY, JSON.stringify({ text })],
    );
    res.json({ ok: true });
  });

  return r;
}
