export type Category = 'technology' | 'science' | 'money' | 'world' | 'society';
export type TopicKind = 'field' | 'event';
export type StoryKind = 'planned' | 'trending';

export interface StoryImage {
  file: string;
  alt: string;
  caption: string;
}

export interface Source {
  title: string;
  url: string;
}

/** A story as it appears in lists and "go deeper" links. */
export interface CompactStory {
  slug: string;
  title: string;
  hook: string;
  read_seconds: number;
  kind: StoryKind;
  difficulty: number;
  topic_slug: string;
  topic_name: string;
  same_topic?: boolean;
}

export interface FeedTopic {
  id: number;
  slug: string;
  name: string;
  category: Category;
  kind: TopicKind;
  /** Published stories in the topic. */
  stories: number;
}

export interface Story {
  id: number;
  slug: string;
  title: string;
  hook: string;
  body_md: string;
  takeaway: string;
  kind: StoryKind;
  why_now: string | null;
  section_index: number;
  plan_index: number;
  section_name: string;
  difficulty: number;
  tags: string[];
  images: StoryImage[];
  sources: Source[];
  read_seconds: number;
  views: number;
  published_at: string;
  topic: FeedTopic;
  /** 0-based position on the topic's path. */
  position: number;
  related: CompactStory[];
}

export interface FeedPage {
  stories: Story[];
  has_more: boolean;
  has_before: boolean;
  topic: { slug: string; name: string; category: Category; kind: TopicKind } | null;
}

export interface Site {
  site_name: string;
  tagline: string;
  interval_minutes: number;
  next_story_at: string | null;
  stories: number;
  topics: number;
}

export interface TopicSummary {
  id: number;
  slug: string;
  name: string;
  description: string;
  category: Category;
  kind: TopicKind;
  intro: string | null;
  stories: number;
  updated_at: string | null;
  latest: { slug: string; title: string; hook: string } | null;
  first_slug: string | null;
}

export interface HubSection {
  index: number;
  name: string;
  blurb: string;
  live: boolean;
  planned: string[];
}

export interface HubStory {
  slug: string;
  title: string;
  hook: string;
  kind: StoryKind;
  why_now: string | null;
  section_index: number;
  plan_index: number;
  section_name: string;
  difficulty: number;
  read_seconds: number;
  views: number;
  published_at: string;
  image: string | null;
}

export interface Hub {
  topic: { id: number; slug: string; name: string; description: string; category: Category; kind: TopicKind; intro: string; created_at: string };
  sections: HubSection[];
  stories: HubStory[];
}

/* ---------- admin ---------- */

export interface Settings {
  enabled: boolean;
  interval_minutes: number;
  max_per_day: number;
  active_hours_start: number | null;
  active_hours_end: number | null;
  timezone: string;
  text_model: string;
  image_model: string;
  image_quality: 'low' | 'medium' | 'high';
  images_enabled: boolean;
  images_max: number;
  web_search_enabled: boolean;
  language: string;
  tone: string;
  audience: string;
  target_words: number;
  extra_instructions: string;
  trending_share: number;
  trending_guidance: string;
  site_name: string;
  tagline: string;
  last_run_at: string | null;
}

export interface AdminTopic {
  id: number;
  slug: string;
  name: string;
  description: string;
  category: Category;
  kind: TopicKind;
  weight: number;
  enabled: boolean;
  planned_at: string | null;
  stories: number;
  sections: number;
  planned: number;
  written: number;
}

export interface Run {
  id: number;
  trigger: 'schedule' | 'manual';
  status: 'running' | 'succeeded' | 'failed';
  step: string;
  kind: StoryKind | 'plan';
  detail: string | null;
  topic_name: string | null;
  story_title: string | null;
  story_slug: string | null;
  error: string | null;
  usage: { input_tokens?: number; output_tokens?: number; images?: number; searches?: number };
  started_at: string;
  finished_at: string | null;
}

export interface Overview {
  settings: Settings;
  generating: boolean;
  next_run_at: string | null;
  published_24h: number;
  blockers: string[];
  env: { database: boolean; openai: boolean; admin_password: boolean; data_dir: string };
  counts: { published: number; hidden: number; views: number; topics: number };
  tokens: { input: number; output: number; images: number; searches: number; failed_runs: number };
  cost: { total_usd: number; last_24h_usd: number; per_story_usd: number };
  recent_runs: Run[];
}

export interface AdminStory {
  id: number;
  slug: string;
  title: string;
  hook: string;
  status: 'published' | 'hidden';
  views: number;
  read_seconds: number;
  kind: StoryKind;
  why_now: string | null;
  section_name: string;
  published_at: string;
  model: string | null;
  usage: { input_tokens?: number; output_tokens?: number; images?: number };
  images: number;
  image: string | null;
  topic_name: string;
  topic_slug: string;
}

export const CATEGORY_LABEL: Record<Category, string> = {
  world: 'World',
  money: 'Money',
  technology: 'Technology',
  science: 'Science',
  society: 'Society',
};

export const CATEGORY_ORDER: Category[] = ['world', 'money', 'technology', 'science', 'society'];
