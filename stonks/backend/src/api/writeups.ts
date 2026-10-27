import { Router } from 'express';
import type { ApiDeps } from './deps.js';
import { fail, iso } from './util.js';

// Long-form write-ups of single strategies (SPEC.md §8b): an ELI5, the exact rules and example scenarios with charts,
// shown from a button on that strategy's research card. Keyed by the spec id; stored as given (only shape-checked).

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const SPEC_ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const MAX_BYTES = 3_000_000;
const SECTION_TYPES = new Set(['text', 'heading', 'candles', 'rules', 'callout', 'example', 'table']);

/** Shape check of a write-up body; throws ValidationError with a readable message. */
export function checkWriteup(body: unknown): { title: string; doc: Json } {
  if (!isObj(body)) fail('Send { title, sections: [...] }.');
  const b = body as Json;
  if (typeof b.title !== 'string' || !b.title.trim() || b.title.length > 200) fail('title must be a short text.');
  if (!Array.isArray(b.sections) || !b.sections.length || b.sections.length > 60) fail('sections must be a list of 1 to 60 sections.');
  (b.sections as unknown[]).forEach((s, i) => {
    if (!isObj(s) || typeof s.type !== 'string' || !SECTION_TYPES.has(s.type)) fail(`sections[${i}].type must be one of ${[...SECTION_TYPES].join(', ')}`);
  });
  if (JSON.stringify(b).length > MAX_BYTES) fail('write-up is too large');
  return { title: (b.title as string).trim(), doc: b };
}

export function writeupRoutes(deps: ApiDeps) {
  const r = Router();

  r.get('/writeups', async (_req, res) => {
    const { rows } = await deps.query('SELECT spec_id, title, updated_at FROM writeups ORDER BY spec_id');
    res.json({ writeups: rows.map((x) => ({ specId: x.spec_id, title: x.title, updatedAt: iso(x.updated_at) })) });
  });

  r.get('/writeups/:specId', async (req, res) => {
    const id = String(req.params.specId);
    if (!SPEC_ID.test(id)) fail('specId is not a strategy id.');
    const { rows } = await deps.query('SELECT spec_id, title, body, updated_at FROM writeups WHERE spec_id = $1', [id]);
    if (!rows.length) {
      res.status(404).json({ error: 'There is no write-up for this strategy.' });
      return;
    }
    res.json({ specId: rows[0].spec_id, title: rows[0].title, updatedAt: iso(rows[0].updated_at), ...(rows[0].body as Json) });
  });

  r.put('/writeups/:specId', async (req, res) => {
    const id = String(req.params.specId);
    if (!SPEC_ID.test(id)) fail('specId is not a strategy id.');
    const { title, doc } = checkWriteup(req.body);
    await deps.query(
      `INSERT INTO writeups (spec_id, title, body, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (spec_id) DO UPDATE SET title = EXCLUDED.title, body = EXCLUDED.body, updated_at = now()`,
      [id, title, JSON.stringify(doc)],
    );
    await deps.log('info', 'writeup_saved', `Write-up for ${id} saved ("${title}")`, { specId: id });
    res.json({ ok: true, specId: id });
  });

  return r;
}
