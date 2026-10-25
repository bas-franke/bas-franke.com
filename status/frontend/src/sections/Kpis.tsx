import type { ReactNode } from 'react';
import Art from '../Art';
import { decimal, delta, duration, full, percent, previousText, type Delta } from '../format';
import { DeltaPill } from '../ui';
import type { SiteReport } from '../types';

/** The headline numbers for the range, each with its trend against the period before. */
export default function Kpis({ data, days }: { data: SiteReport; days: number }) {
  const t = data.totals;
  const p = t.previous;
  const vs = `Compared with ${previousText(days)}`;
  const visits = t.viewsPerVisit ? Math.round(t.views / t.viewsPerVisit) : null;

  return (
    <div className="kpis" role="list" aria-label="Key numbers">
      <Kpi label="Visitors" value={full(t.visitors)} was={full(p.visitors)} delta={delta(t.visitors, p.visitors)} vs={vs} hint="Unique visitors per day, added up" />
      <Kpi label="Page views" value={full(t.views)} was={full(p.views)} delta={delta(t.views, p.views)} vs={vs} />
      <Kpi
        label="Views per visit"
        value={decimal(t.viewsPerVisit)}
        was={decimal(p.viewsPerVisit)}
        delta={delta(t.viewsPerVisit, p.viewsPerVisit)}
        vs={vs}
        hint={visits !== null ? `${full(visits)} visits` : undefined}
      />
      <Kpi
        label="Avg engagement"
        value={duration(t.avgEngagedMs)}
        was={duration(p.avgEngagedMs)}
        delta={delta(t.avgEngagedMs, p.avgEngagedMs)}
        vs={vs}
        hint="Visible time per page view"
      />
      <Kpi
        label="Bounce rate"
        value={percent(t.bounceRate)}
        was={percent(p.bounceRate)}
        delta={delta(t.bounceRate, p.bounceRate, { points: true, lowerIsBetter: true })}
        vs={vs}
        hint="Visits that saw one page; lower is better"
      />
      <Kpi
        label={
          <>
            <Art name="section-live" className="kpi-icon" /> Live now
          </>
        }
        value={full(data.live)}
        live={data.live > 0}
        hint="Visitors in the last 5 minutes"
        foot="in the last 5 minutes"
      />
    </div>
  );
}

function Kpi({ label, value, was, delta, vs, hint, live, foot }: { label: ReactNode; value: string; was?: string; delta?: Delta; vs?: string; hint?: string; live?: boolean; foot?: string }) {
  return (
    <div className={`kpi${live ? ' kpi-live' : ''}`} role="listitem" title={hint}>
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">
        {live !== undefined && <span className={`pulse${live ? '' : ' pulse-idle'}`} aria-hidden="true" />}
        {value}
      </span>
      <span className="kpi-foot">
        <DeltaPill delta={delta} title={vs} />
        {was !== undefined ? <span className="kpi-was">was {was}</span> : foot && <span className="kpi-was">{foot}</span>}
      </span>
    </div>
  );
}
