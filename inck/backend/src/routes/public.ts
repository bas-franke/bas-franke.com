import { Router } from 'express';
import { one, query } from '../db.js';
import { nextRunAt } from '../scheduler.js';
import type { Settings, Story, StoryImage, Topic } from '../types.js';

export const publicRouter = Router();

const FEED_LIMIT = 8;
const PATH_ORDER = 's.section_index, s.plan_index, s.published_at, s.id';

type FeedRow = Story & {
  topic_slug: string;
  topic_name: string;
  topic_category: string;
  topic_kind: string;
  topic_heat: number;
  topic_heat_reason: string;
  topic_total: string;
  topic_position: string;
};

const STORY_COLUMNS = `s.id, s.slug, s.title, s.hook, s.body_md, s.takeaway, s.kind, s.why_now, s.section_index, s.plan_index, s.section_name,
  s.difficulty, s.tags, s.images, s.sources, s.read_seconds, s.views, s.published_at,
  t.id AS topic_id, t.slug AS topic_slug, t.name AS topic_name, t.category AS topic_category, t.kind AS topic_kind,
  t.heat AS topic_heat, t.heat_reason AS topic_heat_reason,
  (SELECT count(*) FROM stories x WHERE x.topic_id = s.topic_id AND x.status = 'published') AS topic_total,
  (SELECT count(*) FROM stories x WHERE x.topic_id = s.topic_id AND x.status = 'published'
     AND (x.section_index, x.plan_index, x.published_at, x.id) < (s.section_index, s.plan_index, s.published_at, s.id)) AS topic_position`;

const COMPACT_COLUMNS = `r.slug, r.title, r.hook, r.read_seconds, r.kind, r.difficulty, rt.slug AS topic_slug, rt.name AS topic_name`;

/** Up to two neighbours on the topic's path plus up to two stories elsewhere that share tags: the "go deeper" links. */
async function related(s: FeedRow) {
  const position = s.section_index * 10000 + Math.min(s.plan_index, 9999);
  const { rows } = await query(
    `(SELECT ${COMPACT_COLUMNS}, true AS same_topic FROM stories r JOIN topics rt ON rt.id = r.topic_id
      WHERE r.status = 'published' AND r.id <> $1 AND r.topic_id = $2
      ORDER BY abs((r.section_index * 10000 + least(r.plan_index, 9999)) - $3) ASC, r.published_at DESC LIMIT 2)
     UNION ALL
     (SELECT ${COMPACT_COLUMNS}, false AS same_topic FROM stories r JOIN topics rt ON rt.id = r.topic_id
      WHERE r.status = 'published' AND r.id <> $1 AND r.topic_id <> $2 AND r.tags && $4::text[]
      ORDER BY cardinality(ARRAY(SELECT unnest(r.tags) INTERSECT SELECT unnest($4::text[]))) DESC, r.published_at DESC LIMIT 2)`,
    [s.id, s.topic_id, position, s.tags],
  );
  return rows;
}

async function present(rows: FeedRow[]) {
  return Promise.all(
    rows.map(async (s) => {
      const { topic_slug, topic_name, topic_category, topic_kind, topic_heat, topic_heat_reason, topic_total, topic_position, topic_id, ...story } = s;
      return {
        ...story,
        // Prompts are internal; the public site only needs the file.
        images: (story.images as StoryImage[]).map(({ file, alt, caption }) => ({ file, alt, caption })),
        topic: {
          id: topic_id,
          slug: topic_slug,
          name: topic_name,
          category: topic_category,
          kind: topic_kind,
          heat: topic_heat,
          heat_reason: topic_heat ? topic_heat_reason : '',
          stories: Number(topic_total),
        },
        position: Number(topic_position),
        related: await related(s),
      };
    }),
  );
}

publicRouter.get('/site', async (_req, res) => {
  const settings = await one<Settings>('SELECT * FROM settings WHERE id = 1');
  const counts = await one<{ stories: string; topics: string }>(
    `SELECT (SELECT count(*) FROM stories WHERE status = 'published') AS stories,
            (SELECT count(DISTINCT topic_id) FROM stories WHERE status = 'published') AS topics`,
  );
  // What the radar found hot, for the trending strip and the rail; hottest first, freshest scan first.
  const { rows: trending } = await query(
    `SELECT t.slug, t.name, t.category, t.kind, t.heat, t.heat_reason, count(s.id)::int AS stories,
            (SELECT x.slug FROM stories x WHERE x.topic_id = t.id AND x.status = 'published' ORDER BY x.published_at DESC LIMIT 1) AS latest_slug
     FROM topics t LEFT JOIN stories s ON s.topic_id = t.id AND s.status = 'published'
     WHERE t.enabled AND t.heat > 0 GROUP BY t.id ORDER BY t.heat DESC, t.heat_at DESC LIMIT 8`,
  );
  res.json({
    site_name: settings.site_name,
    tagline: settings.tagline,
    interval_minutes: settings.interval_minutes,
    next_story_at: nextRunAt(settings),
    stories: Number(counts.stories),
    topics: Number(counts.topics),
    trending,
  });
});

/**
 * The feed. Latest mode: newest first across all topics. Topic mode (?t=slug): that topic's stories in curriculum
 * order. `from` (inclusive) starts at a story, `after` (exclusive) continues past one; both are slugs.
 */
publicRouter.get('/feed', async (req, res) => {
  const limit = Math.min(20, Math.max(1, Number(req.query.limit ?? FEED_LIMIT)));
  const topicSlug = typeof req.query.t === 'string' ? req.query.t : null;
  const from = typeof req.query.from === 'string' ? req.query.from : null;
  const after = typeof req.query.after === 'string' ? req.query.after : null;

  const topic = topicSlug ? await one<Topic>('SELECT * FROM topics WHERE slug = $1', [topicSlug]) : null;
  if (topicSlug && !topic) return res.status(404).json({ error: 'Unknown topic' });

  const anchorSlug = after ?? from;
  const anchor = anchorSlug ? await one<Story>(`SELECT * FROM stories WHERE slug = $1 AND status = 'published'`, [anchorSlug]) : null;
  if (anchorSlug && !anchor) return res.status(404).json({ error: 'This story does not exist.' });
  if (anchor && topic && anchor.topic_id !== topic.id) return res.status(404).json({ error: 'That story is not part of this topic.' });

  const where = [`s.status = 'published'`];
  const params: unknown[] = [];
  if (topic) params.push(topic.id), where.push(`s.topic_id = $${params.length}`);
  const op = after ? (topic ? '>' : '<') : topic ? '>=' : '<=';
  if (anchor) {
    if (topic) {
      params.push(anchor.section_index, anchor.plan_index, anchor.published_at, anchor.id);
      where.push(`(s.section_index, s.plan_index, s.published_at, s.id) ${op} ($${params.length - 3}, $${params.length - 2}, $${params.length - 1}, $${params.length})`);
    } else {
      params.push(anchor.published_at, anchor.id);
      where.push(`(s.published_at, s.id) ${op} ($${params.length - 1}, $${params.length})`);
    }
  }
  params.push(limit + 1);
  const { rows } = await query<FeedRow>(
    `SELECT ${STORY_COLUMNS} FROM stories s JOIN topics t ON t.id = s.topic_id
     WHERE ${where.join(' AND ')} ORDER BY ${topic ? PATH_ORDER : 's.published_at DESC, s.id DESC'} LIMIT $${params.length}`,
    params,
  );
  const page = rows.slice(0, limit);

  // Are there stories before the first one shown (newer ones, or earlier on the topic's path)?
  let hasBefore = false;
  if (page.length && anchor && !after) {
    const first = page[0];
    const before = topic
      ? await one(
          `SELECT 1 FROM stories WHERE status = 'published' AND topic_id = $1 AND (section_index, plan_index, published_at, id) < ($2, $3, $4, $5) LIMIT 1`,
          [topic.id, first.section_index, first.plan_index, first.published_at, first.id],
        )
      : await one(`SELECT 1 FROM stories WHERE status = 'published' AND (published_at, id) > ($1, $2) LIMIT 1`, [first.published_at, first.id]);
    hasBefore = Boolean(before);
  }

  res.json({
    stories: await present(page),
    has_more: rows.length > limit,
    has_before: hasBefore,
    topic: topic ? { slug: topic.slug, name: topic.name, category: topic.category, kind: topic.kind } : null,
  });
});

publicRouter.post('/stories/:id/view', async (req, res) => {
  const id = Number(req.params.id);
  if (Number.isInteger(id)) query('UPDATE stories SET views = views + 1 WHERE id = $1', [id]).catch(() => {});
  res.status(204).end();
});

/** All topics for the overview: counts, the latest story and where to start. */
publicRouter.get('/topics', async (_req, res) => {
  const { rows } = await query(
    `SELECT t.id, t.slug, t.name, t.description, t.category, t.kind, t.plan->>'intro' AS intro, t.heat, t.heat_reason,
            count(s.id)::int AS stories, max(s.published_at) AS updated_at,
            (SELECT jsonb_build_object('slug', x.slug, 'title', x.title, 'hook', x.hook) FROM stories x
               WHERE x.topic_id = t.id AND x.status = 'published' ORDER BY x.published_at DESC LIMIT 1) AS latest,
            (SELECT x.slug FROM stories x WHERE x.topic_id = t.id AND x.status = 'published'
               ORDER BY x.section_index, x.plan_index, x.published_at, x.id LIMIT 1) AS first_slug
     FROM topics t LEFT JOIN stories s ON s.topic_id = t.id AND s.status = 'published'
     WHERE t.enabled GROUP BY t.id ORDER BY max(s.published_at) DESC NULLS LAST, t.name`,
  );
  res.json({ topics: rows });
});

/** One topic's hub: intro, sections and every published story placed in the curriculum. */
publicRouter.get('/topics/:slug', async (req, res) => {
  const topic = await one<Topic>('SELECT * FROM topics WHERE slug = $1 AND enabled', [req.params.slug]);
  if (!topic) return res.status(404).json({ error: 'Unknown topic' });
  const { rows: stories } = await query(
    `SELECT slug, title, hook, kind, why_now, section_index, plan_index, section_name, difficulty, read_seconds, views, published_at,
            (SELECT i->>'file' FROM jsonb_array_elements(images) i LIMIT 1) AS image
     FROM stories WHERE topic_id = $1 AND status = 'published' ORDER BY section_index, plan_index, published_at, id`,
    [topic.id],
  );
  const plan = topic.plan;
  res.json({
    topic: {
      id: topic.id,
      slug: topic.slug,
      name: topic.name,
      description: topic.description,
      category: topic.category,
      kind: topic.kind,
      intro: plan?.intro ?? topic.description,
      heat: topic.heat,
      heat_reason: topic.heat ? topic.heat_reason : '',
      created_at: topic.created_at,
    },
    sections: (plan?.sections ?? []).map((s, index) => ({ index, name: s.name, blurb: s.blurb, live: Boolean(s.live), planned: s.items.map((i) => i.title) })),
    stories,
  });
});

publicRouter.get('/search', async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (q.length < 2) return res.json({ stories: [] });
  const { rows } = await query(
    `SELECT ${COMPACT_COLUMNS} FROM stories r JOIN topics rt ON rt.id = r.topic_id
     WHERE r.status = 'published' AND (r.title ILIKE $1 OR r.hook ILIKE $1 OR r.body_md ILIKE $1 OR $2 = ANY(r.tags) OR rt.name ILIKE $1)
     ORDER BY (r.title ILIKE $1) DESC, r.published_at DESC LIMIT 20`,
    [`%${q}%`, q.toLowerCase()],
  );
  res.json({ stories: rows });
});
