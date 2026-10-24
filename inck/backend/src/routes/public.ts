import { Router } from 'express';
import { one, query } from '../db.js';
import { nextRunAt } from '../scheduler.js';
import type { Article, Settings } from '../types.js';

export const publicRouter = Router();

const LIST_COLUMNS = `a.id, a.slug, a.title, a.dek, a.kind, a.why_now, a.tags, a.hero_image, a.hero_alt, a.read_minutes, a.views, a.published_at,
  t.name AS topic_name, t.id AS topic_id`;

publicRouter.get('/site', async (_req, res) => {
  const settings = await one<Settings>('SELECT * FROM settings WHERE id = 1');
  const { rows: topics } = await query(
    `SELECT t.id, t.name, t.description, count(a.id)::int AS articles
     FROM topics t LEFT JOIN articles a ON a.topic_id = t.id AND a.status = 'published'
     WHERE t.enabled GROUP BY t.id ORDER BY t.name`,
  );
  res.json({
    site_name: settings.site_name,
    tagline: settings.tagline,
    interval_minutes: settings.interval_minutes,
    next_article_at: nextRunAt(settings),
    topics,
  });
});

publicRouter.get('/articles', async (req, res) => {
  const limit = Math.min(50, Math.max(1, Number(req.query.limit ?? 12)));
  const page = Math.max(1, Number(req.query.page ?? 1));
  const topic = req.query.topic ? Number(req.query.topic) : null;
  const q = typeof req.query.q === 'string' && req.query.q.trim() ? `%${req.query.q.trim()}%` : null;

  const where = [`a.status = 'published'`];
  const params: unknown[] = [];
  if (topic) params.push(topic), where.push(`a.topic_id = $${params.length}`);
  if (q) params.push(q), where.push(`(a.title ILIKE $${params.length} OR a.dek ILIKE $${params.length} OR a.body_md ILIKE $${params.length})`);

  const total = await one<{ n: string }>(`SELECT count(*) AS n FROM articles a WHERE ${where.join(' AND ')}`, params);
  params.push(limit, (page - 1) * limit);
  const { rows } = await query(
    `SELECT ${LIST_COLUMNS} FROM articles a LEFT JOIN topics t ON t.id = a.topic_id
     WHERE ${where.join(' AND ')} ORDER BY a.published_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  res.json({ articles: rows, page, limit, total: Number(total?.n ?? 0) });
});

publicRouter.get('/articles/:slug', async (req, res) => {
  const article = await one<Article & { topic_name: string | null }>(
    `SELECT a.*, t.name AS topic_name FROM articles a LEFT JOIN topics t ON t.id = a.topic_id
     WHERE a.slug = $1 AND a.status = 'published'`,
    [req.params.slug],
  );
  if (!article) return res.status(404).json({ error: 'Not found' });
  query('UPDATE articles SET views = views + 1 WHERE id = $1', [article.id]).catch(() => {});

  const { rows: related } = await query(
    `SELECT ${LIST_COLUMNS} FROM articles a LEFT JOIN topics t ON t.id = a.topic_id
     WHERE a.status = 'published' AND a.id <> $1
     ORDER BY (a.topic_id = $2) DESC, a.published_at DESC LIMIT 3`,
    [article.id, article.topic_id],
  );
  const { usage: _usage, image_prompt: _prompt, ...publicArticle } = article;
  res.json({ article: publicArticle, related });
});
