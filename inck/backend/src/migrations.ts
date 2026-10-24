/**
 * Schema migrations, applied in order at startup (see db.ts). Never edit an applied
 * migration; add a new one.
 */
export const migrations: { name: string; sql: string }[] = [
  {
    name: '001_init',
    sql: `
      CREATE TABLE settings (
        id                  int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        enabled             boolean NOT NULL DEFAULT true,
        interval_minutes    int NOT NULL DEFAULT 60 CHECK (interval_minutes >= 5),
        max_per_day         int NOT NULL DEFAULT 24 CHECK (max_per_day >= 1),
        active_hours_start  int CHECK (active_hours_start BETWEEN 0 AND 23),
        active_hours_end    int CHECK (active_hours_end BETWEEN 0 AND 23),
        timezone            text NOT NULL DEFAULT 'Europe/Amsterdam',
        text_model          text NOT NULL DEFAULT 'gpt-5-mini',
        image_model         text NOT NULL DEFAULT 'gpt-image-1',
        image_quality       text NOT NULL DEFAULT 'medium' CHECK (image_quality IN ('low','medium','high')),
        images_enabled      boolean NOT NULL DEFAULT true,
        charts_enabled      boolean NOT NULL DEFAULT true,
        web_search_enabled  boolean NOT NULL DEFAULT true,
        language            text NOT NULL DEFAULT 'English',
        tone                text NOT NULL DEFAULT 'curious, witty and clear',
        audience            text NOT NULL DEFAULT 'smart, curious general readers',
        target_words        int NOT NULL DEFAULT 900 CHECK (target_words BETWEEN 200 AND 4000),
        extra_instructions  text NOT NULL DEFAULT '',
        site_name           text NOT NULL DEFAULT 'inck',
        tagline             text NOT NULL DEFAULT 'Interesting things, written while you sleep.',
        last_run_at         timestamptz,
        updated_at          timestamptz NOT NULL DEFAULT now()
      );
      INSERT INTO settings (id) VALUES (1);

      CREATE TABLE topics (
        id          serial PRIMARY KEY,
        name        text NOT NULL UNIQUE,
        description text NOT NULL DEFAULT '',
        weight      int NOT NULL DEFAULT 1 CHECK (weight BETWEEN 0 AND 10),
        enabled     boolean NOT NULL DEFAULT true,
        created_at  timestamptz NOT NULL DEFAULT now()
      );
      INSERT INTO topics (name, description) VALUES
        ('Space & astronomy', 'Missions, discoveries, the strange physics of the universe'),
        ('Computing & AI', 'How software, hardware and machine learning actually work; history and surprising ideas'),
        ('Weird history', 'Forgotten events, odd inventions and people history books skip'),
        ('Biology & nature', 'Animal behaviour, evolution, ecosystems, the human body'),
        ('Mathematics', 'Elegant proofs, puzzles, numbers that show up everywhere'),
        ('Economics & money', 'Markets, incentives and why prices do what they do'),
        ('Design & architecture', 'Why things look and work the way they do'),
        ('Future tech', 'Energy, materials, transport and what is realistically coming');

      CREATE TABLE articles (
        id            serial PRIMARY KEY,
        slug          text NOT NULL UNIQUE,
        title         text NOT NULL,
        dek           text NOT NULL DEFAULT '',
        body_md       text NOT NULL,
        topic_id      int REFERENCES topics(id) ON DELETE SET NULL,
        tags          text[] NOT NULL DEFAULT '{}',
        hero_image    text,
        hero_alt      text,
        image_prompt  text,
        charts        jsonb NOT NULL DEFAULT '[]',
        sources       jsonb NOT NULL DEFAULT '[]',
        model         text,
        usage         jsonb NOT NULL DEFAULT '{}',
        read_minutes  int NOT NULL DEFAULT 4,
        views         int NOT NULL DEFAULT 0,
        status        text NOT NULL DEFAULT 'published' CHECK (status IN ('published','hidden')),
        published_at  timestamptz NOT NULL DEFAULT now(),
        created_at    timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX articles_published_idx ON articles (status, published_at DESC);
      CREATE INDEX articles_topic_idx ON articles (topic_id);

      CREATE TABLE runs (
        id          serial PRIMARY KEY,
        trigger     text NOT NULL CHECK (trigger IN ('schedule','manual')),
        status      text NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','failed')),
        step        text NOT NULL DEFAULT 'starting',
        topic_id    int REFERENCES topics(id) ON DELETE SET NULL,
        article_id  int REFERENCES articles(id) ON DELETE SET NULL,
        error       text,
        usage       jsonb NOT NULL DEFAULT '{}',
        started_at  timestamptz NOT NULL DEFAULT now(),
        finished_at timestamptz
      );
      CREATE INDEX runs_started_idx ON runs (started_at DESC);
    `,
  },
  {
    // gpt-image-1 is no longer offered to new accounts; move to its successor unless the model was changed by hand.
    name: '002_image_model_gpt_image_2',
    sql: `
      ALTER TABLE settings ALTER COLUMN image_model SET DEFAULT 'gpt-image-2';
      UPDATE settings SET image_model = 'gpt-image-2' WHERE image_model = 'gpt-image-1';
    `,
  },
  {
    // Several illustrations per article, and the newest cheap text model.
    name: '003_multi_image',
    sql: `
      ALTER TABLE articles ADD COLUMN images jsonb NOT NULL DEFAULT '[]';
      UPDATE articles SET images = jsonb_build_array(jsonb_build_object(
        'file', hero_image, 'alt', coalesce(hero_alt, ''), 'caption', '', 'prompt', coalesce(image_prompt, '')))
      WHERE hero_image IS NOT NULL;

      ALTER TABLE settings
        ADD COLUMN images_min int NOT NULL DEFAULT 2 CHECK (images_min BETWEEN 1 AND 8),
        ADD COLUMN images_max int NOT NULL DEFAULT 6 CHECK (images_max BETWEEN 1 AND 8);
      ALTER TABLE settings ALTER COLUMN text_model SET DEFAULT 'gpt-5.4-mini';
      UPDATE settings SET text_model = 'gpt-5.4-mini' WHERE text_model = 'gpt-5-mini';
    `,
  },
];
