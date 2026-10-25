import { statusEnvFile } from '../config.js';
import { lastSync } from '../changes.js';
import { dbEnabled, query } from '../db.js';
import { projects } from '../projects.js';
import { fail, ok, warn, type CheckDef } from '../types.js';
import { databaseFix } from './database.js';

const statusProject = projects.find((p) => p.name === 'status')!;

/** The change history is copied from GitHub into the "status" database every 10 minutes. */
export const changesCheck: CheckDef = {
  id: 'status:changes',
  title: 'Change history syncing',
  provider: 'Status',
  fix: {
    ...databaseFix(statusProject),
    summary: 'The status backend copies every project\'s commits from GitHub into the "status" database; it needs that database.',
  },
  run: async () => {
    if (!dbEnabled()) return fail(`DATABASE_URL is not set in ${statusEnvFile}, so no change history is stored.`);
    const failed = projects.map((p) => [p.name, lastSync(p.name)?.error] as const).filter(([, e]) => e);
    if (failed.length) {
      return warn(`Last sync failed for ${failed.map(([n]) => n).join(', ')}: ${failed[0][1]} The stored history is still shown.`);
    }
    const { rows } = await query<{ total: string; projects: string }>('SELECT count(*) AS total, count(DISTINCT project) AS projects FROM changes');
    const { total, projects: stored } = rows[0];
    if (total === '0') return warn('The database is ready, but no changes are stored yet; the first sync runs at startup.');
    return ok(`${Number(total).toLocaleString('en')} changes stored for ${stored} project(s).`);
  },
};
