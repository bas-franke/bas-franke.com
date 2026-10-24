import { config } from './config.js';
import { allGroups } from './checks/index.js';
import type { CheckDef, CheckResult, CheckStatus, Outcome, Report } from './types.js';
import { errorMessage } from './util.js';

async function runCheck(check: CheckDef): Promise<CheckResult> {
  const started = Date.now();
  let outcome: Outcome;
  let timer: NodeJS.Timeout | undefined;
  try {
    outcome = await Promise.race([
      check.run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Check timed out')), config.checkTimeoutMs);
      }),
    ]);
  } catch (err) {
    outcome = { status: 'fail', detail: errorMessage(err) };
  } finally {
    clearTimeout(timer);
  }
  return {
    id: check.id,
    title: check.title,
    provider: check.provider,
    status: outcome.status,
    detail: outcome.detail,
    fix: outcome.status === 'ok' ? undefined : (outcome.fix ?? check.fix),
    durationMs: Date.now() - started,
  };
}

export async function runAll(): Promise<Report> {
  const started = Date.now();
  const groups = await Promise.all(
    allGroups().map(async (g) => ({
      id: g.id,
      title: g.title,
      subtitle: g.subtitle,
      checks: await Promise.all(g.checks.map(runCheck)),
    })),
  );

  const summary: Record<CheckStatus, number> = { ok: 0, warn: 0, fail: 0, skip: 0 };
  for (const g of groups) for (const c of g.checks) summary[c.status]++;

  return { generatedAt: new Date().toISOString(), durationMs: Date.now() - started, summary, groups };
}
