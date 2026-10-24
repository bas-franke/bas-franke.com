import { Router } from 'express';
import { one, query } from '../db.js';
import { countryOf } from '../geo.js';
import { nextRunAt } from '../scheduler.js';
import type { Settings, Story, StoryImage, Topic } from '../types.js';

export const publicRouter = Router();

const FEED_LIMIT = 8;
const PATH_ORDER = 's.section_index, s.plan_index, s.published_at, s.id';

/**
 * Country-specific news is only offered to visitors from that country: in the latest feed, the trending strip and
 * "go deeper" suggestions. Topic pages, topic mode, search and direct links stay open to everyone.
 * `$n` holds the visitor's country (null when unknown, which leaves only global topics).
 */
const visible = (alias: string, n: number) => `(${alias}.country IS NULL OR ${alias}.country = $${n})`;

type FeedRow = Story & {
  topic_slug: string;
  topic_name: string;
  topic_category: string;
  topic_kind: string;
  topic_heat: number;
  topic_heat_reason: string;
  topic_country: string | null;
  topic_total: string;
  topic_position: string;
};

const STORY_COLUMNS = `s.id, s.slug, s.title, s.hook, s.body_md, s.takeaway, s.kind, s.why_now, s.section_index, s.plan_index, s.section_name,
  s.difficulty, s.tags, s.images, s.sources, s.read_seconds, s.views, s.published_at,
  t.id AS topic_id, t.slug AS topic_slug, t.name AS topic_name, t.category AS topic_category, t.kind AS topic_kind,
  t.heat AS topic_heat, t.heat_reason AS topic_heat_reason, t.country AS topic_country,
  (SELECT count(*) FROM stories x WHERE x.topic_id = s.topic_id AND x.status = 'published') AS topic_total,
  (SELECT count(*) FROM stories x WHERE x.topic_id = s.topic_id AND x.status = 'published'
     AND (x.section_index, x.plan_index, x.published_at, x.id) < (s.section_index, s.plan_index, s.published_at, s.id)) AS topic_position`;

const COMPACT_COLUMNS = `r.slug, r.title, r.hook, r.read_seconds, r.kind, r.difficulty, rt.slug AS topic_slug, rt.name AS topic_name`;

/**
 * The "go deeper" links: up to two neighbours on the topic's path, up to two stories elsewhere that share tags,
 * and, while the site is small, the latest stories of the hottest other topics so the row is never empty.
 */
async function related(s: FeedRow, country: string | null) {
  const position = s.section_index * 10000 + Math.min(s.plan_index, 9999);
  const { rows } = await query<{ slug: string; same_topic: boolean }>(
    `(SELECT ${COMPACT_COLUMNS}, true AS same_topic FROM stories r JOIN topics rt ON rt.id = r.topic_id
      WHERE r.status = 'published' AND r.id <> $1 AND r.topic_id = $2
      ORDER BY abs((r.section_index * 10000 + least(r.plan_index, 9999)) - $3) ASC, r.published_at DESC LIMIT 2)
     UNION ALL
     (SELECT ${COMPACT_COLUMNS}, false AS same_topic FROM stories r JOIN topics rt ON rt.id = r.topic_id
      WHERE r.status = 'published' AND r.id <> $1 AND r.topic_id <> $2 AND r.tags && $4::text[] AND ${visible('rt', 5)}
      ORDER BY cardinality(ARRAY(SELECT unnest(r.tags) INTERSECT SELECT unnest($4::text[]))) DESC, r.published_at DESC LIMIT 2)`,
    [s.id, s.topic_id, position, s.tags, country],
  );
  if (rows.length >= 3) return rows;
  const { rows: more } = await query(
    `SELECT DISTINCT ON (rt.id) ${COMPACT_COLUMNS}, false AS same_topic FROM stories r JOIN topics rt ON rt.id = r.topic_id
     WHERE r.status = 'published' AND r.id <> $1 AND r.topic_id <> $2 AND NOT (r.slug = ANY($3::text[])) AND ${visible('rt', 4)}
     ORDER BY rt.id, r.published_at DESC`,
    [s.id, s.topic_id, rows.map((r) => r.slug), country],
  );
  // One per topic, hottest topics first, then newest.
  const { rows: heat } = await query<{ slug: string; heat: number }>('SELECT slug, heat FROM topics');
  const heatOf = new Map(heat.map((h) => [h.slug, h.heat]));
  more.sort((a, b) => (heatOf.get(b.topic_slug) ?? 0) - (heatOf.get(a.topic_slug) ?? 0));
  return [...rows, ...more.slice(0, 4 - rows.length)];
}

async function present(rows: FeedRow[], country: string | null) {
  return Promise.all(
    rows.map(async (s) => {
      const { topic_slug, topic_name, topic_category, topic_kind, topic_heat, topic_heat_reason, topic_country, topic_total, topic_position, topic_id, ...story } = s;
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
          country: topic_country,
          stories: Number(topic_total),
        },
        position: Number(topic_position),
        related: await related(s, country),
      };
    }),
  );
}

publicRouter.get('/site', async (req, res) => {
  const country = countryOf(req.ip);
  const settings = await one<Settings>('SELECT * FROM settings WHERE id = 1');
  const counts = await one<{ stories: string; topics: string }>(
    `SELECT (SELECT count(*) FROM stories WHERE status = 'published') AS stories,
            (SELECT count(DISTINCT topic_id) FROM stories WHERE status = 'published') AS topics`,
  );
  // What the radar found hot, for the trending strip and the rail; hottest first, freshest scan first.
  const { rows: trending } = await query(
    `SELECT t.slug, t.name, t.category, t.kind, t.heat, t.heat_reason, t.country, count(s.id)::int AS stories,
            (SELECT x.slug FROM stories x WHERE x.topic_id = t.id AND x.status = 'published' ORDER BY x.published_at DESC LIMIT 1) AS latest_slug
     FROM topics t LEFT JOIN stories s ON s.topic_id = t.id AND s.status = 'published'
     WHERE t.enabled AND t.heat > 0 AND ${visible('t', 1)} GROUP BY t.id ORDER BY t.heat DESC, t.heat_at DESC LIMIT 8`,
    [country],
  );
  res.json({
    site_name: settings.site_name,
    tagline: settings.tagline,
    interval_minutes: settings.interval_minutes,
    next_story_at: nextRunAt(settings),
    stories: Number(counts.stories),
    topics: Number(counts.topics),
    trending,
    country,
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
  const country = countryOf(req.ip);

  const topic = topicSlug ? await one<Topic>('SELECT * FROM topics WHERE slug = $1', [topicSlug]) : null;
  if (topicSlug && !topic) return res.status(404).json({ error: 'Unknown topic' });

  const anchorSlug = after ?? from;
  const anchor = anchorSlug ? await one<Story>(`SELECT * FROM stories WHERE slug = $1 AND status = 'published'`, [anchorSlug]) : null;
  if (anchorSlug && !anchor) return res.status(404).json({ error: 'This story does not exist.' });
  if (anchor && topic && anchor.topic_id !== topic.id) return res.status(404).json({ error: 'That story is not part of this topic.' });

  const where = [`s.status = 'published'`];
  const params: unknown[] = [];
  if (topic) params.push(topic.id), where.push(`s.topic_id = $${params.length}`);
  else {
    // The latest feed skips other countries' national news, except the story a link points at.
    params.push(country, anchor?.id ?? null);
    where.push(`(${visible('t', params.length - 1)} OR s.id = $${params.length})`);
  }
  const op = after ? (topic ? '>' : '<') : topic ? '>=' : '<=';
  if (anchor) {
    // Compare against the stored row rather than a JavaScript Date: timestamps keep microseconds in Postgres and
    // only milliseconds in JS, so a round-tripped value would skip the anchor itself.
    params.push(anchor.id);
    where.push(
      topic
        ? `(s.section_index, s.plan_index, s.published_at, s.id) ${op} (SELECT a.section_index, a.plan_index, a.published_at, a.id FROM stories a WHERE a.id = $${params.length})`
        : `(s.published_at, s.id) ${op} (SELECT a.published_at, a.id FROM stories a WHERE a.id = $${params.length})`,
    );
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
          `SELECT 1 FROM stories WHERE status = 'published' AND topic_id = $1
             AND (section_index, plan_index, published_at, id) < (SELECT a.section_index, a.plan_index, a.published_at, a.id FROM stories a WHERE a.id = $2) LIMIT 1`,
          [topic.id, first.id],
        )
      : await one(
          `SELECT 1 FROM stories s JOIN topics t ON t.id = s.topic_id WHERE s.status = 'published' AND ${visible('t', 2)}
             AND (s.published_at, s.id) > (SELECT a.published_at, a.id FROM stories a WHERE a.id = $1) LIMIT 1`,
          [first.id, country],
        );
    hasBefore = Boolean(before);
  }

  res.json({
    stories: await present(page, country),
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
    `SELECT t.id, t.slug, t.name, t.description, t.category, t.kind, t.country, t.plan->>'intro' AS intro, t.heat, t.heat_reason,
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
      country: topic.country,
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
