import { Router } from 'express';
import { aiConfigured } from '../ai.js';
import { login, logout, me, requireAdmin } from '../auth.js';
import { config } from '../config.js';
import { dbReady, one, query } from '../db.js';
import { deleteImage, generate, isGenerating, regenerateImage } from '../generator.js';
import { schedulerState } from '../scheduler.js';
import type { Article, Settings, Topic } from '../types.js';

export const adminRouter = Router();

adminRouter.post('/login', login);
adminRouter.post('/logout', logout);
adminRouter.get('/me', me);
adminRouter.use(requireAdmin);

adminRouter.get('/overview', async (_req, res) => {
  const [state, counts, tokens, runs] = await Promise.all([
    schedulerState(),
    one<{ published: string; hidden: string; views: string }>(
      `SELECT count(*) FILTER (WHERE status = 'published') AS published,
              count(*) FILTER (WHERE status = 'hidden') AS hidden,
              coalesce(sum(views), 0) AS views FROM articles`,
    ),
    one<{ input: string; output: string; images: string; failed: string }>(
      `SELECT coalesce(sum((usage->>'input_tokens')::bigint), 0) AS input,
              coalesce(sum((usage->>'output_tokens')::bigint), 0) AS output,
              coalesce(sum((usage->>'images')::int), 0) AS images,
              count(*) FILTER (WHERE status = 'failed') AS failed
       FROM runs`,
    ),
    query(
      `SELECT r.*, t.name AS topic_name, a.title AS article_title, a.slug AS article_slug
       FROM runs r LEFT JOIN topics t ON t.id = r.topic_id LEFT JOIN articles a ON a.id = r.article_id
       ORDER BY r.started_at DESC LIMIT 10`,
    ),
  ]);
  res.json({
    ...state,
    env: { database: await dbReady(), openai: aiConfigured(), admin_password: Boolean(config.adminPassword), data_dir: config.dataDir },
    counts: { published: Number(counts.published), hidden: Number(counts.hidden), views: Number(counts.views) },
    tokens: { input: Number(tokens.input), output: Number(tokens.output), images: Number(tokens.images), failed_runs: Number(tokens.failed) },
    recent_runs: runs.rows,
  });
});

/* Settings */
const SETTINGS_FIELDS: (keyof Settings)[] = [
  'enabled', 'interval_minutes', 'max_per_day', 'active_hours_start', 'active_hours_end', 'timezone',
  'text_model', 'image_model', 'image_quality', 'images_enabled', 'charts_enabled', 'web_search_enabled',
  'language', 'tone', 'audience', 'target_words', 'extra_instructions', 'site_name', 'tagline',
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
  const { rows } = await query(
    `SELECT t.*, count(a.id)::int AS articles FROM topics t LEFT JOIN articles a ON a.topic_id = t.id
     GROUP BY t.id ORDER BY t.enabled DESC, t.name`,
  );
  res.json(rows);
});

adminRouter.post('/topics', async (req, res) => {
  const { name, description = '', weight = 1 } = (req.body ?? {}) as Partial<Topic>;
  if (!name?.trim()) return res.status(400).json({ error: 'Name is required.' });
  try {
    res.status(201).json(await one<Topic>('INSERT INTO topics (name, description, weight) VALUES ($1, $2, $3) RETURNING *', [name.trim(), description, weight]));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

adminRouter.patch('/topics/:id', async (req, res) => {
  const body = (req.body ?? {}) as Partial<Topic>;
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const field of ['name', 'description', 'weight', 'enabled'] as const) {
    if (field in body) params.push(body[field]), sets.push(`${field} = $${params.length}`);
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update.' });
  params.push(Number(req.params.id));
  try {
    const row = await one<Topic>(`UPDATE topics SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
    row ? res.json(row) : res.status(404).json({ error: 'Not found' });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

adminRouter.delete('/topics/:id', async (req, res) => {
  await query('DELETE FROM topics WHERE id = $1', [Number(req.params.id)]);
  res.json({ ok: true });
});

/* Generation */
adminRouter.post('/generate', async (req, res) => {
  if (isGenerating()) return res.status(409).json({ error: 'A generation is already running.' });
  if (!aiConfigured()) return res.status(503).json({ error: 'OPENAI_API_KEY is not set on the server.' });
  const topicId = req.body?.topic_id ? Number(req.body.topic_id) : undefined;
  // Respond right away; the dashboard polls the run list for progress.
  generate('manual', topicId).catch((err) => console.error('manual generation failed', err));
  res.status(202).json({ started: true });
});

adminRouter.get('/runs', async (req, res) => {
  const limit = Math.min(100, Number(req.query.limit ?? 30));
  const { rows } = await query(
    `SELECT r.*, t.name AS topic_name, a.title AS article_title, a.slug AS article_slug
     FROM runs r LEFT JOIN topics t ON t.id = r.topic_id LEFT JOIN articles a ON a.id = r.article_id
     ORDER BY r.started_at DESC LIMIT $1`,
    [limit],
  );
  res.json(rows);
});

/* Articles */
adminRouter.get('/articles', async (req, res) => {
  const limit = Math.min(100, Number(req.query.limit ?? 50));
  const page = Math.max(1, Number(req.query.page ?? 1));
  const [{ rows }, total] = await Promise.all([
    query(
      `SELECT a.id, a.slug, a.title, a.dek, a.status, a.views, a.read_minutes, a.hero_image, a.published_at, a.model, a.usage,
              jsonb_array_length(a.charts) AS charts, t.name AS topic_name
       FROM articles a LEFT JOIN topics t ON t.id = a.topic_id ORDER BY a.published_at DESC LIMIT $1 OFFSET $2`,
      [limit, (page - 1) * limit],
    ),
    one<{ n: string }>('SELECT count(*) AS n FROM articles'),
  ]);
  res.json({ articles: rows, page, limit, total: Number(total.n) });
});

adminRouter.patch('/articles/:id', async (req, res) => {
  const body = (req.body ?? {}) as Partial<Article>;
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const field of ['title', 'dek', 'status', 'body_md'] as const) {
    if (field in body) params.push(body[field]), sets.push(`${field} = $${params.length}`);
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update.' });
  params.push(Number(req.params.id));
  try {
    const row = await one<Article>(`UPDATE articles SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
    row ? res.json(row) : res.status(404).json({ error: 'Not found' });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

adminRouter.post('/articles/:id/regenerate-image', async (req, res) => {
  try {
    res.json(await regenerateImage(Number(req.params.id)));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

adminRouter.delete('/articles/:id', async (req, res) => {
  const row = await one<Article>('DELETE FROM articles WHERE id = $1 RETURNING hero_image', [Number(req.params.id)]);
  if (row) await deleteImage(row.hero_image);
  res.json({ ok: true });
});
