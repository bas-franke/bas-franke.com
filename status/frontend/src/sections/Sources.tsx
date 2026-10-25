import { useState } from 'react';
import { full, rangeText } from '../format';
import { BarList, DataTable, Panel, Seg, type BarRow } from '../ui';
import type { Breakdown, Channel, SiteReport } from '../types';

const CHANNELS: Record<Channel, { label: string; about: string }> = {
  direct: { label: 'Direct', about: 'typed the address, bookmarks, apps' },
  search: { label: 'Search', about: 'Google, Bing, DuckDuckGo, …' },
  social: { label: 'Social', about: 'LinkedIn, X, Reddit, Facebook, …' },
  referral: { label: 'Other websites', about: 'links on other sites' },
  email: { label: 'Email', about: 'webmail and newsletters' },
  campaign: { label: 'Campaigns', about: 'links tagged with utm_source' },
};

type View = 'channels' | 'referrers' | 'campaigns';

/** Where visitors come from: channel mix, referring sites, tagged campaigns. */
export default function Sources({ data, days }: { data: SiteReport; days: number }) {
  const [view, setView] = useState<View>('channels');
  const totalVisitors = data.channels.reduce((n, c) => n + c.visitors, 0);

  const rows: Record<View, BarRow[]> = {
    channels: data.channels.map((c) => ({
      key: c.key,
      text: CHANNELS[c.key]?.label ?? c.key,
      label: (
        <>
          {CHANNELS[c.key]?.label ?? c.key} <span className="bl-sub">{CHANNELS[c.key]?.about}</span>
        </>
      ),
      value: c.visitors,
    })),
    referrers: data.referrers.map((r) => ({
      key: r.key,
      text: r.key,
      label: (
        <a className="mono bl-link" href={`https://${r.key}`} target="_blank" rel="noreferrer">
          {r.key}
        </a>
      ),
      value: r.visitors,
    })),
    campaigns: data.campaigns.map((c) => ({ key: c.key, label: <span className="mono">{c.key}</span>, text: c.key, value: c.visitors })),
  };

  const tableRows = (list: { key: string; views: number; visitors: number }[], name: (k: string) => string) =>
    list.map((r) => [name(r.key), r.visitors, r.views]);
  const table: Record<View, (string | number)[][]> = {
    channels: tableRows(data.channels, (k) => CHANNELS[k as Channel]?.label ?? k),
    referrers: tableRows(data.referrers as Breakdown[], (k) => k),
    campaigns: tableRows(data.campaigns, (k) => k),
  };

  return (
    <Panel
      icon="section-sources"
      title="Sources"
      subtitle={`visitors, ${rangeText(days)}`}
      actions={
        <Seg
          label="Source breakdown"
          small
          value={view}
          onChange={setView}
          options={[
            { value: 'channels', label: 'Channels' },
            { value: 'referrers', label: 'Referrers' },
            { value: 'campaigns', label: 'Campaigns' },
          ]}
        />
      }
      table={<DataTable caption="Sources" head={[view === 'channels' ? 'Channel' : view === 'referrers' ? 'Site' : 'utm_source', 'Visitors', 'Views']} rows={table[view]} />}
    >
      <BarList
        rows={rows[view]}
        total={view === 'channels' ? totalVisitors : undefined}
        empty={
          view === 'referrers'
            ? 'No other sites linked here in this period.'
            : view === 'campaigns'
              ? 'No links tagged with utm_source in this period.'
              : 'No visits in this period.'
        }
      />
      {view === 'channels' && totalVisitors > 0 && (
        <p className="muted small panel-foot">{full(totalVisitors)} visits, sorted by visitors. Hover a row for its share.</p>
      )}
    </Panel>
  );
}
