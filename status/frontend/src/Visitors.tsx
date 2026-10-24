import { useState, type ReactNode } from 'react';
import { BarChart, LineChart, compact, full, type Point } from './charts';
import type { SiteAnalytics } from './types';

const SERIES = [
  { name: 'Visitors', color: 'var(--series-1)' },
  { name: 'Page views', color: 'var(--series-2)' },
];

const utc = (iso: string) => new Date(`${iso}T00:00:00Z`);
const dayLabel = (day: string) => utc(day).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const dayTitle = (day: string) => utc(day).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const monthLabel = (month: string) => utc(`${month}-01`).toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' });
const monthTitle = (month: string) => utc(`${month}-01`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** "+12%" against the previous period; "new" when there was nothing to compare with. */
function delta(current: number, previous: number) {
  if (!previous) return current ? { text: 'new', dir: 'up' } : undefined;
  const pct = Math.round(((current - previous) / previous) * 100);
  return { text: `${pct > 0 ? '+' : ''}${pct}%`, dir: pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat' };
}

/** The three numbers on a collapsed project block: visitors (with trend), page views, visitors today. */
export function HeadlineStats({ site, days, dim }: { site: SiteAnalytics; days: number; dim: boolean }) {
  const trend = delta(site.totals.visitors, site.totals.previousVisitors);
  const today = site.daily[site.daily.length - 1];
  return (
    <span className={`group-stats${dim ? ' dim' : ''}`} title={`Last ${days} days`}>
      <span className="gstat">
        <b>{compact(site.totals.visitors)}</b> visitors
        {trend && (
          <i className={`delta delta-${trend.dir}`} title={`compared with the ${days} days before`}>
            {trend.text}
          </i>
        )}
      </span>
      <span className="gstat">
        <b>{compact(site.totals.views)}</b> views
      </span>
      <span className="gstat">
        <b>{compact(today?.visitors ?? 0)}</b> today
      </span>
    </span>
  );
}

/** A chart with its accessible twin: the same numbers as a table, one click away. */
function ChartCard({ title, subtitle, table, children }: { title: string; subtitle: string; table: ReactNode; children: ReactNode }) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  return (
    <figure className="chart-card">
      <figcaption className="chart-head">
        <span>
          <strong>{title}</strong> <span className="muted">{subtitle}</span>
        </span>
        <span className="seg small" role="group" aria-label={`Show ${title} as`}>
          <button className={view === 'chart' ? 'on' : ''} aria-pressed={view === 'chart'} onClick={() => setView('chart')}>
            Chart
          </button>
          <button className={view === 'table' ? 'on' : ''} aria-pressed={view === 'table'} onClick={() => setView('table')}>
            Table
          </button>
        </span>
      </figcaption>
      {view === 'chart' ? children : table}
    </figure>
  );
}

function DataTable({ head, rows, mono = false }: { head: string[]; rows: (string | number)[][]; mono?: boolean }) {
  return (
    <div className="table-wrap">
      <table className="atable">
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={h} className={i ? 'num' : ''}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td key={j} className={typeof cell === 'number' ? 'num' : mono ? 'path' : ''} title={typeof cell === 'string' ? cell : undefined}>
                  {typeof cell === 'number' ? full(cell) : cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AnalyticsPanel({ site, days, timezone, dim }: { site: SiteAnalytics; days: number; timezone?: string; dim: boolean }) {
  const hasData = site.totals.views > 0 || site.monthly.some((m) => m.views > 0);
  if (!hasData) {
    return <p className="analytics-empty muted">No page views recorded yet. They show up here within a minute of the first visit to {site.domain}.</p>;
  }

  const daily: Point[] = site.daily.map((d) => ({ label: dayLabel(d.day), title: dayTitle(d.day), values: [d.visitors, d.views] }));
  const monthly: Point[] = site.monthly.map((m) => ({ label: monthLabel(m.month), title: monthTitle(m.month), values: [m.visitors] }));
  const deviceTotal = site.devices.reduce((sum, d) => sum + d.views, 0);

  return (
    <div className={`analytics${dim ? ' dim' : ''}`}>
      <div className="analytics-grid">
        <ChartCard
          title="Daily"
          subtitle={`last ${days} days`}
          table={<DataTable head={['Day', 'Visitors', 'Page views']} rows={site.daily.map((d) => [dayTitle(d.day), d.visitors, d.views])} />}
        >
          <LineChart points={daily} series={SERIES} label={`Visitors and page views per day for ${site.domain}, last ${days} days`} />
        </ChartCard>
        <ChartCard
          title="Monthly"
          subtitle="visitors, last 12 months"
          table={<DataTable head={['Month', 'Visitors', 'Page views']} rows={site.monthly.map((m) => [monthTitle(m.month), m.visitors, m.views])} />}
        >
          <BarChart points={monthly} name="Visitors" label={`Visitors per month for ${site.domain}, last 12 months`} />
        </ChartCard>
      </div>

      <div className="analytics-tables">
        <section className="list-card">
          <h3>
            Top pages <span className="muted">last {days} days</span>
          </h3>
          {site.pages.length ? (
            <DataTable head={['Path', 'Visitors', 'Views']} rows={site.pages.map((p) => [p.path, p.visitors, p.views])} mono />
          ) : (
            <p className="muted small">No page views in this period.</p>
          )}
        </section>
        <section className="list-card">
          <h3>Referrers</h3>
          {site.referrers.length ? (
            <DataTable head={['Site', 'Visitors']} rows={site.referrers.map((r) => [r.referrer, r.visitors])} mono />
          ) : (
            <p className="muted small">Only direct visits in this period.</p>
          )}
        </section>
        <section className="list-card">
          <h3>Devices</h3>
          {deviceTotal ? (
            <ul className="meters">
              {site.devices.map((d) => (
                <li key={d.device}>
                  <span className="meter-label">{d.device}</span>
                  <span className="meter">
                    <span className="meter-fill" style={{ width: `${(d.views / deviceTotal) * 100}%` }} />
                  </span>
                  <span className="meter-value">{Math.round((d.views / deviceTotal) * 100)}%</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">No page views in this period.</p>
          )}
        </section>
      </div>

      <p className="muted small analytics-note">
        Visitors are unique per day (the visitor hash changes daily), so monthly visitors add up the daily uniques. Days start at midnight{' '}
        {timezone ?? 'Europe/Amsterdam'}.
      </p>
    </div>
  );
}
