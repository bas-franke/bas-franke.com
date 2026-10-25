import pg from 'pg';
import { referrerChannelSql } from './channel.js';
import { config } from './config.js';

let pool: pg.Pool | undefined;

export const dbEnabled = () => Boolean(config.databaseUrl);

export function db() {
  if (!pool) {
    if (!config.databaseUrl) throw new Error('DATABASE_URL is not set');
    // RDS uses TLS with Amazon's CA, which Node does not bundle; verify-full would need the CA file.
    const url = new URL(config.databaseUrl);
    const ssl = url.searchParams.get('sslmode') === 'disable' ? undefined : { rejectUnauthorized: false };
    url.searchParams.delete('sslmode');
    pool = new pg.Pool({ connectionString: url.toString(), ssl, max: 4, connectionTimeoutMillis: 5000 });
    pool.on('error', (err) => console.error('pg pool error', err));
  }
  return pool;
}

export const query = <T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []) =>
  db().query<T>(text, params);

/** Applied in order at startup. Never edit an applied migration; add a new one. */
const migrations: { name: string; sql: string }[] = [
  {
    name: '001_page_views',
    sql: `
      CREATE TABLE page_views (
        id        bigserial PRIMARY KEY,
        ts        timestamptz NOT NULL DEFAULT now(),
        site      text NOT NULL,
        path      text NOT NULL,
        visitor   text NOT NULL,
        referrer  text,
        device    text NOT NULL DEFAULT 'desktop'
      );
      CREATE INDEX page_views_site_ts ON page_views (site, ts);
    `,
  },
  {
    // Richer analytics. Rows from before this migration keep NULL in the new columns (the reports treat that as
    // unknown), except the channel, which follows from the referrer. view_id lets the engagement pings (sent when a
    // page view ends) find their page view.
    name: '002_page_view_details',
    sql: `
      ALTER TABLE page_views
        ADD COLUMN view_id    text,
        ADD COLUMN engaged_ms int,
        ADD COLUMN country    text,
        ADD COLUMN lang       text,
        ADD COLUMN browser    text,
        ADD COLUMN os         text,
        ADD COLUMN channel    text,
        ADD COLUMN campaign   text;
      CREATE INDEX page_views_view_id ON page_views (view_id) WHERE view_id IS NOT NULL;
      UPDATE page_views SET channel = ${referrerChannelSql('referrer')};
    `,
  },
  {
    // Screenshots of design changes (see screenshots.ts); only the newest 20 per project are kept.
    name: '003_screenshots',
    sql: `
      CREATE TABLE screenshots (
        id           bigserial PRIMARY KEY,
        created_at   timestamptz NOT NULL DEFAULT now(),
        project      text NOT NULL,
        title        text NOT NULL,
        note         text,
        source       text,
        content_type text NOT NULL,
        width        int,
        height       int,
        bytes        int NOT NULL,
        image        bytea NOT NULL
      );
      CREATE INDEX screenshots_project_created ON screenshots (project, created_at DESC);
    `,
  },
  {
    // Change history: commits that touched each project's folder, copied from GitHub by changes.ts.
    name: '004_changes',
    sql: `
      CREATE TABLE changes (
        project      text NOT NULL,
        sha          text NOT NULL,
        summary      text NOT NULL,
        body         text NOT NULL DEFAULT '',
        author       text NOT NULL,
        committed_at timestamptz NOT NULL,
        url          text NOT NULL,
        stored_at    timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (project, sha)
      );
      CREATE INDEX changes_project_committed ON changes (project, committed_at DESC);
    `,
  },
];

export async function migrate() {
  const client = await db().connect();
  try {
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const { rows } = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.name));
    for (const m of migrations) {
      if (applied.has(m.name)) continue;
      console.log(`applying migration ${m.name}`);
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [m.name]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    client.release();
  }
}
