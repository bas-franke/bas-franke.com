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
  /** Quality of the cover image (shown on cards and above the article). */
  image_quality: 'low' | 'medium' | 'high';
  /** Quality of inline figures; "low" is about a ninth of the price of "medium" and still looks good. */
  figure_quality: 'low' | 'medium' | 'high';
  images_enabled: boolean;
  images_min: number;
  images_max: number;
  charts_enabled: boolean;
  web_search_enabled: boolean;
  language: string;
  tone: string;
  audience: string;
  target_words: number;
  extra_instructions: string;
  /** Percentage of articles that should be "right now" pieces about what is interesting today. */
  trending_share: number;
  /** Extra rules for the trend scout (what counts as lightweight). */
  trending_guidance: string;
  site_name: string;
  tagline: string;
  last_run_at: Date | null;
  updated_at: Date;
}

export interface Topic {
  id: number;
  name: string;
  description: string;
  weight: number;
  enabled: boolean;
  /** The one system topic that holds "right now" pieces; never picked for evergreen articles. */
  is_trending: boolean;
  created_at: Date;
}

export type ArticleKind = 'evergreen' | 'trending';

export interface ArticleImage {
  file: string;
  alt: string;
  caption: string;
  prompt: string;
}

export interface Article {
  id: number;
  slug: string;
  title: string;
  dek: string;
  body_md: string;
  topic_id: number | null;
  kind: ArticleKind;
  /** For trending pieces: one sentence on why the subject is in the air today. */
  why_now: string | null;
  tags: string[];
  hero_image: string | null;
  hero_alt: string | null;
  image_prompt: string | null;
  /** All illustrations; images[0] is the cover (also mirrored in hero_image for lists). */
  images: ArticleImage[];
  charts: unknown[];
  sources: unknown[];
  model: string | null;
  usage: Record<string, number>;
  read_minutes: number;
  views: number;
  status: 'published' | 'hidden';
  published_at: Date;
  created_at: Date;
}

export interface Run {
  id: number;
  trigger: 'schedule' | 'manual';
  status: 'running' | 'succeeded' | 'failed';
  step: string;
  kind: ArticleKind;
  /** Trending runs: the subject the scout picked. */
  detail: string | null;
  topic_id: number | null;
  article_id: number | null;
  error: string | null;
  usage: Record<string, number>;
  started_at: Date;
  finished_at: Date | null;
}
