export interface ArticleCard {
  id: number;
  slug: string;
  title: string;
  dek: string;
  tags: string[];
  hero_image: string | null;
  hero_alt: string | null;
  read_minutes: number;
  views: number;
  published_at: string;
  topic_name: string | null;
  topic_id: number | null;
}

export interface Chart {
  type: 'bar' | 'line' | 'area' | 'pie';
  title: string;
  unit: string;
  labels: string[];
  series: { name: string; values: number[] }[];
  note: string;
}

export interface Article extends ArticleCard {
  body_md: string;
  charts: Chart[];
  sources: { title: string; url: string }[];
  model: string | null;
  status: 'published' | 'hidden';
}

export interface Topic {
  id: number;
  name: string;
  description: string;
  weight: number;
  enabled: boolean;
  articles: number;
}

export interface Site {
  site_name: string;
  tagline: string;
  topics: Topic[];
}

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
  charts_enabled: boolean;
  web_search_enabled: boolean;
  language: string;
  tone: string;
  audience: string;
  target_words: number;
  extra_instructions: string;
  site_name: string;
  tagline: string;
  last_run_at: string | null;
}

export interface Run {
  id: number;
  trigger: 'schedule' | 'manual';
  status: 'running' | 'succeeded' | 'failed';
  step: string;
  topic_name: string | null;
  article_title: string | null;
  article_slug: string | null;
  error: string | null;
  usage: { input_tokens?: number; output_tokens?: number; images?: number };
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
  counts: { published: number; hidden: number; views: number };
  tokens: { input: number; output: number; images: number; failed_runs: number };
  recent_runs: Run[];
}

export interface AdminArticle {
  id: number;
  slug: string;
  title: string;
  dek: string;
  status: 'published' | 'hidden';
  views: number;
  read_minutes: number;
  hero_image: string | null;
  published_at: string;
  model: string | null;
  usage: { input_tokens?: number; output_tokens?: number; images?: number };
  charts: number;
  topic_name: string | null;
}
