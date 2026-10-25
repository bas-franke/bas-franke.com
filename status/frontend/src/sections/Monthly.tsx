import { BarChart, type Point } from '../charts';
import { monthLabel, monthTitle } from '../format';
import { DataTable, Panel } from '../ui';
import type { SiteReport } from '../types';

/** Visitors per calendar month for the last 12 months, independent of the selected range. */
export default function Monthly({ data }: { data: SiteReport }) {
  const points: Point[] = data.monthly.map((m) => ({ label: monthLabel(m.month), title: monthTitle(m.month), values: [m.visitors] }));
  return (
    <Panel
      icon="section-calendar"
      title="Monthly"
      subtitle="visitors, last 12 months"
      table={
        <DataTable caption="Visitors per month" head={['Month', 'Visitors', 'Page views']} rows={[...data.monthly].reverse().map((m) => [monthTitle(m.month), m.visitors, m.views])} />
      }
    >
      <BarChart points={points} name="Visitors" label={`Visitors per month for ${data.domain}, last 12 months`} />
    </Panel>
  );
}
