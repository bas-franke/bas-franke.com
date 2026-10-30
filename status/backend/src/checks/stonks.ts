import { repoDoc } from '../config.js';
import { fail, ok, warn, type CheckDef, type Fix, type Project } from '../types.js';

interface BotHealth {
  status?: string;
  database?: boolean;
  lastError?: boolean;
  bot?: { enabled?: boolean; mode?: string };
  tick?: { ageSec?: number | null; ok?: boolean };
}

/**
 * The trading bot runs inside the backend, so "the API answers" says nothing about it: its loop can hang or fail
 * every tick while /api/health stays 200. This check is also how a bot that went silent gets noticed: the bot can
 * mail about what it sees itself (bot/alerts.ts), not about having stopped.
 */
export function stonksBotCheck(project: Project): CheckDef {
  const url = `https://${project.domains[0]}/api/health`;
  const fix: Fix = {
    summary: 'The trading bot is not ticking, or its last tick failed. Open orders and stops are not being looked after.',
    steps: [
      { text: `Open https://${project.domains[0]} and read the Logs page: "tick_failed" says why ticks fail.` },
      { text: 'On the server, check the process and its recent errors:', code: `pm2 status ${project.name}\npm2 logs ${project.name} --lines 100 --nostream` },
      { text: 'If the loop is stuck with no errors, restart it (the bot picks up its open orders again at start):', code: `pm2 restart ${project.name}` },
      { text: 'Check Bitvavo open orders by hand if the bot was down while it held a position with a stop.' },
    ],
    doc: repoDoc(`${project.name}/SPEC.md`),
  };
  return {
    id: `bot:${project.name}`,
    title: 'Trading bot is ticking',
    provider: 'Server',
    fix,
    run: async () => {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      const body = (await res.json().catch(() => null)) as BotHealth | null;
      if (!body) return fail(`${url} → HTTP ${res.status} with no JSON.`);
      if (body.database === false) {
        return fail(`The bot has no database (HTTP ${res.status}).`, {
          summary: 'The backend cannot reach its database, so the bot cannot trade or keep state.',
          steps: [{ text: 'Fix the database check for this project first.' }],
        });
      }
      if (body.tick === undefined) return warn('/api/health has no tick information yet: is the newest backend deployed?');
      const age = body.tick.ageSec === null || body.tick.ageSec === undefined ? 'no tick yet' : `last tick ${body.tick.ageSec} s ago`;
      if (body.status === 'degraded' || (body.bot?.enabled && !body.tick.ok)) {
        return fail(`${age}${body.lastError ? ', and it failed' : ''} (${body.bot?.enabled ? `${body.bot.mode} mode` : 'bot off'}).`);
      }
      return ok(body.bot?.enabled ? `Running in ${body.bot.mode} mode, ${age}.` : `The bot is switched off; ${age}.`);
    },
  };
}
