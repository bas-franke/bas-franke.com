import { randomBytes } from 'node:crypto';
import { addUsage, emptyUsage, extendTopicPlan, planTopic, type Usage } from './ai.js';
import { one, query } from './db.js';
import type { Category, PlanSection, Settings, Topic, TopicKind, TopicPlan } from './types.js';

export const LIVE_SECTION = 'Latest';

export function slugify(text: string) {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export async function uniqueSlug(table: 'topics' | 'stories', text: string) {
  const base = slugify(text) || table.slice(0, -1);
  for (let i = 0; i < 50; i++) {
    const slug = i === 0 ? base : `${base}-${i + 1}`;
    if (!(await one(`SELECT 1 FROM ${table} WHERE slug = $1`, [slug]))) return slug;
  }
  return `${base}-${randomBytes(3).toString('hex')}`;
}

/** Every plan ends with the automatic "Latest" section where "right now" stories land. */
export function withLiveSection(plan: TopicPlan): TopicPlan {
  const sections = plan.sections.filter((s) => !s.live);
  sections.push({ name: LIVE_SECTION, blurb: 'What is happening right now, explained.', items: [], live: true });
  return { intro: plan.intro, sections };
}

export async function createTopic(input: { name: string; description?: string; category?: Category; kind?: TopicKind; weight?: number }) {
  const name = input.name.trim().slice(0, 60);
  if (!name) throw new Error('Topic name is required.');
  const existing = await one<Topic>('SELECT * FROM topics WHERE lower(name) = lower($1)', [name]);
  if (existing) return existing;
  return one<Topic>(
    `INSERT INTO topics (slug, name, description, category, kind, weight) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [await uniqueSlug('topics', name), name, input.description?.trim() ?? '', input.category ?? 'world', input.kind ?? 'field', input.weight ?? 5],
  );
}

export async function savePlan(topicId: number, plan: TopicPlan) {
  return one<Topic>(`UPDATE topics SET plan = $2, planned_at = now(), updated_at = now() WHERE id = $1 RETURNING *`, [topicId, JSON.stringify(withLiveSection(plan))]);
}

/** Returns the topic with a plan, generating one when it has none yet. */
export async function ensurePlan(settings: Settings, topic: Topic, onStep?: (step: string) => void): Promise<{ topic: Topic; usage: Usage }> {
  const usage = emptyUsage();
  if (topic.plan?.sections?.length) return { topic, usage };
  onStep?.('planning the topic');
  const planned = await planTopic(settings, topic);
  addUsage(usage, planned.usage);
  return { topic: await savePlan(topic.id, planned.plan), usage };
}

/** Extends an exhausted plan with new sections and items. */
export async function extendPlan(settings: Settings, topic: Topic): Promise<{ topic: Topic; usage: Usage }> {
  const base = topic.plan?.sections?.length ? topic.plan : (await planTopic(settings, topic)).plan;
  const { rows } = await query<{ title: string }>('SELECT title FROM stories WHERE topic_id = $1 ORDER BY published_at DESC LIMIT 80', [topic.id]);
  const extended = await extendTopicPlan(settings, topic, withLiveSection(base), rows.map((r) => r.title));
  return { topic: await savePlan(topic.id, extended.plan), usage: extended.usage };
}

export interface NextItem {
  section_index: number;
  plan_index: number;
  section: PlanSection;
  title: string;
  brief: string;
}

/** (section_index, plan_index) pairs that already have a story. */
async function writtenPositions(topicId: number) {
  const { rows } = await query<{ section_index: number; plan_index: number }>('SELECT section_index, plan_index FROM stories WHERE topic_id = $1 AND kind = $2', [topicId, 'planned']);
  return new Set(rows.map((r) => `${r.section_index}:${r.plan_index}`));
}

/** The first curriculum item without a story, in plan order; null when the plan is exhausted. */
export async function nextPlanItem(topic: Topic): Promise<NextItem | null> {
  if (!topic.plan) return null;
  const written = await writtenPositions(topic.id);
  for (const [si, section] of topic.plan.sections.entries()) {
    if (section.live) continue;
    for (const [pi, item] of section.items.entries()) {
      if (!written.has(`${si}:${pi}`)) return { section_index: si, plan_index: pi, section, title: item.title, brief: item.brief };
    }
  }
  return null;
}

/** How many planned items exist and how many have a story, for the admin and the hub progress. */
export async function planProgress(topic: Topic) {
  const planned = topic.plan?.sections.filter((s) => !s.live).reduce((n, s) => n + s.items.length, 0) ?? 0;
  const written = topic.plan ? (await writtenPositions(topic.id)).size : 0;
  return { planned, written: Math.min(written, planned) };
}

/** Resolves a section name the writer returned to its index; unknown names go to the live section. */
export function resolveSection(plan: TopicPlan, name: string) {
  const wanted = name.trim().toLowerCase();
  let index = plan.sections.findIndex((s) => s.name.toLowerCase() === wanted);
  if (index === -1) index = plan.sections.findIndex((s) => s.live);
  if (index === -1) index = plan.sections.length - 1;
  return { index, section: plan.sections[index] };
}

/** Topics with unwritten items first, weighted by weight and favouring topics with fewer stories. */
export async function pickTopic(topicId?: number): Promise<Topic> {
  if (topicId) {
    const topic = await one<Topic>('SELECT * FROM topics WHERE id = $1', [topicId]);
    if (!topic) throw new Error(`Topic ${topicId} does not exist.`);
    return topic;
  }
  const { rows } = await query<Topic & { stories: string }>(
    `SELECT t.*, count(s.id) AS stories FROM topics t LEFT JOIN stories s ON s.topic_id = t.id
     WHERE t.enabled AND t.weight > 0 GROUP BY t.id`,
  );
  if (!rows.length) throw new Error('No enabled topics. Add or enable a topic in the admin.');
  const weighted = rows.map((t) => ({ t, w: t.weight / (1 + Number(t.stories) / 4) }));
  let r = Math.random() * weighted.reduce((s, x) => s + x.w, 0);
  for (const { t, w } of weighted) {
    r -= w;
    if (r <= 0) return t;
  }
  return weighted[weighted.length - 1].t;
}
