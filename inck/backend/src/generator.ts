import { randomBytes } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { illustrate, writeArticle, type Usage } from './ai.js';
import { imagesDir } from './config.js';
import { one, query } from './db.js';
import type { Article, Run, Settings, Topic } from './types.js';

let current: Promise<Run> | undefined;

export const isGenerating = () => Boolean(current);

export function slugify(text: string) {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

async function uniqueSlug(title: string) {
  const base = slugify(title) || 'article';
  for (let i = 0; i < 50; i++) {
    const slug = i === 0 ? base : `${base}-${i + 1}`;
    if (!(await one('SELECT 1 FROM articles WHERE slug = $1', [slug]))) return slug;
  }
  return `${base}-${randomBytes(3).toString('hex')}`;
}

export const readMinutes = (markdown: string) => Math.max(1, Math.round(markdown.split(/\s+/).length / 220));

export async function pickTopic(topicId?: number): Promise<Topic> {
  if (topicId) {
    const topic = await one<Topic>('SELECT * FROM topics WHERE id = $1', [topicId]);
    if (!topic) throw new Error(`Topic ${topicId} does not exist.`);
    return topic;
  }
  const { rows } = await query<Topic>('SELECT * FROM topics WHERE enabled AND weight > 0');
  if (!rows.length) throw new Error('No enabled topics. Add or enable a topic in the admin.');
  // Weighted random, slightly favouring topics with fewer recent articles.
  const { rows: counts } = await query<{ topic_id: number; n: string }>(
    `SELECT topic_id, count(*) AS n FROM articles WHERE published_at > now() - interval '7 days' GROUP BY topic_id`,
  );
  const recent = new Map(counts.map((c) => [c.topic_id, Number(c.n)]));
  const weighted = rows.map((t) => ({ t, w: t.weight / (1 + (recent.get(t.id) ?? 0)) }));
  let r = Math.random() * weighted.reduce((s, x) => s + x.w, 0);
  for (const { t, w } of weighted) {
    r -= w;
    if (r <= 0) return t;
  }
  return weighted[weighted.length - 1].t;
}

export async function saveImage(bytes: Buffer) {
  await mkdir(imagesDir(), { recursive: true });
  const name = `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}.webp`;
  await writeFile(path.join(imagesDir(), name), bytes);
  return name;
}

export async function deleteImage(name: string | null) {
  if (!name) return;
  await unlink(path.join(imagesDir(), path.basename(name))).catch(() => {});
}

const setStep = (runId: number, step: string) => query('UPDATE runs SET step = $2 WHERE id = $1', [runId, step]);

/**
 * Generates one article: pick topic → write (JSON) → illustrate → store. Only one generation runs at a time;
 * a second call while busy returns the in-flight run.
 */
export function generate(trigger: Run['trigger'], topicId?: number): Promise<Run> {
  if (current) return current;
  current = runGeneration(trigger, topicId).finally(() => (current = undefined));
  return current;
}

async function runGeneration(trigger: Run['trigger'], topicId?: number): Promise<Run> {
  const run = await one<Run>('INSERT INTO runs (trigger) VALUES ($1) RETURNING *', [trigger]);
  const usage: Usage = { input_tokens: 0, output_tokens: 0, images: 0 };
  try {
    const settings = await one<Settings>('SELECT * FROM settings WHERE id = 1');
    await setStep(run.id, 'choosing topic');
    const topic = await pickTopic(topicId);
    await query('UPDATE runs SET topic_id = $2 WHERE id = $1', [run.id, topic.id]);

    await setStep(run.id, 'writing');
    const { rows: recent } = await query<{ title: string }>('SELECT title FROM articles ORDER BY published_at DESC LIMIT 30');
    const written = await writeArticle({ settings, topic, recentTitles: recent.map((r) => r.title) });
    Object.assign(usage, written.usage);
    const draft = written.draft;
    if (!settings.charts_enabled) draft.charts = [];

    let heroImage: string | null = null;
    if (settings.images_enabled) {
      await setStep(run.id, 'illustrating');
      try {
        heroImage = await saveImage(await illustrate(settings, draft.image_prompt));
        usage.images = 1;
      } catch (err) {
        // An article without a picture beats no article; the admin can regenerate the image later.
        console.warn(`image generation failed for run ${run.id}:`, (err as Error).message);
      }
    }

    await setStep(run.id, 'saving');
    const article = await one<Article>(
      `INSERT INTO articles (slug, title, dek, body_md, topic_id, tags, hero_image, hero_alt, image_prompt, charts, sources, model, usage, read_minutes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
      [
        await uniqueSlug(draft.title),
        draft.title,
        draft.dek,
        draft.body_markdown,
        topic.id,
        draft.tags.slice(0, 6).map((t) => t.toLowerCase().trim()),
        heroImage,
        draft.image_alt,
        draft.image_prompt,
        JSON.stringify(draft.charts),
        JSON.stringify(draft.sources),
        written.model,
        JSON.stringify(usage),
        readMinutes(draft.body_markdown),
      ],
    );
    await query('UPDATE settings SET last_run_at = now() WHERE id = 1');
    return await one<Run>(
      `UPDATE runs SET status = 'succeeded', step = 'done', article_id = $2, usage = $3, finished_at = now() WHERE id = $1 RETURNING *`,
      [run.id, article.id, JSON.stringify(usage)],
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`generation run ${run.id} failed:`, message);
    // Count failed runs against the interval too, so a broken key does not retry every tick.
    await query('UPDATE settings SET last_run_at = now() WHERE id = 1');
    return await one<Run>(
      `UPDATE runs SET status = 'failed', error = $2, usage = $3, finished_at = now() WHERE id = $1 RETURNING *`,
      [run.id, message.slice(0, 2000), JSON.stringify(usage)],
    );
  }
}

/** Re-generates only the hero image of an existing article. */
export async function regenerateImage(articleId: number) {
  const [settings, article] = await Promise.all([
    one<Settings>('SELECT * FROM settings WHERE id = 1'),
    one<Article>('SELECT * FROM articles WHERE id = $1', [articleId]),
  ]);
  if (!article) throw new Error('Article not found.');
  const prompt = article.image_prompt || `${article.title}. ${article.dek}`;
  const name = await saveImage(await illustrate(settings, prompt));
  await deleteImage(article.hero_image);
  return one<Article>('UPDATE articles SET hero_image = $2 WHERE id = $1 RETURNING *', [articleId, name]);
}
