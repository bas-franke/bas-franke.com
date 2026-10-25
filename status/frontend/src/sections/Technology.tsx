import { rangeText } from '../format';
import { BarList, Panel } from '../ui';
import type { Breakdown, SiteReport } from '../types';

const DEVICE_ICON: Record<string, string> = { desktop: '🖥️', tablet: '📱', mobile: '📱' };

/** Devices, browsers and operating systems side by side. */
export default function Technology({ data, days }: { data: SiteReport; days: number }) {
  const list = (rows: Breakdown[], label: (k: string) => string) =>
    rows.map((r) => ({ key: r.key, text: label(r.key), label: label(r.key), value: r.visitors }));
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

  return (
    <Panel icon="section-technology" title="Technology" subtitle={`visitors, ${rangeText(days)}`}>
      <div className="tech-cols">
        <div>
          <h3 className="sub-title">Devices</h3>
          <BarList
            rows={data.devices.map((r) => ({
              key: r.key,
              text: cap(r.key),
              label: (
                <>
                  <span className="flag" aria-hidden="true">
                    {DEVICE_ICON[r.key] ?? '•'}
                  </span>
                  {cap(r.key)}
                </>
              ),
              value: r.visitors,
            }))}
            limit={6}
            empty="No visits in this period."
          />
        </div>
        <div>
          <h3 className="sub-title">Browsers</h3>
          <BarList rows={list(data.browsers, (k) => k)} limit={6} empty="No visits in this period." />
        </div>
        <div>
          <h3 className="sub-title">Operating systems</h3>
          <BarList rows={list(data.os, (k) => k)} limit={6} empty="No visits in this period." />
        </div>
      </div>
    </Panel>
  );
}
