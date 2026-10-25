import { config, statusEnvFile } from '../config.js';
import { dbEnabled, query } from '../db.js';
import { fail, ok, warn, type CheckDef } from '../types.js';

/** Claude uploads screenshots of design changes with status/tools/upload-screenshot.mjs; that needs a shared token. */
export const screenshotsCheck: CheckDef = {
  id: 'status:screenshots',
  title: 'Screenshot uploads enabled',
  provider: 'Status',
  fix: {
    summary:
      'Claude posts screenshots of design changes to /api/screenshots with a bearer token. The deploy workflow copies the GitHub secret STATUS_SCREENSHOT_TOKEN to the server as SCREENSHOT_TOKEN.',
    steps: [
      { text: 'Use the token from the git-ignored file .env.screenshots in the repo root (or generate one):', code: 'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))"' },
      { text: 'Add it as repository secret STATUS_SCREENSHOT_TOKEN: GitHub → Settings → Secrets and variables → Actions.' },
      { text: 'Re-run the "Deploy status" workflow (Actions → Deploy status → Run workflow).' },
    ],
  },
  run: async () => {
    if (!dbEnabled()) return fail(`DATABASE_URL is not set in ${statusEnvFile}; screenshots are stored in the "status" database.`);
    if (!config.screenshotToken) return fail(`SCREENSHOT_TOKEN is not set in ${statusEnvFile}, so uploads are refused.`);
    const { rows } = await query<{ total: string; latest: Date | null }>('SELECT count(*) AS total, max(created_at) AS latest FROM screenshots');
    const { total, latest } = rows[0];
    if (total === '0') return warn('Uploads are enabled, but no screenshots have arrived yet.');
    return ok(`${total} screenshot(s) stored; latest ${latest!.toISOString().slice(0, 16).replace('T', ' ')} UTC.`);
  },
};
