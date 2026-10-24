import { randomBytes } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { illustrate, writeArticle, type ImageSpec, type Usage } from './ai.js';
import { imagesDir } from './config.js';
import { one, query } from './db.js';
import type { Article, ArticleImage, Run, Settings, Topic } from './types.js';

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

export async function deleteImage(name: string | null | undefined) {
  if (!name) return;
  await unlink(path.join(imagesDir(), path.basename(name))).catch(() => {});
}

export const deleteImages = (images: ArticleImage[] | null | undefined) => Promise.all((images ?? []).map((i) => deleteImage(i.file)));

const setStep = (runId: number, step: string) => query('UPDATE runs SET step = $2 WHERE id = $1', [runId, step]);

/**
 * Renders every requested illustration, two at a time. The cover (index 0) uses the cover quality, inline
 * figures the (cheaper) figure quality. A failed image is skipped (logged) rather than failing the article;
 * the remaining ones keep their [[image:N]] numbering via the returned index map.
 */
async function renderImages(settings: Settings, specs: ImageSpec[], onProgress: (done: number) => void) {
  const results: (ArticleImage | undefined)[] = new Array(specs.length);
  let next = 0;
  let done = 0;
  let tokens = 0;
  const worker = async () => {
    while (next < specs.length) {
      const i = next++;
      try {
        const rendered = await illustrate(settings, specs[i].prompt, i === 0 ? settings.image_quality : settings.figure_quality);
        tokens += rendered.tokens;
        const file = await saveImage(rendered.bytes);
        results[i] = { file, alt: specs[i].alt, caption: specs[i].caption, prompt: specs[i].prompt };
      } catch (err) {
        console.warn(`image ${i + 1}/${specs.length} failed:`, (err as Error).message);
      }
      onProgress(++done);
    }
  };
  await Promise.all([worker(), worker()]);
  return { results, tokens };
}

/**
 * Rewrites [[image:N]] markers after some images failed: the body refers to original indexes, the stored
 * array only holds the images that exist. Markers for missing images are dropped. The cover (image 1)
 * is never shown in the body.
 */
function remapMarkers(body: string, results: (ArticleImage | undefined)[]) {
  const newIndex = new Map<number, number>();
  let n = 0;
  results.forEach((r, i) => {
    if (r) newIndex.set(i + 1, ++n);
  });
  return body.replace(/^\s*\[\[image:(\d+)\]\]\s*$/gm, (_, num) => {
    const mapped = newIndex.get(Number(num));
    return mapped && mapped > 1 ? `[[image:${mapped}]]` : '';
  });
}

/**
 * Cleans up habits the writer has despite instructions: markers glued into headings or sentences are moved to
 * their own line, and a trailing "## Sources" / "## References" section is removed (sources are structured data).
 */
export function tidyBody(body: string) {
  return body
    .replace(/^(#{1,6}\s*)?(.*?)\s*(\[\[(?:chart|image):\d+\]\])\s*(.*)$/gm, (line, hashes, before, marker, after) => {
      if (!before && !after) return line;
      const rest = `${before}${after}`.trim();
      return `${marker}\n\n${rest ? `${hashes ?? ''}${rest}` : ''}`;
    })
    .replace(/\n#{1,6}\s*(sources|references|further reading)\s*:?\s*\n[\s\S]*$/i, '\n')
    .trim();
}

/** Images the writer forgot to place get a slot before successive "## " headings. */
function placeUnusedImages(body: string, imageCount: number) {
  const used = new Set([...body.matchAll(/\[\[image:(\d+)\]\]/g)].map((m) => Number(m[1])));
  const unplaced = [];
  for (let i = 2; i <= imageCount; i++) if (!used.has(i)) unplaced.push(i);
  if (!unplaced.length) return body;
  const parts = body.split(/^(?=## )/m);
  // parts[0] is the intro; insert before headings 2, 3, ... (skip the first heading so the opening stays clean).
  let out = parts[0];
  for (let i = 1; i < parts.length; i++) {
    const img = i >= 2 ? unplaced.shift() : undefined;
    out += (img ? `[[image:${img}]]\n\n` : '') + parts[i];
  }
  for (const img of unplaced) out += `\n\n[[image:${img}]]\n`;
  return out;
}

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
  const usage: Usage = { input_tokens: 0, output_tokens: 0, images: 0, image_tokens: 0 };
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

    let images: ArticleImage[] = [];
    let body = tidyBody(draft.body_markdown);
    if (settings.images_enabled) {
      const specs = draft.images.slice(0, Math.max(1, settings.images_max));
      await setStep(run.id, `illustrating 0/${specs.length}`);
      const { results, tokens } = await renderImages(settings, specs, (done) => void setStep(run.id, `illustrating ${done}/${specs.length}`));
      body = remapMarkers(body, results);
      images = results.filter((r): r is ArticleImage => Boolean(r));
      usage.images = images.length;
      usage.image_tokens = tokens;
      body = placeUnusedImages(body, images.length);
    } else {
      body = body.replace(/^\s*\[\[image:\d+\]\]\s*$/gm, '');
    }
    const cover = images[0];

    await setStep(run.id, 'saving');
    const article = await one<Article>(
      `INSERT INTO articles (slug, title, dek, body_md, topic_id, tags, hero_image, hero_alt, image_prompt, images, charts, sources, model, usage, read_minutes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *`,
      [
        await uniqueSlug(draft.title),
        draft.title,
        draft.dek,
        body,
        topic.id,
        draft.tags.slice(0, 6).map((t) => t.toLowerCase().trim()),
        cover?.file ?? null,
        cover?.alt ?? draft.images[0]?.alt ?? null,
        draft.images[0]?.prompt ?? null,
        JSON.stringify(images),
        JSON.stringify(draft.charts),
        JSON.stringify(draft.sources),
        written.model,
        JSON.stringify(usage),
        readMinutes(body),
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

/** Re-renders every illustration of an existing article from its stored prompts (same count, same placement). */
export async function regenerateImages(articleId: number) {
  const [settings, article] = await Promise.all([
    one<Settings>('SELECT * FROM settings WHERE id = 1'),
    one<Article>('SELECT * FROM articles WHERE id = $1', [articleId]),
  ]);
  if (!article) throw new Error('Article not found.');
  const specs: ImageSpec[] = article.images.length
    ? article.images.map((i) => ({ prompt: i.prompt || `${article.title}. ${article.dek}`, alt: i.alt, caption: i.caption }))
    : [{ prompt: article.image_prompt || `${article.title}. ${article.dek}`, alt: article.hero_alt ?? article.title, caption: '' }];

  const { results } = await renderImages(settings, specs, () => {});
  // Keep an old image wherever the new one failed, so the article never loses a placed figure.
  const images = results.map((r, i) => r ?? article.images[i]).filter((r): r is ArticleImage => Boolean(r));
  const replaced = article.images.filter((old, i) => results[i] && old.file !== results[i]!.file);
  await deleteImages(replaced);
  if (article.hero_image && !article.images.length && results[0]) await deleteImage(article.hero_image);

  return one<Article>('UPDATE articles SET images = $2, hero_image = $3, hero_alt = $4 WHERE id = $1 RETURNING *', [
    articleId,
    JSON.stringify(images),
    images[0]?.file ?? article.hero_image,
    images[0]?.alt ?? article.hero_alt,
  ]);
}
