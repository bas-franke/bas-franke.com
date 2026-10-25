import { BarChart, Heatmap, type Point } from '../charts';
import { duration, full, hourText, rangeText, WEEKDAYS } from '../format';
import { DataTable, Panel } from '../ui';
import type { SiteReport } from '../types';

const BUCKET_TITLE: Record<string, string> = {
  '<10s': 'Under 10 seconds',
  '10-30s': '10 to 30 seconds',
  '30s-1m': '30 seconds to 1 minute',
  '1-3m': '1 to 3 minutes',
  '3-10m': '3 to 10 minutes',
  '10m+': 'Over 10 minutes',
};

/** Histogram of page views by how long the page was visible. */
export function TimeOnPage({ data, days }: { data: SiteReport; days: number }) {
  const total = data.engagement.reduce((n, b) => n + b.views, 0);
  const points: Point[] = data.engagement.map((b) => ({ label: b.key, title: BUCKET_TITLE[b.key] ?? b.key, values: [b.views] }));
  const engaged = data.engagement.slice(2).reduce((n, b) => n + b.views, 0);

  return (
    <Panel
      icon="section-engagement"
      title="Time on page"
      subtitle={`avg ${duration(data.totals.avgEngagedMs)}`}
      table={
        <DataTable
          caption="Page views by time on page"
          head={['Time visible', 'Page views', 'Share']}
          rows={data.engagement.map((b) => [BUCKET_TITLE[b.key] ?? b.key, b.views, { text: total ? `${Math.round((b.views / total) * 100)}%` : '—', className: 'num' }])}
        />
      }
    >
      {total ? (
        <>
          <BarChart points={points} name="Page views" label={`Page views by visible time for ${data.domain}, ${rangeText(days)}`} />
          <p className="muted small panel-foot">
            {Math.round((engaged / total) * 100)}% of page views stayed visible for 30 seconds or more ({full(engaged)} of {full(total)}).
          </p>
        </>
      ) : (
        <p className="muted small empty-line">No engagement reported in this period. It is measured when a visitor leaves or hides the page.</p>
      )}
    </Panel>
  );
}

/** Weekday x hour heatmap of page views. */
export function WhenPeopleVisit({ data, days }: { data: SiteReport; days: number }) {
  const grid = data.heatmap.length === 7 ? data.heatmap : Array.from({ length: 7 }, (_, d) => data.heatmap[d] ?? Array(24).fill(0));
  const total = grid.flat().reduce((n, v) => n + v, 0);
  let peak = { d: 0, h: 0, v: -1 };
  grid.forEach((row, d) => row.forEach((v, h) => v > peak.v && (peak = { d, h, v })));

  return (
    <Panel
      icon="section-live"
      title="When people visit"
      subtitle={`page views, ${data.timezone}`}
      table={
        <DataTable
          caption="Page views per weekday"
          head={['Weekday', 'Page views', 'Busiest hour']}
          rows={grid.map((row, d) => {
            const max = Math.max(...row);
            return [WEEKDAYS[d], row.reduce((n, v) => n + v, 0), { text: max > 0 ? `${hourText(row.indexOf(max))} (${full(max)})` : '—', className: 'num' }];
          })}
        />
      }
    >
      {total ? (
        <>
          <Heatmap data={grid} label={`Page views by weekday and hour for ${data.domain}, ${rangeText(days)}. Busiest: ${WEEKDAYS[peak.d]} ${hourText(peak.h)}.`} />
          <p className="muted small panel-foot">
            Busiest: <strong>{WEEKDAYS[peak.d]}</strong> around <strong>{hourText(peak.h)}</strong>. Focus the grid and use the arrow keys to read cells.
          </p>
        </>
      ) : (
        <p className="muted small empty-line">No page views in this period.</p>
      )}
    </Panel>
  );
}
