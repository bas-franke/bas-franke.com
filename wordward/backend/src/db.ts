import pg from 'pg';
import { config } from './config.js';
import { migrations } from './migrations.js';

let pool: pg.Pool | undefined;

export const dbConfigured = () => Boolean(config.databaseUrl);

export function db() {
  if (!pool) {
    if (!config.databaseUrl) throw new Error('DATABASE_URL is not set');
    // RDS uses TLS with Amazon's CA, which Node does not bundle; verify-full would need the CA file.
    const url = new URL(config.databaseUrl);
    const ssl = url.searchParams.get('sslmode') === 'disable' ? undefined : { rejectUnauthorized: false };
    url.searchParams.delete('sslmode');
    pool = new pg.Pool({ connectionString: url.toString(), ssl, max: 5, connectionTimeoutMillis: 5000 });
    pool.on('error', (err) => console.error('pg pool error', err));
  }
  return pool;
}

export const query = <T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []) =>
  db().query<T>(text, params);

export async function one<T extends pg.QueryResultRow>(text: string, params: unknown[] = []) {
  const { rows } = await query<T>(text, params);
  return rows[0];
}

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

/** True when the database answers; used by /api/health. */
export async function dbReady() {
  if (!config.databaseUrl) return false;
  try {
    await query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
