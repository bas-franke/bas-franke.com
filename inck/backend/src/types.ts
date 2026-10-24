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
  images_min: number;
  images_max: number;
  charts_enabled: boolean;
  web_search_enabled: boolean;
  language: string;
  tone: string;
  audience: string;
  target_words: number;
  extra_instructions: string;
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
  created_at: Date;
}

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
  topic_id: number | null;
  article_id: number | null;
  error: string | null;
  usage: Record<string, number>;
  started_at: Date;
  finished_at: Date | null;
}
