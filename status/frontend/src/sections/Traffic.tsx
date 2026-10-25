import { useState } from 'react';
import { LineChart, type Point } from '../charts';
import { dayLabel, dayTitle, duration, rangeText } from '../format';
import { DataTable, Panel, Seg } from '../ui';
import type { SiteReport } from '../types';

const TRAFFIC = [
  { name: 'Visitors', color: 'var(--series-1)' },
  { name: 'Page views', color: 'var(--series-2)' },
];
const ENGAGEMENT = [{ name: 'Avg engagement', color: 'var(--series-1)' }];
const asTime = (seconds: number) => duration(seconds * 1000);

/** Visitors and views per day, or the average engaged time per day. */
export default function Traffic({ data, days }: { data: SiteReport; days: number }) {
  const [metric, setMetric] = useState<'traffic' | 'engagement'>('traffic');
  const points: Point[] = data.daily.map((d) => ({
    label: dayLabel(d.day),
    title: dayTitle(d.day),
    values: metric === 'traffic' ? [d.visitors, d.views] : [d.avgEngagedMs === null ? null : d.avgEngagedMs / 1000],
  }));

  return (
    <Panel
      icon="section-traffic"
      title="Traffic"
      subtitle={`per day, ${rangeText(days)}`}
      actions={
        <Seg
          label="Metric"
          small
          value={metric}
          onChange={setMetric}
          options={[
            { value: 'traffic', label: 'Visitors & views' },
            { value: 'engagement', label: 'Engagement' },
          ]}
        />
      }
      table={
        <DataTable
          caption="Traffic per day"
          head={['Day', 'Visitors', 'Page views', 'Avg time']}
          rows={[...data.daily].reverse().map((d) => [dayTitle(d.day), d.visitors, d.views, { text: duration(d.avgEngagedMs), className: 'num' }])}
        />
      }
    >
      {metric === 'traffic' ? (
        <LineChart points={points} series={TRAFFIC} label={`Visitors and page views per day for ${data.domain}, ${rangeText(days)}`} />
      ) : (
        <LineChart
          points={points}
          series={ENGAGEMENT}
          format={{ seconds: true, tick: asTime, value: asTime }}
          label={`Average engaged time per page view per day for ${data.domain}, ${rangeText(days)}`}
        />
      )}
    </Panel>
  );
}
