import type pg from 'pg';
import { cleanLine, completeDates, stripCitations, tidyBody } from './text.js';
import type { TopicPlan } from './types.js';

/**
 * Schema migrations, applied in order at startup (see db.ts). Never edit an applied
 * migration; add a new one. A migration runs its `sql`, then its `run` function (data fixes), in one transaction.
 */
export const migrations: { name: string; sql?: string; run?: (client: pg.PoolClient) => Promise<void> }[] = [
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
  {
    // gpt-5.4-nano writes 1,200-word, well-structured articles at the lowest price, so it is the default.
    name: '004_text_model_nano',
    sql: `
      ALTER TABLE settings ALTER COLUMN text_model SET DEFAULT 'gpt-5.4-nano';
      UPDATE settings SET text_model = 'gpt-5.4-nano' WHERE text_model IN ('gpt-5-mini', 'gpt-5.4-mini');
    `,
  },
  {
    // Inline figures at low quality cost ~1/9 of medium with gpt-image-2 and still look good; the cover stays medium.
    name: '005_figure_quality',
    sql: `
      ALTER TABLE settings ADD COLUMN figure_quality text NOT NULL DEFAULT 'low' CHECK (figure_quality IN ('low','medium','high'));
    `,
  },
  {
    // "Right now" pieces: half the articles follow what is interesting today instead of an evergreen topic.
    name: '006_trending',
    sql: `
      ALTER TABLE topics ADD COLUMN is_trending boolean NOT NULL DEFAULT false;
      INSERT INTO topics (name, description, weight, enabled, is_trending)
        VALUES ('Right now', 'What people are curious about today: discoveries, launches, records, odd market moves, internet moments. Lightweight only.', 0, true, true);

      ALTER TABLE articles
        ADD COLUMN kind text NOT NULL DEFAULT 'evergreen' CHECK (kind IN ('evergreen','trending')),
        ADD COLUMN why_now text;
      ALTER TABLE runs
        ADD COLUMN kind text NOT NULL DEFAULT 'evergreen' CHECK (kind IN ('evergreen','trending')),
        ADD COLUMN detail text;

      ALTER TABLE settings
        ADD COLUMN trending_share int NOT NULL DEFAULT 50 CHECK (trending_share BETWEEN 0 AND 100),
        ADD COLUMN trending_guidance text NOT NULL DEFAULT 'Think "what would a curious friend send me today?": a new discovery, a space launch, a record, a surprising market move, a viral maths puzzle, a product everyone is suddenly talking about. If in doubt whether something is too heavy, skip it.';
    `,
  },
  {
    // inck becomes a learning feed: very short standalone stories, organised in topics with a generated curriculum.
    // The long-form articles are deleted on purpose (their image files are swept at startup, see index.ts).
    name: '007_stories',
    sql: `
      DROP TABLE IF EXISTS runs;
      DROP TABLE IF EXISTS articles;
      DROP TABLE IF EXISTS topics;

      ALTER TABLE settings
        DROP COLUMN IF EXISTS figure_quality,
        DROP COLUMN IF EXISTS images_min,
        DROP COLUMN IF EXISTS charts_enabled;
      ALTER TABLE settings DROP CONSTRAINT IF EXISTS settings_target_words_check;
      ALTER TABLE settings DROP CONSTRAINT IF EXISTS settings_images_max_check;
      -- The row must satisfy the new ranges before the constraints are added.
      UPDATE settings SET target_words = 200, images_max = 2;
      ALTER TABLE settings
        ADD CONSTRAINT settings_target_words_check CHECK (target_words BETWEEN 80 AND 600),
        ADD CONSTRAINT settings_images_max_check CHECK (images_max BETWEEN 0 AND 2);
      ALTER TABLE settings
        ALTER COLUMN interval_minutes SET DEFAULT 15,
        ALTER COLUMN max_per_day SET DEFAULT 96,
        ALTER COLUMN text_model SET DEFAULT 'gpt-5.4-mini',
        ALTER COLUMN image_quality SET DEFAULT 'low',
        ALTER COLUMN images_max SET DEFAULT 2,
        ALTER COLUMN target_words SET DEFAULT 200,
        ALTER COLUMN tone SET DEFAULT 'vivid, warm and precise, like a friend who is great at explaining things',
        ALTER COLUMN audience SET DEFAULT 'curious people of any background, with no prior knowledge of the topic',
        ALTER COLUMN tagline SET DEFAULT 'Big ideas, one short story at a time.',
        ALTER COLUMN trending_share SET DEFAULT 40,
        ALTER COLUMN trending_guidance SET DEFAULT 'Prefer what many people are trying to understand today: a conflict, a market move, a political moment, a scientific result, a technology everyone suddenly uses. Explain the history behind it, not just the headline. Skip celebrity gossip, individual crime cases, sports results and unverified rumours.';
      UPDATE settings SET
        interval_minutes = 15,
        max_per_day = 96,
        text_model = CASE WHEN text_model IN ('gpt-5-mini', 'gpt-5.4-nano') THEN 'gpt-5.4-mini' ELSE text_model END,
        image_quality = 'low',
        images_max = 2,
        target_words = 200,
        tone = 'vivid, warm and precise, like a friend who is great at explaining things',
        audience = 'curious people of any background, with no prior knowledge of the topic',
        tagline = CASE WHEN tagline = 'Interesting things, written while you sleep.' THEN 'Big ideas, one short story at a time.' ELSE tagline END,
        trending_share = 40,
        trending_guidance = 'Prefer what many people are trying to understand today: a conflict, a market move, a political moment, a scientific result, a technology everyone suddenly uses. Explain the history behind it, not just the headline. Skip celebrity gossip, individual crime cases, sports results and unverified rumours.',
        last_run_at = NULL,
        updated_at = now();

      CREATE TABLE topics (
        id          serial PRIMARY KEY,
        slug        text NOT NULL UNIQUE,
        name        text NOT NULL UNIQUE,
        description text NOT NULL DEFAULT '',
        category    text NOT NULL DEFAULT 'technology' CHECK (category IN ('technology','science','money','world','society')),
        kind        text NOT NULL DEFAULT 'field' CHECK (kind IN ('field','event')),
        weight      int NOT NULL DEFAULT 5 CHECK (weight BETWEEN 0 AND 10),
        enabled     boolean NOT NULL DEFAULT true,
        plan        jsonb,
        planned_at  timestamptz,
        created_at  timestamptz NOT NULL DEFAULT now(),
        updated_at  timestamptz NOT NULL DEFAULT now()
      );
      INSERT INTO topics (slug, name, description, category, kind) VALUES
        ('artificial-intelligence', 'Artificial intelligence', 'How machines learn, what today''s AI can and cannot do, and why it changes work, science and power.', 'technology', 'field'),
        ('quantum-computing', 'Quantum computing', 'Computers built on the strange rules of the very small: qubits, superposition, and what they might one day crack.', 'technology', 'field'),
        ('crypto-and-blockchain', 'Crypto & blockchain', 'Bitcoin, mining, wallets and blockchains: how digital money works without a bank, and why it is so volatile.', 'technology', 'field'),
        ('semiconductors-and-chips', 'Semiconductors & chips', 'The tiny switches inside every device, how they are made, and why a few factories matter to the whole world.', 'technology', 'field'),
        ('how-the-internet-works', 'How the internet works', 'What actually happens between tapping a link and a page appearing: cables, addresses, servers and encryption.', 'technology', 'field'),
        ('genetics-and-biotech', 'Genetics & biotech', 'DNA, genes, gene editing and the biotech behind modern medicine, explained from scratch.', 'science', 'field'),
        ('climate-and-energy', 'Climate & energy', 'Why the planet is warming, how energy is made and moved, and what the options really cost.', 'science', 'field'),
        ('space-exploration', 'Space exploration', 'Rockets, orbits, probes and the plans to live beyond Earth.', 'science', 'field'),
        ('nuclear-power-and-weapons', 'Nuclear power & weapons', 'Splitting atoms for electricity and for bombs: the physics, the risks and the politics.', 'science', 'field'),
        ('stock-markets-and-crashes', 'Stock markets & crashes', 'What a share is, how prices move, and the anatomy of bubbles and crashes past and present.', 'money', 'field'),
        ('inflation-and-central-banks', 'Inflation & central banks', 'Why prices rise, what interest rates do, and how central banks steer an economy.', 'money', 'field'),
        ('global-trade-and-supply-chains', 'Global trade & supply chains', 'Tariffs, shipping, sanctions and the fragile chains that put products on shelves.', 'money', 'field'),
        ('the-war-in-ukraine', 'The war in Ukraine', 'The largest war in Europe since 1945: how it started, who is involved, and what it changes for the world.', 'world', 'event');

      CREATE TABLE stories (
        id            serial PRIMARY KEY,
        slug          text NOT NULL UNIQUE,
        topic_id      int NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
        title         text NOT NULL,
        hook          text NOT NULL DEFAULT '',
        body_md       text NOT NULL,
        takeaway      text NOT NULL DEFAULT '',
        kind          text NOT NULL DEFAULT 'planned' CHECK (kind IN ('planned','trending')),
        why_now       text,
        section_index int NOT NULL DEFAULT 0,
        plan_index    int NOT NULL DEFAULT 0,
        section_name  text NOT NULL DEFAULT '',
        plan_item     text,
        difficulty    int NOT NULL DEFAULT 1 CHECK (difficulty BETWEEN 1 AND 3),
        tags          text[] NOT NULL DEFAULT '{}',
        images        jsonb NOT NULL DEFAULT '[]',
        sources       jsonb NOT NULL DEFAULT '[]',
        model         text,
        usage         jsonb NOT NULL DEFAULT '{}',
        read_seconds  int NOT NULL DEFAULT 60,
        views         int NOT NULL DEFAULT 0,
        status        text NOT NULL DEFAULT 'published' CHECK (status IN ('published','hidden')),
        published_at  timestamptz NOT NULL DEFAULT now(),
        created_at    timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX stories_feed_idx ON stories (status, published_at DESC, id DESC);
      CREATE INDEX stories_path_idx ON stories (topic_id, section_index, plan_index, published_at, id);

      CREATE TABLE runs (
        id          serial PRIMARY KEY,
        trigger     text NOT NULL CHECK (trigger IN ('schedule','manual')),
        status      text NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','failed')),
        step        text NOT NULL DEFAULT 'starting',
        kind        text NOT NULL DEFAULT 'planned' CHECK (kind IN ('planned','trending','plan')),
        detail      text,
        topic_id    int REFERENCES topics(id) ON DELETE SET NULL,
        story_id    int REFERENCES stories(id) ON DELETE SET NULL,
        error       text,
        usage       jsonb NOT NULL DEFAULT '{}',
        started_at  timestamptz NOT NULL DEFAULT now(),
        finished_at timestamptz
      );
      CREATE INDEX runs_started_idx ON runs (started_at DESC);
    `,
  },
  {
    // The trend radar: the model discovers what the world is talking about, creates topics for it and scores them
    // with a "heat"; hot topics get more stories and a prominent place on the site.
    name: '008_trend_radar',
    sql: `
      ALTER TABLE topics
        ADD COLUMN heat        int NOT NULL DEFAULT 0 CHECK (heat BETWEEN 0 AND 5),
        ADD COLUMN heat_reason text NOT NULL DEFAULT '',
        ADD COLUMN heat_at     timestamptz;
      CREATE INDEX topics_heat_idx ON topics (heat DESC) WHERE heat > 0;

      ALTER TABLE settings
        ADD COLUMN radar_hours int NOT NULL DEFAULT 3 CHECK (radar_hours BETWEEN 1 AND 48),
        ADD COLUMN radar_at    timestamptz;
      ALTER TABLE settings ALTER COLUMN trending_share SET DEFAULT 60;
      UPDATE settings SET trending_share = 60 WHERE trending_share = 40;

      ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_kind_check;
      ALTER TABLE runs ADD CONSTRAINT runs_kind_check CHECK (kind IN ('planned','trending','plan','radar'));
    `,
  },
  {
    // Web search left inline citations ("([site.com](https://…))") in intros, reasons and stories written before the
    // text was cleaned at generation time. Strip them from what is already stored.
    name: '009_strip_citations',
    run: async (client) => {
      const { rows: topics } = await client.query<{ id: number; description: string; heat_reason: string; plan: TopicPlan | null }>(
        'SELECT id, description, heat_reason, plan FROM topics',
      );
      for (const t of topics) {
        const plan = t.plan && {
          intro: stripCitations(t.plan.intro ?? ''),
          sections: (t.plan.sections ?? []).map((s) => ({
            ...s,
            name: cleanLine(s.name, 40),
            blurb: cleanLine(s.blurb),
            items: (s.items ?? []).map((i) => ({ title: cleanLine(i.title, 90), brief: cleanLine(i.brief) })),
          })),
        };
        await client.query('UPDATE topics SET description = $2, heat_reason = $3, plan = $4 WHERE id = $1', [
          t.id,
          cleanLine(t.description),
          cleanLine(t.heat_reason),
          plan ? JSON.stringify(plan) : null,
        ]);
      }
      const { rows: stories } = await client.query<{ id: number; title: string; hook: string; takeaway: string; body_md: string; section_name: string; plan_item: string | null }>(
        'SELECT id, title, hook, takeaway, body_md, section_name, plan_item FROM stories',
      );
      for (const s of stories) {
        await client.query('UPDATE stories SET title = $2, hook = $3, takeaway = $4, body_md = $5, section_name = $6, plan_item = $7 WHERE id = $1', [
          s.id,
          cleanLine(s.title, 90) || s.title,
          cleanLine(s.hook, 200),
          cleanLine(s.takeaway, 300),
          tidyBody(s.body_md) || s.body_md,
          cleanLine(s.section_name, 40),
          s.plan_item === null ? null : cleanLine(s.plan_item, 90),
        ]);
      }
    },
  },
  {
    // Country-specific news: a topic can belong to one country (its national politics, strikes, budget) and is then
    // only offered in the feed to visitors from there. NULL keeps a topic global, which also covers news from one
    // country that the whole world follows. A story every 5 minutes, so the daily cap moves up with it.
    name: '010_country_news',
    sql: `
      ALTER TABLE topics ADD COLUMN country text CHECK (country ~ '^[A-Z]{2}$');
      CREATE INDEX topics_country_idx ON topics (country) WHERE country IS NOT NULL;

      ALTER TABLE settings ADD COLUMN local_countries text[] NOT NULL DEFAULT '{NL,US,GB,DE}';
      ALTER TABLE settings
        ALTER COLUMN interval_minutes SET DEFAULT 5,
        ALTER COLUMN max_per_day SET DEFAULT 288;
      UPDATE settings SET interval_minutes = 5, max_per_day = greatest(max_per_day, 288), updated_at = now();
    `,
  },
  {
    name: '010_hourly',
    sql: `
      ALTER TABLE settings ALTER COLUMN interval_minutes SET DEFAULT 60;
      UPDATE settings SET interval_minutes = 60;
    `,
  },
  {
    // Stories written before the writer knew the date: "Saturday, 24 October" gets its year (worked out from when the
    // story was published), and bare-domain or cut-off citations such as "(investing.com)" are removed.
    name: '011_complete_dates',
    run: async (client) => {
      const { rows: stories } = await client.query<{ id: number; hook: string; takeaway: string; body_md: string; why_now: string | null; published_at: Date }>(
        'SELECT id, hook, takeaway, body_md, why_now, published_at FROM stories',
      );
      for (const s of stories) {
        await client.query('UPDATE stories SET hook = $2, takeaway = $3, body_md = $4, why_now = $5 WHERE id = $1', [
          s.id,
          completeDates(cleanLine(s.hook, 200), s.published_at),
          completeDates(cleanLine(s.takeaway, 300), s.published_at),
          tidyBody(s.body_md, s.published_at) || s.body_md,
          s.why_now === null ? null : completeDates(cleanLine(s.why_now, 300), s.published_at),
        ]);
      }
      const { rows: topics } = await client.query<{ id: number; heat_reason: string; heat_at: Date | null }>('SELECT id, heat_reason, heat_at FROM topics');
      for (const t of topics) {
        await client.query('UPDATE topics SET heat_reason = $2 WHERE id = $1', [t.id, completeDates(cleanLine(t.heat_reason), t.heat_at ?? new Date())]);
      }
    },
  },
  {
    // The writing rules were tuned on gpt-6-luna; planning, the radar and the scout use the same model.
    name: '012_gpt6_luna',
    sql: `
      ALTER TABLE settings ALTER COLUMN text_model SET DEFAULT 'gpt-6-luna';
      UPDATE settings SET text_model = 'gpt-6-luna', updated_at = now();
    `,
  },
  {
    // Each story remembers which version of the writing prompt wrote it; a story written with an older one is
    // rewritten in the background (oldest text first, one every rewrite_minutes). Stories before this were version 1.
    name: '013_prompt_version',
    sql: `
      ALTER TABLE stories ADD COLUMN prompt_version int NOT NULL DEFAULT 1, ADD COLUMN rewritten_at timestamptz;
      CREATE INDEX stories_rewrite_idx ON stories (prompt_version, (coalesce(rewritten_at, created_at)));
      ALTER TABLE settings ADD COLUMN rewrite_minutes int NOT NULL DEFAULT 10 CHECK (rewrite_minutes >= 0),
                           ADD COLUMN last_rewrite_at timestamptz;
      ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_kind_check;
      ALTER TABLE runs ADD CONSTRAINT runs_kind_check CHECK (kind IN ('planned','trending','plan','radar','rewrite'));
    `,
  },
];
