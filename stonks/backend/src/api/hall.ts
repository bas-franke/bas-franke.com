import { Router } from 'express';
import type { ApiDeps } from './deps.js';
import { BUCKETS, isBucket, type Bucket } from './research.js';
import { ConflictError, fail, iso, num } from './util.js';

// Hall of fame (SPEC.md §8): research entries the owner keeps forever. Each row is a full copy of the entry (spec,
// metrics, curves, explanation), so new research uploads and the pruning of old snapshots never touch it. Rows only
// go away when the owner removes one.

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** One spec = one hall of fame row, whichever snapshot it came from. */
export const specKey = (spec: unknown) => JSON.stringify(spec);

/** The entry `rank` of `bucket` in a stored research payload (v1 payloads only have `top`, the daily list). */
export function findEntry(payload: unknown, bucket: string, rank: number): Json | undefined {
  if (!isObj(payload)) return undefined;
  const buckets = isObj(payload.buckets) ? payload.buckets : undefined;
  const list = buckets ? (isObj(buckets[bucket]) ? (buckets[bucket] as Json).top : undefined) : bucket === 'daily' ? payload.top : undefined;
  return Array.isArray(list) ? (list.find((e) => isObj(e) && e.rank === rank) as Json | undefined) : undefined;
}

export function hallRoutes(deps: ApiDeps) {
  const r = Router();

  r.get('/hall-of-fame', async (_req, res) => {
    const { rows } = await deps.query('SELECT id, created_at, research_id, bucket, rank, entry FROM hall_of_fame ORDER BY id DESC');
    res.json({
      entries: rows.map((x) => {
        const entry = x.entry as Json;
        const spec = isObj(entry.spec) ? entry.spec : {};
        const botReady = deps.isRunnable ? deps.isRunnable(String(spec.family), spec.familyVersion) : entry.botReady === true;
        return { id: num(x.id), addedAt: iso(x.created_at), researchId: num(x.research_id), bucket: x.bucket, rank: num(x.rank), entry: { ...entry, botReady } };
      }),
    });
  });

  r.post('/hall-of-fame', async (req, res) => {
    const body = req.body;
    if (!isObj(body)) fail('Send { researchId, bucket, rank }.');
    const { researchId, bucket, rank } = body as Json;
    if (typeof researchId !== 'number' || !Number.isInteger(researchId) || researchId < 1) fail('researchId must be a research snapshot id.');
    if (!isBucket(bucket)) fail(`bucket must be one of ${BUCKETS.join(', ')} or sessionN.`);
    if (typeof rank !== 'number' || !Number.isInteger(rank) || rank < 1 || rank > 5) fail('rank must be 1 to 5.');
    const { rows } = await deps.query('SELECT id, payload FROM research_snapshots WHERE id = $1', [researchId]);
    if (!rows.length) fail('That research snapshot is no longer stored. Reload the research and pick the strategy again.');
    const entry = findEntry(rows[0].payload, bucket as Bucket, rank as number);
    if (!entry || !isObj(entry.spec)) fail(`There is no number ${rank} in the ${bucket} list of that research.`);
    const key = specKey(entry!.spec);
    const ins = await deps.query(
      `INSERT INTO hall_of_fame (research_id, bucket, rank, spec_key, entry) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (spec_key) DO NOTHING RETURNING id`,
      [researchId, bucket, rank, key, JSON.stringify(entry)],
    );
    if (!ins.rows.length) throw new ConflictError('This strategy is already in the hall of fame.');
    const id = num(ins.rows[0].id);
    const name = String((entry!.spec as Json).name ?? '');
    await deps.log('info', 'hall_of_fame_added', `Added "${name}" (${bucket} #${rank}, snapshot ${researchId}) to the hall of fame`, { id, researchId, bucket, rank });
    res.json({ ok: true, id });
  });

  r.delete('/hall-of-fame/:id', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) fail('id must be a hall of fame id.');
    const { rows } = await deps.query('DELETE FROM hall_of_fame WHERE id = $1 RETURNING entry', [id]);
    if (!rows.length) {
      res.status(404).json({ error: 'Not in the hall of fame (any more).' });
      return;
    }
    const name = String(((rows[0].entry as Json).spec as Json | undefined)?.name ?? '');
    await deps.log('info', 'hall_of_fame_removed', `Removed "${name}" from the hall of fame`, { id });
    res.json({ ok: true });
  });

  return r;
}
