import { statusEnvFile } from '../config.js';
import { dbEnabled, query } from '../db.js';
import { projects } from '../projects.js';
import { fail, ok, warn, type CheckDef } from '../types.js';
import { databaseFix } from './database.js';

const statusProject = projects.find((p) => p.name === 'status')!;

/** The collector only keeps page views when the status backend has its database. */
export const analyticsCheck: CheckDef = {
  id: 'status:analytics',
  title: 'Visitor analytics storing page views',
  provider: 'Status',
  fix: {
    ...databaseFix(statusProject),
    summary: 'Every site posts its page views to the status backend, which needs the "status" database to keep them.',
  },
  run: async () => {
    if (!dbEnabled()) return fail(`DATABASE_URL is not set in ${statusEnvFile}, so page views are dropped.`);
    const { rows } = await query<{ total: string; day: string; sites: string }>(
      `SELECT count(*) AS total, count(*) FILTER (WHERE ts > now() - interval '24 hours') AS day, count(DISTINCT site) AS sites FROM page_views`,
    );
    const { total, day, sites } = rows[0];
    if (total === '0') {
      return warn('The database is ready, but no page views have arrived yet. Deploy the frontends; their tracking snippet posts to /api/page.');
    }
    return ok(`${Number(day).toLocaleString('en')} page views in the last 24 h; ${Number(total).toLocaleString('en')} stored from ${sites} site(s).`);
  },
};
