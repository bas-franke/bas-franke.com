export type Category = 'technology' | 'science' | 'money' | 'world' | 'society';
export const CATEGORIES: Category[] = ['technology', 'science', 'money', 'world', 'society'];

/** A field is a lasting subject (AI, quantum computing); an event is something happening in the world (a war, a crash). */
export type TopicKind = 'field' | 'event';

export interface PlanItem {
  /** The one idea a story makes click, phrased as a title. */
  title: string;
  /** One sentence on what the story must explain. */
  brief: string;
}

export interface PlanSection {
  name: string;
  blurb: string;
  items: PlanItem[];
  /** The automatic "Latest" section: "right now" stories land here, nothing is planned for it. */
  live?: boolean;
}

/** The curriculum of a topic, generated once and extended when every item has been written. */
export interface TopicPlan {
  intro: string;
  sections: PlanSection[];
}

export interface Settings {
  id: 1;
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
  /** 0–2: the writer may ask for up to this many pictures, and only when they help. */
  images_max: number;
  web_search_enabled: boolean;
  language: string;
  tone: string;
  audience: string;
  /** Target length of a story body in words. */
  target_words: number;
  extra_instructions: string;
  /** Percentage of stories that follow what is happening in the world right now. */
  trending_share: number;
  /** Extra rules for the trend scout. */
  trending_guidance: string;
  site_name: string;
  tagline: string;
  last_run_at: Date | null;
  updated_at: Date;
}

export interface Topic {
  id: number;
  slug: string;
  name: string;
  description: string;
  category: Category;
  kind: TopicKind;
  weight: number;
  enabled: boolean;
  plan: TopicPlan | null;
  planned_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** planned: a curriculum item of its topic; trending: picked by the scout from what is happening now. */
export type StoryKind = 'planned' | 'trending';

export interface StoryImage {
  file: string;
  alt: string;
  caption: string;
  prompt: string;
}

export interface Source {
  title: string;
  url: string;
}

export interface Story {
  id: number;
  slug: string;
  topic_id: number;
  title: string;
  hook: string;
  body_md: string;
  takeaway: string;
  kind: StoryKind;
  /** Trending stories: one sentence on why the subject is in the air today. */
  why_now: string | null;
  /** Position in the topic's curriculum: section, then item within the section (trending items sort after planned ones). */
  section_index: number;
  plan_index: number;
  section_name: string;
  /** The plan item this story fulfilled (its title), null for trending stories. */
  plan_item: string | null;
  /** 1 = anyone, 2 = everyday knowledge helps, 3 = a detail inside the topic. Every story is still standalone. */
  difficulty: number;
  tags: string[];
  images: StoryImage[];
  sources: Source[];
  model: string | null;
  usage: Record<string, number>;
  read_seconds: number;
  views: number;
  status: 'published' | 'hidden';
  published_at: Date;
  created_at: Date;
}

export type RunKind = StoryKind | 'plan';

export interface Run {
  id: number;
  trigger: 'schedule' | 'manual';
  status: 'running' | 'succeeded' | 'failed';
  step: string;
  kind: RunKind;
  /** Trending runs: the subject the scout picked; planned runs: the plan item. */
  detail: string | null;
  topic_id: number | null;
  story_id: number | null;
  error: string | null;
  usage: Record<string, number>;
  started_at: Date;
  finished_at: Date | null;
}
