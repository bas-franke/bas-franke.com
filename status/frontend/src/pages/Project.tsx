import { useEffect, useRef } from 'react';
import Art from '../Art';
import { usePoll, type Polled } from '../api';
import { LABEL, groupHealth } from '../health';
import { Link, projectPath, type Tab } from '../router';
import { AnalyticsSetup, RangePicker, Skeleton, StateCard } from '../ui';
import { domainOf } from './Overview';
import Kpis from '../sections/Kpis';
import Traffic from '../sections/Traffic';
import Sources from '../sections/Sources';
import Locations from '../sections/Locations';
import Pages from '../sections/Pages';
import { TimeOnPage, WhenPeopleVisit } from '../sections/Engagement';
import Technology from '../sections/Technology';
import Monthly from '../sections/Monthly';
import Health from '../sections/Health';
import Changes from '../sections/Changes';
import { rangeText } from '../format';
import type { Report, SiteReport } from '../types';

export default function Project({ site, tab, status, days }: { site: string; tab: Tab; status: Polled<Report>; days: number }) {
  const isShared = site === 'shared';
  const url = isShared ? null : `/api/analytics/${encodeURIComponent(site)}?days=${days}`;
  const analytics = usePoll<SiteReport>(url, 'analytics API');
  const group = status.data?.groups.find((g) => g.id === site);
  const data = analytics.data;
  const title = group?.title ?? site;
  const domain = data?.domain ?? domainOf(group);
  const shownTab: Tab = isShared ? 'health' : tab;
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    document.title = `${title} · Status`;
  }, [title]);

  // Move focus to the page heading on arrival, so keyboard and screen-reader users start at the top.
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, [site]);

  const unknown = status.data && !group && (isShared || (!data && analytics.error));
  if (unknown) {
    return (
      <>
        <BackLink />
        <StateCard art="state-warn" title={`No project called “${site}”`}>
          <p className="muted">
            It isn't in the status checks or the analytics. <Link to="/">See all projects</Link>.
          </p>
        </StateCard>
      </>
    );
  }

  const health = group && groupHealth(group);

  return (
    <>
      <BackLink />
      <header className="project-head">
        <div className="ph-main">
          <div className="ph-title">
            <span className="group-icon group-icon-lg">
              <Art name={`group-${site}`} fallback="group-default" />
            </span>
            <div className="ph-name">
              <h1 ref={heading} tabIndex={-1}>
                {title}
              </h1>
              {domain && !isShared ? (
                <a className="ph-domain mono" href={`https://${domain}`} target="_blank" rel="noreferrer">
                  {domain} <span aria-hidden="true">↗</span>
                </a>
              ) : (
                <span className="ph-domain mono muted">{group?.subtitle}</span>
              )}
            </div>
          </div>
          <div className="ph-meta">
            {data && (
              <span className={`live${data.live ? '' : ' live-idle'}`} title="Visitors in the last 5 minutes">
                <span className="pulse" /> {data.live} live now
              </span>
            )}
            {health && group && (
              <Link to={projectPath(site, 'health')} className={`count-pill tag-${health.status} health-badge`} title={LABEL[health.status]}>
                <span className={`dot dot-${health.status}`} aria-hidden="true" />
                {health.passing}/{health.counted} checks passing
              </Link>
            )}
          </div>
        </div>
        <Art name={isShared ? 'group-shared' : `hero-${site}`} fallback={isShared ? undefined : 'hero-default'} className="ph-art" />
      </header>

      <div className="ph-bar">
        {!isShared ? (
          <nav className="tabs" aria-label={`${title} sections`}>
            <Link to={projectPath(site)} className="tab" aria-current={shownTab === 'analytics' ? 'page' : undefined}>
              Analytics
            </Link>
            <Link to={projectPath(site, 'health')} className="tab" aria-current={shownTab === 'health' ? 'page' : undefined}>
              Health
              {health && health.status !== 'ok' && health.status !== 'skip' && <span className={`dot dot-${health.status} tab-dot`} aria-label={LABEL[health.status]} />}
            </Link>
            <Link to={projectPath(site, 'changes')} className="tab" aria-current={shownTab === 'changes' ? 'page' : undefined}>
              Changes
            </Link>
          </nav>
        ) : (
          <span />
        )}
        {shownTab === 'analytics' && <RangePicker days={days} />}
      </div>

      {shownTab === 'analytics' ? (
        <AnalyticsView analytics={analytics} url={url} days={days} domain={domain ?? site} />
      ) : shownTab === 'changes' ? (
        <Changes site={site} />
      ) : (
        <Health group={group} status={status} />
      )}
    </>
  );
}

function BackLink() {
  return (
    <Link to="/" className="back-link">
      <span aria-hidden="true">←</span> All projects
    </Link>
  );
}

function AnalyticsView({ analytics, url, days, domain }: { analytics: Polled<SiteReport>; url: string | null; days: number; domain: string }) {
  const data = analytics.data;

  if (!data && analytics.error) {
    return (
      <StateCard art="state-offline" title="Can't load the analytics">
        <p className="muted">{analytics.error}</p>
        <p>
          <button type="button" className="btn" onClick={() => analytics.reload()}>
            Try again
          </button>
        </p>
      </StateCard>
    );
  }
  if (!data) return <AnalyticsSkeleton />;
  if (!data.enabled) return <AnalyticsSetup detail={data.detail} fix={data.fix} />;

  const hasAny = data.totals.views > 0 || data.monthly.some((m) => m.views > 0) || data.live > 0;
  if (!hasAny) {
    return (
      <StateCard art="empty-analytics" title="No visitors yet">
        <p className="muted">
          Page views show up here within a minute of the first visit to{' '}
          <a href={`https://${domain}`} target="_blank" rel="noreferrer">
            {domain}
          </a>
          .
        </p>
        <p className="muted small">Visits from localhost and automated browsers are never counted.</p>
      </StateCard>
    );
  }

  const dim = analytics.loading && analytics.dataUrl !== url;
  return (
    <div className={`analytics${dim ? ' dim' : ''}`} aria-busy={dim}>
      {analytics.error && <p className="muted small">Showing earlier numbers; the last refresh failed: {analytics.error}</p>}
      <Kpis data={data} days={days} />
      {data.totals.views === 0 && (
        <p className="notice">
          No page views in the {rangeText(days)}. Pick a longer range above, or see the months further down.
        </p>
      )}
      <Traffic data={data} days={days} />
      <div className="grid-2">
        <Sources data={data} days={days} />
        <Locations data={data} days={days} />
      </div>
      <Pages data={data} days={days} />
      <div className="grid-2">
        <TimeOnPage data={data} days={days} />
        <WhenPeopleVisit data={data} days={days} />
      </div>
      <Technology data={data} days={days} />
      <Monthly data={data} />
      <p className="muted small analytics-note">
        Visitors are unique per day (the visitor hash changes daily), so a “visit” is one visitor on one day and longer ranges add up the daily
        uniques. Days and hours are in {data.timezone}. Countries come from the browser's time zone, so VPNs and travel can blur them.
      </p>
    </div>
  );
}

function AnalyticsSkeleton() {
  return (
    <div className="analytics" aria-busy="true" aria-label="Loading analytics">
      <div className="kpis">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div className="kpi" key={i}>
            <Skeleton width="60%" height={12} />
            <Skeleton width="80%" height={28} />
          </div>
        ))}
      </div>
      <div className="panel">
        <Skeleton width={160} height={18} />
        <Skeleton height={190} />
      </div>
      <div className="grid-2">
        <div className="panel">
          <Skeleton width={120} height={18} />
          <Skeleton height={200} />
        </div>
        <div className="panel">
          <Skeleton width={120} height={18} />
          <Skeleton height={200} />
        </div>
      </div>
    </div>
  );
}
