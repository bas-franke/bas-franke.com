import { useState } from 'react';
import { duration, rangeText } from '../format';
import { DataTable, Panel, Seg, type Cell } from '../ui';
import type { SiteReport } from '../types';

type View = 'top' | 'entry' | 'exit';

const pathCell = (domain: string, path: string): Cell => ({
  text: path,
  className: 'path',
  node: (
    <a href={`https://${domain}${path}`} target="_blank" rel="noreferrer" className="path-link">
      {path}
    </a>
  ),
});

/** Most visited pages with engagement, and the pages visits start and end on. */
export default function Pages({ data, days }: { data: SiteReport; days: number }) {
  const [view, setView] = useState<View>('top');

  let head: string[];
  let rows: Cell[][];
  if (view === 'top') {
    head = ['Page', 'Visitors', 'Views', 'Avg time', 'Entries'];
    rows = data.pages.map((p) => [pathCell(data.domain, p.key), p.visitors, p.views, { text: duration(p.avgEngagedMs), className: 'num' }, p.entries]);
  } else {
    const list = view === 'entry' ? data.entryPages : data.exitPages;
    head = ['Page', 'Visits', 'Views'];
    rows = list.map((p) => [pathCell(data.domain, p.key), p.visitors, p.views]);
  }

  return (
    <Panel
      icon="section-pages"
      title="Pages"
      subtitle={rangeText(days)}
      actions={
        <Seg
          label="Page list"
          small
          value={view}
          onChange={setView}
          options={[
            { value: 'top', label: 'Top', title: 'Most visited pages' },
            { value: 'entry', label: 'Entry', title: 'Pages visits started on' },
            { value: 'exit', label: 'Exit', title: 'Pages visits ended on' },
          ]}
        />
      }
    >
      {rows.length ? (
        <DataTable caption={`${view} pages`} head={head} rows={rows} mono />
      ) : (
        <p className="muted small empty-line">No page views in this period.</p>
      )}
    </Panel>
  );
}
