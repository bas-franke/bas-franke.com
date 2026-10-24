import pg from 'pg';
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
