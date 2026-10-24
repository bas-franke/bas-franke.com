import { Router } from 'express';
import { aiConfigured } from '../ai.js';
import { login, logout, me, requireAdmin } from '../auth.js';
import { config, estimateCostUsd } from '../config.js';
import { dbReady, one, query } from '../db.js';
import { deleteImages, generate, isGenerating, planRun, radarRun, regenerateImages, type GenerateMode } from '../generator.js';
import { schedulerState } from '../scheduler.js';
import { createTopic, planProgress } from '../topics.js';
import { CATEGORIES, type Settings, type Story, type Topic } from '../types.js';

export const adminRouter = Router();

adminRouter.post('/login', login);
adminRouter.post('/logout', logout);
adminRouter.get('/me', me);
adminRouter.use(requireAdmin);

const RUN_COLUMNS = `r.*, t.name AS topic_name, s.title AS story_title, s.slug AS story_slug`;
const RUN_JOINS = `FROM runs r LEFT JOIN topics t ON t.id = r.topic_id LEFT JOIN stories s ON s.id = r.story_id`;

type UsageSums = { input: string; output: string; images: string; image_tokens: string; searches: string };
const usageOf = (u: UsageSums) => ({
  input_tokens: Number(u.input),
  output_tokens: Number(u.output),
  image_tokens: Number(u.image_tokens),
  searches: Number(u.searches),
});

adminRouter.get('/overview', async (_req, res) => {
  const [state, counts, all, today, runs] = await Promise.all([
    schedulerState(),
    one<{ published: string; hidden: string; views: string; topics: string; failed: string; succeeded: string }>(
      `SELECT (SELECT count(*) FROM stories WHERE status = 'published') AS published,
              (SELECT count(*) FROM stories WHERE status = 'hidden') AS hidden,
              (SELECT coalesce(sum(views), 0) FROM stories) AS views,
              (SELECT count(*) FROM topics WHERE enabled) AS topics,
              (SELECT count(*) FROM runs WHERE status = 'failed') AS failed,
              (SELECT count(*) FROM runs WHERE status = 'succeeded' AND kind <> 'plan') AS succeeded`,
    ),
    one<UsageSums>(
      `SELECT coalesce(sum((usage->>'input_tokens')::bigint), 0) AS input, coalesce(sum((usage->>'output_tokens')::bigint), 0) AS output,
              coalesce(sum((usage->>'images')::int), 0) AS images, coalesce(sum((usage->>'image_tokens')::bigint), 0) AS image_tokens,
              coalesce(sum((usage->>'searches')::int), 0) AS searches FROM runs`,
    ),
    one<UsageSums>(
      `SELECT coalesce(sum((usage->>'input_tokens')::bigint), 0) AS input, coalesce(sum((usage->>'output_tokens')::bigint), 0) AS output,
              coalesce(sum((usage->>'images')::int), 0) AS images, coalesce(sum((usage->>'image_tokens')::bigint), 0) AS image_tokens,
              coalesce(sum((usage->>'searches')::int), 0) AS searches FROM runs WHERE started_at > now() - interval '24 hours'`,
    ),
    query(`SELECT ${RUN_COLUMNS} ${RUN_JOINS} ORDER BY r.started_at DESC LIMIT 12`),
  ]);
  const { rows: trending } = await query(
    `SELECT t.id, t.slug, t.name, t.kind, t.category, t.heat, t.heat_reason, t.heat_at, count(s.id)::int AS stories
     FROM topics t LEFT JOIN stories s ON s.topic_id = t.id WHERE t.heat > 0
     GROUP BY t.id ORDER BY t.heat DESC, t.heat_at DESC LIMIT 12`,
  );
  const succeeded = Number(counts.succeeded);
  const totalUsd = estimateCostUsd(usageOf(all));
  res.json({
    ...state,
    trending,
    env: { database: await dbReady(), openai: aiConfigured(), admin_password: Boolean(config.adminPassword), data_dir: config.dataDir },
    counts: { published: Number(counts.published), hidden: Number(counts.hidden), views: Number(counts.views), topics: Number(counts.topics) },
    tokens: { input: Number(all.input), output: Number(all.output), images: Number(all.images), searches: Number(all.searches), failed_runs: Number(counts.failed) },
    cost: { total_usd: totalUsd, last_24h_usd: estimateCostUsd(usageOf(today)), per_story_usd: succeeded ? totalUsd / succeeded : 0 },
    recent_runs: runs.rows,
  });
});

/* Settings */
const SETTINGS_FIELDS: (keyof Settings)[] = [
  'enabled', 'interval_minutes', 'max_per_day', 'active_hours_start', 'active_hours_end', 'timezone',
  'text_model', 'image_model', 'image_quality', 'images_enabled', 'images_max', 'web_search_enabled',
  'language', 'tone', 'audience', 'target_words', 'extra_instructions', 'trending_share', 'trending_guidance', 'radar_hours', 'site_name', 'tagline',
];

adminRouter.get('/settings', async (_req, res) => {
  res.json(await one<Settings>('SELECT * FROM settings WHERE id = 1'));
});

adminRouter.put('/settings', async (req, res) => {
  const body = (req.body ?? {}) as Partial<Settings>;
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const field of SETTINGS_FIELDS) {
    if (!(field in body)) continue;
    let value: unknown = body[field];
    if (field === 'active_hours_start' || field === 'active_hours_end') value = value === '' || value === null ? null : Number(value);
    params.push(value);
    sets.push(`${field} = $${params.length}`);
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update.' });
  try {
    const timezone = body.timezone;
    if (timezone) new Intl.DateTimeFormat('en', { timeZone: timezone });
    const row = await one<Settings>(`UPDATE settings SET ${sets.join(', ')}, updated_at = now() WHERE id = 1 RETURNING *`, params);
    res.json(row);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/* Topics */
adminRouter.get('/topics', async (_req, res) => {
  const { rows } = await query<Topic & { stories: number }>(
    `SELECT t.*, count(s.id)::int AS stories FROM topics t LEFT JOIN stories s ON s.topic_id = t.id
     GROUP BY t.id ORDER BY t.enabled DESC, t.name`,
  );
  res.json(await Promise.all(rows.map(async (t) => ({ ...t, plan: undefined, sections: t.plan?.sections.length ?? 0, ...(await planProgress(t)) }))));
});

adminRouter.get('/topics/:id', async (req, res) => {
  const topic = await one<Topic>('SELECT * FROM topics WHERE id = $1', [Number(req.params.id)]);
  topic ? res.json(topic) : res.status(404).json({ error: 'Not found' });
});

adminRouter.post('/topics', async (req, res) => {
  const { name, description, category, kind, weight } = (req.body ?? {}) as Partial<Topic>;
  try {
    if (category && !CATEGORIES.includes(category)) throw new Error('Unknown category.');
    if (kind && !['field', 'event'].includes(kind)) throw new Error('Kind must be field or event.');
    res.status(201).json(await createTopic({ name: name ?? '', description, category, kind, weight }));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

adminRouter.patch('/topics/:id', async (req, res) => {
  const body = (req.body ?? {}) as Partial<Topic>;
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const field of ['name', 'description', 'category', 'kind', 'weight', 'enabled', 'heat', 'heat_reason'] as const) {
    if (field in body) params.push(body[field]), sets.push(`${field} = $${params.length}`);
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update.' });
  params.push(Number(req.params.id));
  try {
    const row = await one<Topic>(`UPDATE topics SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length} RETURNING *`, params);
    row ? res.json(row) : res.status(404).json({ error: 'Not found' });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

adminRouter.delete('/topics/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await query<{ images: Story['images'] }>('SELECT images FROM stories WHERE topic_id = $1', [id]);
  await query('DELETE FROM topics WHERE id = $1', [id]);
  await Promise.all(rows.map((r) => deleteImages(r.images)));
  res.json({ ok: true });
});

/** Generates the curriculum of a topic, or extends it when it already has one. */
adminRouter.post('/topics/:id/plan', async (req, res) => {
  if (!aiConfigured()) return res.status(503).json({ error: 'OPENAI_API_KEY is not set on the server.' });
  const run = await planRun(Number(req.params.id), Boolean(req.body?.extend));
  run.status === 'succeeded' ? res.json(run) : res.status(500).json({ error: run.error ?? 'Planning failed.' });
});

/** Rescans what is trending now (the scheduler does this by itself every radar_hours before a "right now" story). */
adminRouter.post('/radar', async (_req, res) => {
  if (!aiConfigured()) return res.status(503).json({ error: 'OPENAI_API_KEY is not set on the server.' });
  const run = await radarRun();
  run.status === 'succeeded' ? res.json(run) : res.status(500).json({ error: run.error ?? 'The scan failed.' });
});

/* Generation */
adminRouter.post('/generate', async (req, res) => {
  if (isGenerating()) return res.status(409).json({ error: 'A generation is already running.' });
  if (!aiConfigured()) return res.status(503).json({ error: 'OPENAI_API_KEY is not set on the server.' });
  const topicId = req.body?.topic_id ? Number(req.body.topic_id) : undefined;
  const mode: GenerateMode = ['trending', 'planned'].includes(req.body?.mode) ? req.body.mode : 'auto';
  // Respond right away; the dashboard polls the run list for progress.
  generate('manual', { topicId, mode }).catch((err) => console.error('manual generation failed', err));
  res.status(202).json({ started: true });
});

adminRouter.get('/runs', async (req, res) => {
  const limit = Math.min(100, Number(req.query.limit ?? 30));
  const { rows } = await query(`SELECT ${RUN_COLUMNS} ${RUN_JOINS} ORDER BY r.started_at DESC LIMIT $1`, [limit]);
  res.json(rows);
});

/* Stories */
adminRouter.get('/stories', async (req, res) => {
  const limit = Math.min(100, Number(req.query.limit ?? 50));
  const page = Math.max(1, Number(req.query.page ?? 1));
  const [{ rows }, total] = await Promise.all([
    query(
      `SELECT s.id, s.slug, s.title, s.hook, s.status, s.views, s.read_seconds, s.kind, s.why_now, s.section_name, s.published_at, s.model, s.usage,
              jsonb_array_length(s.images) AS images, (SELECT i->>'file' FROM jsonb_array_elements(s.images) i LIMIT 1) AS image,
              t.name AS topic_name, t.slug AS topic_slug
       FROM stories s JOIN topics t ON t.id = s.topic_id ORDER BY s.published_at DESC LIMIT $1 OFFSET $2`,
      [limit, (page - 1) * limit],
    ),
    one<{ n: string }>('SELECT count(*) AS n FROM stories'),
  ]);
  res.json({ stories: rows, page, limit, total: Number(total.n) });
});

adminRouter.patch('/stories/:id', async (req, res) => {
  const body = (req.body ?? {}) as Partial<Story>;
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const field of ['title', 'hook', 'takeaway', 'status', 'body_md'] as const) {
    if (field in body) params.push(body[field]), sets.push(`${field} = $${params.length}`);
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update.' });
  params.push(Number(req.params.id));
  try {
    const row = await one<Story>(`UPDATE stories SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
    row ? res.json(row) : res.status(404).json({ error: 'Not found' });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

adminRouter.post('/stories/:id/regenerate-images', async (req, res) => {
  try {
    res.json(await regenerateImages(Number(req.params.id)));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

adminRouter.delete('/stories/:id', async (req, res) => {
  const row = await one<Story>('DELETE FROM stories WHERE id = $1 RETURNING images', [Number(req.params.id)]);
  if (row) await deleteImages(row.images);
  res.json({ ok: true });
});
