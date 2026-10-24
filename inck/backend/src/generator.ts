import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import {
  addUsage,
  emptyUsage,
  illustrate,
  picturePolicy,
  scanTrends,
  scoutTrends,
  writeStory,
  type ImageSpec,
  type PicturePolicy,
  type StoryDraft,
  type Trend,
  type TrendPick,
  type Usage,
} from './ai.js';
import { imagesDir } from './config.js';
import { one, query } from './db.js';
import { collectSignals, formatSignals } from './signals.js';
import { createTopic, ensurePlan, extendPlan, nextPlanItem, pickHotTopic, pickTopic, resolveSection, uniqueSlug, type NextItem } from './topics.js';
import type { Run, Settings, Story, StoryImage, StoryKind, Topic } from './types.js';

let current: Promise<Run> | undefined;

export const isGenerating = () => Boolean(current);

/** Reading time at a relaxed 200 words per minute, in seconds (minimum 20). */
export const readSeconds = (markdown: string) => Math.max(20, Math.round((markdown.split(/\s+/).filter(Boolean).length / 200) * 60));

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

export const deleteImages = (images: StoryImage[] | null | undefined) => Promise.all((images ?? []).map((i) => deleteImage(i.file)));

/** Removes image files no story refers to (deleted stories, the old magazine's illustrations). */
export async function sweepOrphanImages() {
  const files = await readdir(imagesDir()).catch(() => [] as string[]);
  if (!files.length) return 0;
  const { rows } = await query<{ file: string }>(`SELECT i->>'file' AS file FROM stories, jsonb_array_elements(images) i`);
  const used = new Set(rows.map((r) => r.file));
  let removed = 0;
  for (const file of files) {
    if (used.has(file) || !/\.(webp|png|jpe?g)$/i.test(file)) continue;
    await unlink(path.join(imagesDir(), file)).catch(() => {});
    removed++;
  }
  if (removed) console.log(`swept ${removed} orphan image file(s)`);
  return removed;
}

const setStep = (runId: number, step: string) => query('UPDATE runs SET step = $2 WHERE id = $1', [runId, step]);

/**
 * Renders the pictures the policy allows: the writer's specs filtered by relevance and capped, plus one anchoring
 * picture made from the title when a hot topic's story must have one and the writer gave none. A failed picture is skipped.
 */
async function renderImages(
  settings: Settings,
  specs: ImageSpec[],
  policy: PicturePolicy,
  onProgress: (done: number, total: number) => void,
  fallback?: { title: string; hook: string },
) {
  const wanted = specs.filter((s) => policy.accept.includes(s.relevance) && s.prompt?.trim()).slice(0, policy.max);
  if (wanted.length < policy.min && fallback) {
    const extra = specs.find((s) => s.prompt?.trim() && !wanted.includes(s));
    wanted.push(
      extra ?? {
        prompt: `The scene, place or object at the heart of this story: ${fallback.title}. ${fallback.hook}`,
        alt: fallback.title,
        caption: '',
        relevance: 'helpful',
      },
    );
  }
  const images: StoryImage[] = [];
  let tokens = 0;
  for (const [i, spec] of wanted.entries()) {
    try {
      const rendered = await illustrate(settings, spec.prompt);
      tokens += rendered.tokens;
      images.push({ file: await saveImage(rendered.bytes), alt: spec.alt, caption: spec.caption, prompt: spec.prompt });
    } catch (err) {
      console.warn(`picture ${i + 1}/${wanted.length} failed:`, (err as Error).message);
    }
    onProgress(i + 1, wanted.length);
  }
  return { images, tokens };
}

/**
 * Cleans up habits the writer has despite instructions: headings become plain paragraphs, links lose their URL,
 * bare URLs and inline citation numbers are dropped, and horizontal rules vanish.
 */
export function tidyBody(body: string) {
  return body
    .replace(/^#{1,6}\s*(.+)$/gm, '**$1**')
    .replace(/\[([^\]\n]+)\]\((?:https?:\/\/)[^)\s]+\)/g, '$1')
    .replace(/(^|[\s(])<?https?:\/\/[^\s<>)]+>?/g, '$1')
    .replace(/\s?\[\d{1,2}\](?!\()/g, '')
    .replace(/^\s*(-{3,}|\*{3,}|_{3,})\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export type GenerateMode = 'auto' | StoryKind;

/**
 * Decides between a curriculum story and a "right now" story so that, over the last ten stories, the share of
 * trending ones tracks settings.trending_share. A little randomness keeps the rhythm from being predictable.
 */
export async function chooseKind(settings: Settings): Promise<StoryKind> {
  const target = settings.trending_share / 100;
  if (target <= 0) return 'planned';
  if (target >= 1) return 'trending';
  const { rows } = await query<{ kind: StoryKind }>('SELECT kind FROM stories ORDER BY published_at DESC LIMIT 10');
  const actual = rows.length ? rows.filter((r) => r.kind === 'trending').length / rows.length : target;
  const p = Math.min(0.95, Math.max(0.05, target + (target - actual)));
  return Math.random() < p ? 'trending' : 'planned';
}

/* ------------------------------------------------------------------ trend radar */

export const radarStale = (settings: Settings) => !settings.radar_at || Date.now() - settings.radar_at.getTime() > settings.radar_hours * 3600_000;

/**
 * Rescans what is trending. Every trend the radar discovers becomes a topic (or updates the one it belongs to) with
 * a heat score and a one-line reason; topics it no longer lists cool down by one step per scan.
 */
export async function runRadar(settings: Settings, step: (s: string) => void = () => {}, signals?: string): Promise<{ trends: Trend[]; topics: Topic[]; usage: Usage }> {
  step('scanning what is trending');
  const { rows: existing } = await query<Topic>('SELECT * FROM topics ORDER BY name');
  const scan = await scanTrends({ settings, signals: signals ?? formatSignals(await collectSignals()), topics: existing });
  const touched = new Set<number>();
  const topics: Topic[] = [];
  for (const trend of scan.trends) {
    let topic = trend.existing_slug ? existing.find((t) => t.slug === trend.existing_slug) : undefined;
    topic ??= existing.find((t) => t.name.toLowerCase() === trend.name.toLowerCase());
    topic ??= await createTopic({ name: trend.name, description: trend.description, category: trend.category, kind: trend.kind });
    if (touched.has(topic.id)) continue;
    touched.add(topic.id);
    topics.push(
      await one<Topic>(`UPDATE topics SET heat = $2, heat_reason = $3, heat_at = now(), updated_at = now() WHERE id = $1 RETURNING *`, [
        topic.id,
        trend.heat,
        trend.why_now.trim().slice(0, 300),
      ]),
    );
  }
  await query(`UPDATE topics SET heat = heat - 1, updated_at = now() WHERE heat > 0 AND NOT (id = ANY($1::int[]))`, [[...touched]]);
  await query('UPDATE settings SET radar_at = now() WHERE id = 1');
  console.log(`radar: ${topics.map((t) => `${t.name} (${t.heat})`).join(', ')}`);
  return { trends: scan.trends, topics, usage: scan.usage };
}

/** A radar scan as a logged run, for the admin "Scan now" button. */
export async function radarRun(): Promise<Run> {
  const run = await one<Run>(`INSERT INTO runs (trigger, kind, step) VALUES ('manual', 'radar', 'scanning') RETURNING *`);
  try {
    const settings = await one<Settings>('SELECT * FROM settings WHERE id = 1');
    const result = await runRadar(settings, (s) => void setStep(run.id, s).catch(() => {}));
    return await one<Run>(`UPDATE runs SET status = 'succeeded', step = 'done', detail = $2, usage = $3, finished_at = now() WHERE id = $1 RETURNING *`, [
      run.id,
      result.topics.map((t) => `${t.name} (${t.heat}/5)`).join(', ').slice(0, 1000),
      JSON.stringify(result.usage),
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return await one<Run>(`UPDATE runs SET status = 'failed', error = $2, finished_at = now() WHERE id = $1 RETURNING *`, [run.id, message.slice(0, 2000)]);
  }
}

/** Generates one story. Only one generation runs at a time; a second call while busy returns the in-flight run. */
export function generate(trigger: Run['trigger'], opts: { topicId?: number; mode?: GenerateMode } = {}): Promise<Run> {
  if (current) return current;
  current = runGeneration(trigger, opts).finally(() => (current = undefined));
  return current;
}

async function runGeneration(trigger: Run['trigger'], opts: { topicId?: number; mode?: GenerateMode }): Promise<Run> {
  const run = await one<Run>('INSERT INTO runs (trigger) VALUES ($1) RETURNING *', [trigger]);
  const usage: Usage = emptyUsage();
  const step = (s: string) => void setStep(run.id, s).catch(() => {});
  try {
    const settings = await one<Settings>('SELECT * FROM settings WHERE id = 1');
    const { rows: recent } = await query<{ title: string }>('SELECT title FROM stories ORDER BY published_at DESC LIMIT 25');
    let recentTitles = recent.map((r) => r.title);

    const kind: StoryKind = opts.topicId ? 'planned' : opts.mode && opts.mode !== 'auto' ? opts.mode : await chooseKind(settings);
    await query('UPDATE runs SET kind = $2 WHERE id = $1', [run.id, kind]);

    let topic: Topic;
    let trend: TrendPick | undefined;
    let item: NextItem | undefined;
    let signalsText: string | undefined;
    const signals = async () => (signalsText ??= formatSignals(await collectSignals()));

    if (kind === 'trending') {
      // The radar decides what is hot; a "right now" run then serves one of those topics.
      if (radarStale(settings)) {
        const radar = await runRadar(settings, step, await signals());
        addUsage(usage, radar.usage);
      }
      const hot = await pickHotTopic();
      if (hot) {
        topic = hot;
        await query('UPDATE runs SET topic_id = $2 WHERE id = $1', [run.id, topic.id]);
        const ensured = await ensurePlan(settings, topic, step);
        addUsage(usage, ensured.usage);
        topic = ensured.topic;
        const count = Number((await one<{ n: string }>('SELECT count(*) AS n FROM stories WHERE topic_id = $1', [topic.id])).n);
        const next = await nextPlanItem(topic);
        // Basics first: a hot topic with few stories gets its curriculum before day-to-day developments; after that
        // the two alternate, so readers get both the background and what happened today.
        if (next && (count < 4 || Math.random() < 0.5)) {
          item = next;
        } else {
          step('scouting what to explain today');
          const scouted = await scoutTrends({ settings, signals: await signals(), recentTitles, topics: [topic], focus: topic });
          addUsage(usage, scouted.usage);
          trend = scouted.pick;
        }
      } else {
        // Nothing is hot (the radar failed or found nothing usable): the scout discovers one subject by itself.
        step('scouting what is happening');
        const { rows: topics } = await query<Topic>('SELECT * FROM topics WHERE enabled ORDER BY name');
        const scouted = await scoutTrends({ settings, signals: await signals(), recentTitles, topics });
        addUsage(usage, scouted.usage);
        trend = scouted.pick;
        const existing = trend.topic_slug ? topics.find((t) => t.slug === trend!.topic_slug) : undefined;
        topic =
          existing ??
          (await createTopic(
            trend.new_topic ?? { name: trend.subject.slice(0, 60), description: trend.why_now, category: 'world', kind: 'event' },
          ));
      }
      if (trend) await query('UPDATE runs SET topic_id = $2, detail = $3 WHERE id = $1', [run.id, topic.id, trend.subject]);
    } else {
      step('choosing a topic');
      topic = await pickTopic(opts.topicId);
      await query('UPDATE runs SET topic_id = $2 WHERE id = $1', [run.id, topic.id]);
    }

    const ensured = await ensurePlan(settings, topic, step);
    addUsage(usage, ensured.usage);
    topic = ensured.topic;

    if (!trend && !item) {
      item = (await nextPlanItem(topic)) ?? undefined;
      if (!item) {
        step('extending the curriculum');
        const extended = await extendPlan(settings, topic);
        addUsage(usage, extended.usage);
        topic = extended.topic;
        item = (await nextPlanItem(topic)) ?? undefined;
      }
      if (!item) throw new Error(`Topic "${topic.name}" has no unwritten curriculum item.`);
    }
    if (item) {
      await query('UPDATE runs SET detail = $2 WHERE id = $1', [run.id, item.title]);
      const { rows: inTopic } = await query<{ title: string }>('SELECT title FROM stories WHERE topic_id = $1 ORDER BY published_at DESC LIMIT 40', [topic.id]);
      recentTitles = [...new Set([...inTopic.map((r) => r.title), ...recentTitles])];
    }
    // A curriculum item written for a hot topic is still a curriculum story; only scouted developments are "trending".
    const storyKind: StoryKind = trend ? 'trending' : 'planned';

    step('writing');
    const plan = topic.plan!;
    const pictures = picturePolicy(settings, topic.heat);
    const written = await writeStory({ settings, topic, plan, item: item && { section: item.section.name, title: item.title, brief: item.brief }, trend, recentTitles, pictures });
    addUsage(usage, written.usage);
    const draft: StoryDraft = written.draft;

    step('illustrating');
    const { images, tokens } = await renderImages(settings, draft.images ?? [], pictures, (done, total) => step(`illustrating ${done}/${total}`), {
      title: draft.title,
      hook: draft.hook ?? '',
    });
    usage.images = images.length;
    usage.image_tokens = tokens;

    // Where the story sits in the topic's curriculum: planned items keep their slot; trending ones go after the
    // planned items of the section the writer chose (or into "Latest").
    let sectionIndex: number;
    let planIndex: number;
    let sectionName: string;
    if (item) {
      sectionIndex = item.section_index;
      planIndex = item.plan_index;
      sectionName = item.section.name;
    } else {
      const resolved = resolveSection(plan, draft.section ?? '');
      const count = await one<{ n: string }>('SELECT count(*) AS n FROM stories WHERE topic_id = $1 AND section_index = $2 AND kind = $3', [topic.id, resolved.index, 'trending']);
      sectionIndex = resolved.index;
      planIndex = 1000 + Number(count.n);
      sectionName = resolved.section.name;
    }

    step('saving');
    const body = tidyBody(draft.body_markdown);
    const story = await one<Story>(
      `INSERT INTO stories (slug, topic_id, title, hook, body_md, takeaway, kind, why_now, section_index, plan_index, section_name, plan_item,
                            difficulty, tags, images, sources, model, usage, read_seconds)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19) RETURNING *`,
      [
        await uniqueSlug('stories', draft.title),
        topic.id,
        draft.title.trim().slice(0, 90),
        (draft.hook ?? '').trim().slice(0, 200),
        body,
        (draft.takeaway ?? '').trim().slice(0, 300),
        storyKind,
        trend?.why_now ?? null,
        sectionIndex,
        planIndex,
        sectionName,
        item?.title ?? null,
        Math.min(3, Math.max(1, Math.round(Number(draft.difficulty) || 1))),
        (draft.tags ?? []).slice(0, 5).map((t) => t.toLowerCase().trim()).filter(Boolean),
        JSON.stringify(images),
        JSON.stringify((draft.sources ?? []).filter((s) => s.url).slice(0, 4)),
        written.model,
        JSON.stringify(usage),
        readSeconds(body),
      ],
    );
    await query('UPDATE settings SET last_run_at = now() WHERE id = 1');
    return await one<Run>(
      `UPDATE runs SET status = 'succeeded', step = 'done', story_id = $2, usage = $3, finished_at = now() WHERE id = $1 RETURNING *`,
      [run.id, story.id, JSON.stringify(usage)],
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

/** Re-renders the pictures of an existing story from their stored prompts. */
export async function regenerateImages(storyId: number) {
  const [settings, story] = await Promise.all([one<Settings>('SELECT * FROM settings WHERE id = 1'), one<Story>('SELECT * FROM stories WHERE id = $1', [storyId])]);
  if (!story) throw new Error('Story not found.');
  if (!story.images.length) throw new Error('This story has no pictures to re-render.');
  const specs: ImageSpec[] = story.images.map((i) => ({ prompt: i.prompt || `${story.title}. ${story.hook}`, alt: i.alt, caption: i.caption, relevance: 'helpful' }));
  const { images } = await renderImages(settings, specs, { min: 0, max: 2, accept: ['essential', 'helpful', 'decorative'] }, () => {});
  if (!images.length) throw new Error('No picture could be rendered.');
  await deleteImages(story.images);
  return one<Story>('UPDATE stories SET images = $2 WHERE id = $1 RETURNING *', [storyId, JSON.stringify(images)]);
}

/** Plans (or extends the plan of) a topic as a logged run, for the admin "Plan" button. */
export async function planRun(topicId: number, extend: boolean): Promise<Run> {
  const run = await one<Run>(`INSERT INTO runs (trigger, kind, topic_id, step) VALUES ('manual', 'plan', $1, 'planning') RETURNING *`, [topicId]);
  try {
    const settings = await one<Settings>('SELECT * FROM settings WHERE id = 1');
    const topic = await one<Topic>('SELECT * FROM topics WHERE id = $1', [topicId]);
    if (!topic) throw new Error('Topic not found.');
    const result = extend || topic.plan ? await extendPlan(settings, topic) : await ensurePlan(settings, topic);
    return await one<Run>(`UPDATE runs SET status = 'succeeded', step = 'done', detail = $2, usage = $3, finished_at = now() WHERE id = $1 RETURNING *`, [
      run.id,
      `${extend || topic.plan ? 'extended' : 'planned'} ${topic.name}`,
      JSON.stringify(result.usage),
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return await one<Run>(`UPDATE runs SET status = 'failed', error = $2, finished_at = now() WHERE id = $1 RETURNING *`, [run.id, message.slice(0, 2000)]);
  }
}
