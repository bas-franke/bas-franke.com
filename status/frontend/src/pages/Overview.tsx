import { useEffect } from 'react';
import Art from '../Art';
import { usePoll, useTicker, type Polled } from '../api';
import { compact, delta, duration, full, previousText, rangeText, timeAgo } from '../format';
import { LatestChange } from '../sections/Changes';
import { HEADLINE, HealthPill, LABEL, groupHealth, overallHealth } from '../health';
import { Link, projectPath } from '../router';
import { AnalyticsSetup, DeltaPill, RangePicker, Skeleton, StateCard } from '../ui';
import type { AnalyticsReport, Change, CheckGroup, LatestChanges, Report, SiteSummary } from '../types';

/** First domain from a group subtitle like "inck.ai, www.inck.ai · port 3003 · database". */
export const domainOf = (group?: CheckGroup) => group?.subtitle?.split(' · ')[0].split(', ')[0];

export default function Overview({ status, days }: { status: Polled<Report>; days: number }) {
  const url = `/api/analytics?days=${days}`;
  const analytics = usePoll<AnalyticsReport>(url, 'analytics API');
  const changes = usePoll<LatestChanges>('/api/changes', 'changes API');

  useEffect(() => {
    document.title = 'Status · bas-franke.com';
  }, []);

  const report = status.data;
  const sites = new Map((analytics.data?.sites ?? []).map((s) => [s.site, s]));
  const groups = new Map((report?.groups ?? []).map((g) => [g.id, g]));
  const names = [...new Set([...groups.keys(), ...sites.keys()])].filter((n) => n !== 'shared');
  // Most recently changed first; projects without a known change fall back to visitors, then name.
  const changedAt = (n: string) => Date.parse(changes.data?.sites[n]?.latest?.date ?? '') || 0;
  names.sort(
    (a, b) =>
      changedAt(b) - changedAt(a) ||
      (sites.get(b)?.totals.visitors ?? -1) - (sites.get(a)?.totals.visitors ?? -1) ||
      a.localeCompare(b),
  );
  const dim = analytics.loading && analytics.dataUrl !== url;
  const waiting = !names.length && (status.loading || analytics.loading);
  const all = [...sites.values()];
  const sum = (f: (s: SiteSummary) => number) => all.reduce((n, s) => n + f(s), 0);
  const shared = groups.get('shared');

  return (
    <>
      <HealthStrip status={status} />

      <div className="section-row">
        <div>
          <h2 className="section-title">Projects</h2>
          {all.length > 0 && (
            <p className="muted small section-sub">
              {full(sum((s) => s.totals.visitors))} visitors · {full(sum((s) => s.totals.views))} page views · {rangeText(days)}
              {sum((s) => s.live) > 0 && <> · {sum((s) => s.live)} live now</>}
            </p>
          )}
        </div>
        <RangePicker days={days} />
      </div>

      {analytics.data && !analytics.data.enabled && <AnalyticsSetup detail={analytics.data.detail} fix={analytics.data.fix} />}
      {analytics.error && !analytics.data && <p className="muted small">Visitor numbers are unavailable: {analytics.error}</p>}

      <div className={`project-grid${dim ? ' dim' : ''}`} aria-busy={dim || waiting}>
        {waiting
          ? [0, 1, 2, 3].map((i) => <CardSkeleton key={i} />)
          : names.map((name) => (
              <ProjectCard
                key={name}
                name={name}
                group={groups.get(name)}
                site={sites.get(name)}
                days={days}
                analyticsPending={!analytics.data && !analytics.error}
                change={changes.data?.sites[name]?.latest}
                changePending={!changes.data && !changes.error}
              />
            ))}
      </div>

      {shared && <SharedCard group={shared} />}
    </>
  );
}

function HealthStrip({ status }: { status: Polled<Report> }) {
  useTicker();
  const report = status.data;

  if (!report && status.error) {
    return (
      <StateCard art="state-offline" title="Can't reach the status API" compact>
        <p className="muted">{status.error}</p>
        <p className="muted small">
          If this persists, the status backend is down. On the server run <code>pm2 logs status --lines 50</code>.
        </p>
      </StateCard>
    );
  }

  if (!report) {
    return (
      <section className="health-strip strip-loading" aria-busy="true">
        <Art name="state-loading" className="strip-art" />
        <div className="strip-text">
          <span className="status-tag tag-skip">
            <span className="pulse" /> Checking
          </span>
          <h1>Running checks…</h1>
          <p className="muted">Pinging DNS, certificates, servers and deploys.</p>
        </div>
      </section>
    );
  }

  const h = overallHealth(report);
  const pct = h.counted ? Math.round((h.passing / h.counted) * 100) : 100;
  return (
    <section className={`health-strip strip-${h.status}`}>
      <Art name="overview-hero" fallback={`state-${h.status === 'skip' ? 'ok' : h.status}`} className="strip-art" />
      <div className="strip-text">
        <span className={`status-tag tag-${h.status}`}>
          <span className="pulse" /> {LABEL[h.status]}
        </span>
        <h1>{HEADLINE[h.status]}</h1>
        <p className="muted">
          <strong className="strip-count">
            {h.passing} of {h.counted}
          </strong>{' '}
          checks passing · checked {timeAgo(report.generatedAt)} in {(report.durationMs / 1000).toFixed(1)}s
          {status.error && <span className="strip-error"> · last refresh failed</span>}
        </p>
        <div className="progress" role="img" aria-label={`${pct}% of checks passing`}>
          <span className={`progress-bar bar-${h.status}`} style={{ width: `${pct}%` }} />
        </div>
      </div>
      <button type="button" className="btn strip-btn" onClick={() => status.reload('refresh=1')} disabled={status.loading}>
        <span className={status.loading ? 'spin' : ''} aria-hidden="true">
          ↻
        </span>{' '}
        {status.loading ? 'Checking…' : 'Check now'}
      </button>
    </section>
  );
}

function ProjectCard({
  name,
  group,
  site,
  days,
  analyticsPending,
  change,
  changePending,
}: {
  name: string;
  group?: CheckGroup;
  site?: SiteSummary;
  days: number;
  analyticsPending: boolean;
  change?: Change | null;
  changePending: boolean;
}) {
  const domain = site?.domain ?? domainOf(group) ?? name;
  const t = site?.totals;
  const trend = t && delta(t.visitors, t.previous.visitors);
  const timeTrend = t && delta(t.avgEngagedMs, t.previous.avgEngagedMs);
  return (
    <Link to={projectPath(name)} className="pcard" aria-label={`${group?.title ?? name}: open analytics`}>
      <div className="pcard-head">
        <span className="group-icon">
          <Art name={`group-${name}`} fallback="group-default" />
        </span>
        <span className="pcard-title">
          <h3>{group?.title ?? name}</h3>
          <span className="mono muted small">{domain}</span>
        </span>
        {site && site.live > 0 && (
          <span className="live" title="Visitors in the last 5 minutes">
            <span className="pulse" /> {site.live} live
          </span>
        )}
      </div>

      {t ? (
        <div className="pcard-stats">
          <div className="kv kv-main">
            <span className="kv-label">Visitors</span>
            <span className="kv-value">
              {compact(t.visitors)} <DeltaPill delta={trend} title={`Compared with ${previousText(days)}`} />
            </span>
          </div>
          <div className="kv">
            <span className="kv-label">Views</span>
            <span className="kv-value">{compact(t.views)}</span>
          </div>
          <div className="kv">
            <span className="kv-label">Avg time</span>
            <span className="kv-value" title={timeTrend ? `${timeTrend.text} vs ${previousText(days)}` : undefined}>
              {duration(t.avgEngagedMs)}
            </span>
          </div>
        </div>
      ) : analyticsPending ? (
        <div className="pcard-stats">
          <Skeleton height={34} />
          <Skeleton height={34} />
          <Skeleton height={34} />
        </div>
      ) : (
        <p className="muted small pcard-none">No visitor numbers for this project.</p>
      )}

      <div className="pcard-change-cell">
        <LatestChange change={change} pending={changePending} />
      </div>

      <div className="pcard-foot">
        {group ? <HealthPill group={group} /> : <span />}
        <span className="pcard-go" aria-hidden="true">
          Analytics →
        </span>
      </div>
    </Link>
  );
}

function SharedCard({ group }: { group: CheckGroup }) {
  const h = groupHealth(group);
  const problems = group.checks.filter((c) => c.status === 'fail' || c.status === 'warn');
  return (
    <Link to={projectPath('shared', 'health')} className={`shared-card shared-${h.status}`}>
      <span className="group-icon">
        <Art name="group-shared" fallback="group-default" />
      </span>
      <span className="shared-text">
        <strong>{group.title}</strong>
        <span className="muted small">
          {problems.length
            ? problems
                .slice(0, 3)
                .map((c) => c.title)
                .join(' · ') + (problems.length > 3 ? ` · +${problems.length - 3} more` : '')
            : group.subtitle}
        </span>
      </span>
      <HealthPill group={group} />
      <span className="chevron" aria-hidden="true">
        ›
      </span>
    </Link>
  );
}

function CardSkeleton() {
  return (
    <div className="pcard pcard-skeleton" aria-hidden="true">
      <div className="pcard-head">
        <Skeleton width={44} height={44} />
        <span className="pcard-title">
          <Skeleton width="50%" height={16} />
          <Skeleton width="70%" height={12} />
        </span>
      </div>
      <Skeleton height={40} />
      <Skeleton height={32} />
    </div>
  );
}
