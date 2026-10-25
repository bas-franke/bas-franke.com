import Art from './Art';
import { FixBlock } from './ui';
import type { CheckGroup, CheckResult, CheckStatus, Report } from './types';

export const LABEL: Record<CheckStatus, string> = { ok: 'OK', warn: 'Warning', fail: 'Action needed', skip: 'Skipped' };

export const HEADLINE: Record<CheckStatus, string> = {
  ok: 'All systems operational',
  warn: 'Running, with a few warnings',
  fail: 'Some things need your attention',
  skip: 'Nothing to check yet',
};

const PROVIDER_ART: Record<string, string> = {
  'name.com': 'provider-dns',
  AWS: 'provider-aws',
  GitHub: 'provider-github',
  Server: 'provider-server',
  "Let's Encrypt": 'provider-tls',
  Status: 'provider-status',
};

export function worst(checks: CheckResult[]): CheckStatus {
  if (checks.some((c) => c.status === 'fail')) return 'fail';
  if (checks.some((c) => c.status === 'warn')) return 'warn';
  if (checks.every((c) => c.status === 'skip')) return 'skip';
  return 'ok';
}

export function groupHealth(group: CheckGroup) {
  const counted = group.checks.filter((c) => c.status !== 'skip');
  return { status: worst(group.checks), passing: counted.filter((c) => c.status === 'ok').length, counted: counted.length };
}

export function overallHealth(report: Report) {
  const checks = report.groups.flatMap((g) => g.checks);
  const counted = checks.filter((c) => c.status !== 'skip').length;
  return { status: worst(checks), passing: report.summary.ok, counted };
}

/** "5/6 passing" pill in the colour of the worst check. */
export function HealthPill({ group }: { group: CheckGroup }) {
  const h = groupHealth(group);
  return (
    <span className={`count-pill tag-${h.status}`} title={LABEL[h.status]}>
      <span className={`dot dot-${h.status}`} aria-hidden="true" />
      {h.passing}/{h.counted} passing
    </span>
  );
}

/** Failing and warning checks first, so the things to fix are on top. */
const ORDER: Record<CheckStatus, number> = { fail: 0, warn: 1, ok: 2, skip: 3 };

export function CheckList({ checks }: { checks: CheckResult[] }) {
  return (
    <ul className="checks">
      {[...checks]
        .sort((a, b) => ORDER[a.status] - ORDER[b.status])
        .map((c) => (
          <Check key={c.id} check={c} />
        ))}
    </ul>
  );
}

function Check({ check }: { check: CheckResult }) {
  return (
    <li className={`check check-${check.status}`}>
      <span className={`dot dot-${check.status}`} title={LABEL[check.status]} />
      <div className="check-body">
        <div className="check-row">
          <span className="check-title">{check.title}</span>
          <span className="sr-only">{LABEL[check.status]}</span>
          <span className="provider">
            <Art name={PROVIDER_ART[check.provider] ?? 'provider-status'} className="provider-icon" />
            {check.provider}
          </span>
        </div>
        <p className="detail mono">{check.detail}</p>
        {check.fix && <FixBlock fix={check.fix} open={check.status === 'fail'} />}
      </div>
    </li>
  );
}
