import { useState } from 'react';
import Art from '../Art';
import { countryName, flag, languageName, rangeText } from '../format';
import { BarList, DataTable, Panel, Seg } from '../ui';
import type { SiteReport } from '../types';

/** Countries (from the browser time zone) and browser languages. */
export default function Locations({ data, days }: { data: SiteReport; days: number }) {
  const [view, setView] = useState<'countries' | 'languages'>('countries');
  const countries = data.countries.map((c) => ({
    key: c.key,
    text: countryName(c.key),
    label: (
      <>
        <span className="flag" aria-hidden="true">
          {flag(c.key)}
        </span>
        {countryName(c.key)}
      </>
    ),
    value: c.visitors,
  }));
  const languages = data.languages.map((l) => ({
    key: l.key,
    text: languageName(l.key),
    label: (
      <>
        {languageName(l.key)} <span className="bl-sub mono">{l.key}</span>
      </>
    ),
    value: l.visitors,
  }));

  return (
    <Panel
      icon="section-locations"
      title="Locations"
      subtitle={`visitors, ${rangeText(days)}`}
      className="panel-locations"
      actions={
        <Seg
          label="Location breakdown"
          small
          value={view}
          onChange={setView}
          options={[
            { value: 'countries', label: 'Countries' },
            { value: 'languages', label: 'Languages' },
          ]}
        />
      }
      table={
        <DataTable
          caption={view === 'countries' ? 'Countries' : 'Languages'}
          head={[view === 'countries' ? 'Country' : 'Language', 'Visitors', 'Views']}
          rows={(view === 'countries' ? data.countries : data.languages).map((r) => [
            view === 'countries' ? `${flag(r.key)} ${countryName(r.key)}` : languageName(r.key),
            r.visitors,
            r.views,
          ])}
        />
      }
    >
      <Art name="world-map" className="panel-bg" />
      <BarList rows={view === 'countries' ? countries : languages} empty="No visits in this period." />
    </Panel>
  );
}
