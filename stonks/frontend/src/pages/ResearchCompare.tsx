import { useMemo, useState } from 'react';
import { LineChart, type LineSeries } from '../components/charts';
import { Segmented } from '../components/ui';
import { dateOnly, eur, pct, toDate } from '../format';
import type { BucketName, ResearchBucket, ResearchEntry, Series } from '../types';

const STORE = 'stonks.research.compare';
const MAX = 10;
const YEAR_MS = 365 * 86_400_000;
const COLORS = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)'];

type Pts = [number, number][];
type Scale = 'log' | 'euro';
type Start = 'same' | 'own';

/** A strategy on the compare graph: its research tab and its spec id, so it survives a new research upload. */
export const compareKey = (bucket: string, e: ResearchEntry) => `${bucket}:${e.spec.id}`;

export function loadCompare(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(STORE) ?? '[]');
    return Array.isArray(v) ? v.filter((k): k is string => typeof k === 'string').slice(0, MAX) : [];
  } catch {
    return [];
  }
}

export function saveCompare(keys: string[]) {
  try {
    localStorage.setItem(STORE, JSON.stringify(keys));
  } catch {
    // Private windows may refuse storage: the graph then lasts until the page closes.
  }
}

const toPts = (s: Series | undefined): Pts =>
  (s ?? []).map(([t, v]) => [toDate(t)?.getTime() ?? 0, Number(v)] as [number, number]).filter(([t, v]) => t > 0 && v > 0);

const clip = (pts: Pts, from: number, to: number) => pts.filter(([t]) => t >= from && t <= to);
const rebase = (pts: Pts): Pts => (pts.length ? pts.map(([t, v]) => [t, (v / pts[0][1]) * 1000]) : pts);

/** Yearly return on calendar time, so old and new cards read the same way. */
function yearly(pts: Pts): number | null {
  if (pts.length < 2) return null;
  const years = (pts[pts.length - 1][0] - pts[0][0]) / YEAR_MS;
  return years * 365 < 30 ? null : ((pts[pts.length - 1][1] / pts[0][1]) ** (1 / years) - 1) * 100;
}

function worstDrop(pts: Pts): number {
  let peak = 0;
  let dd = 0;
  for (const [, v] of pts) {
    peak = Math.max(peak, v);
    dd = Math.max(dd, 1 - v / peak);
  }
  return dd * 100;
}

const fmtYearly = (v: number | null) => (v === null ? '–' : pct(v, 1, true));
const euroAxis = (v: number) => `€${Math.round(v).toLocaleString('en-US')}`;

export function CompareAcross({
  buckets,
  tabs,
  titleOf,
  keys,
  onChange,
}: {
  buckets: Partial<Record<BucketName, ResearchBucket>>;
  /** Research tabs in the order the picker lists them. */
  tabs: string[];
  titleOf: (bucket: string) => string;
  keys: string[];
  onChange: (keys: string[]) => void;
}) {
  const [from, setFrom] = useState(tabs[0] ?? '');
  const [choice, setChoice] = useState('');
  const [scale, setScale] = useState<Scale>('log');
  const [start, setStart] = useState<Start>('same');
  const [hold, setHold] = useState(true);

  const picked = useMemo(
    () =>
      keys.flatMap((key) => {
        const cut = key.indexOf(':');
        const bucket = key.slice(0, cut);
        const e = buckets[bucket as BucketName]?.top.find((x) => x.spec.id === key.slice(cut + 1));
        return e ? [{ key, bucket, e, label: `${e.spec.name} (${titleOf(bucket)})` }] : [];
      }),
    [keys, buckets, titleOf],
  );

  const options = buckets[from as BucketName]?.top ?? [];
  const chosen = options.find((e) => e.spec.id === choice) ?? options.find((e) => !keys.includes(compareKey(from, e)));
  const canAdd = !!chosen && !keys.includes(compareKey(from, chosen)) && keys.length < MAX;

  const view = useMemo(() => {
    const curves = picked.map((p) => ({ ...p, pts: toPts(p.e.equity), holdPts: toPts(p.e.buyHoldEquity) })).filter((p) => p.pts.length > 1);
    const lo = Math.max(...curves.map((c) => c.pts[0][0]));
    const hi = Math.min(...curves.map((c) => c.pts[c.pts.length - 1][0]));
    const overlap = curves.length > 0 && hi > lo && curves.every((c) => clip(c.pts, lo, hi).length > 1);
    const same = start === 'same' && overlap;
    const shape = (pts: Pts) => (same ? rebase(clip(pts, lo, hi)) : pts);
    const rows = curves.map((c, i) => ({ ...c, color: COLORS[i % COLORS.length], dash: i < COLORS.length ? undefined : '8 4', pts: shape(c.pts), holdPts: shape(c.holdPts) }));
    const series: LineSeries[] = rows.map((r) => ({ name: r.label, color: r.color, dash: r.dash, points: r.pts, width: 2 }));
    if (hold) {
      const seen = new Set<string>();
      for (const r of rows) {
        const name = `Holding ${r.e.spec.markets.length > 1 ? 'the same coins' : r.e.spec.markets[0]?.split('-')[0]}`;
        if (seen.has(name)) continue;
        seen.add(name);
        series.push({ name, color: 'var(--ink-3)', dash: seen.size === 1 ? '6 5' : '1 5', points: r.holdPts, width: 1.6 });
      }
    }
    return { rows, series, same, from: lo, to: hi, overlap };
  }, [picked, start, hold]);

  const add = () => {
    if (!chosen || !canAdd) return;
    onChange([...keys, compareKey(from, chosen)]);
    setChoice('');
  };

  return (
    <section className="card compare-across" aria-labelledby="compare-across-title">
      <div className="card-head">
        <h2 id="compare-across-title" style={{ marginRight: 'auto' }}>
          Compare any research
        </h2>
        {keys.length > 0 && (
          <button className="btn ghost small" onClick={() => onChange([])}>
            Clear all
          </button>
        )}
      </div>
      <div className="compare-pick">
        <div className="field">
          <label htmlFor="compare-from">Research</label>
          <select
            id="compare-from"
            className="input"
            value={from}
            onChange={(ev) => {
              setFrom(ev.target.value);
              setChoice('');
            }}
          >
            {tabs.map((t) => (
              <option key={t} value={t}>
                {titleOf(t)}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="compare-choice">Strategy</label>
          <select id="compare-choice" className="input" value={chosen?.spec.id ?? ''} onChange={(ev) => setChoice(ev.target.value)}>
            {options.map((e) => (
              <option key={e.spec.id} value={e.spec.id}>
                #{e.rank} {e.spec.name}
              </option>
            ))}
          </select>
        </div>
        <button className="btn brass" disabled={!canAdd} onClick={add}>
          Add to graph
        </button>
      </div>

      {view.rows.length === 0 ? (
        <p className="small soft">Pick any session and strategy above, or press Compare on a card, to put strategies on one graph.</p>
      ) : (
        <>
          <div className="compare-controls">
            <Segmented<Scale>
              label="Graph scale"
              value={scale}
              onChange={setScale}
              options={[
                { value: 'log', label: 'Even growth' },
                { value: 'euro', label: 'Euros' },
              ]}
            />
            <Segmented<Start>
              label="Where the lines start"
              value={start}
              onChange={setStart}
              options={[
                { value: 'same', label: 'Same start' },
                { value: 'own', label: 'Full history' },
              ]}
            />
            <label className="compare-hold">
              <input type="checkbox" checked={hold} onChange={(ev) => setHold(ev.target.checked)} /> Holding
            </label>
          </div>
          <LineChart
            series={view.series}
            height={300}
            log={scale === 'log'}
            ariaLabel="Value of €1,000 in the chosen strategies"
            yFormat={euroAxis}
            tipFormat={(v) => eur(v, true)}
            baseline={1000}
            baselineLabel="€1,000 start"
          />
          <p className="small soft">
            {view.same
              ? `Every line starts at €1,000 on ${dateOnly(view.from)} and ends on ${dateOnly(view.to)}.`
              : start === 'same'
                ? 'These strategies share too little history to start together, so each shows its own.'
                : 'Each line shows its own full test.'}{' '}
            Even growth draws doubling as the same height wherever it happens. Figures use calendar years and the points on the graph, so a worst drop can read a little
            under the card&rsquo;s.
          </p>
          <div className="table-wrap">
            <table className="data cards">
              <thead>
                <tr>
                  <th>Strategy</th>
                  <th className="r">Yearly</th>
                  <th className="r">Holding yearly</th>
                  <th className="r">Ahead of holding</th>
                  <th className="r">€1,000 became</th>
                  <th className="r">Worst drop</th>
                  <th aria-label="Remove" />
                </tr>
              </thead>
              <tbody>
                {view.rows.map((r) => {
                  const y = yearly(r.pts);
                  const h = yearly(r.holdPts);
                  return (
                    <tr key={r.key}>
                      <td className="full">
                        <span className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
                          <span className={`swatch${r.dash ? ' dashed' : ''}`} style={{ color: r.color }} />
                          <span style={{ minWidth: 0 }}>{r.label}</span>
                        </span>
                      </td>
                      <td className="r" data-label="Yearly">
                        {fmtYearly(y)}
                      </td>
                      <td className="r" data-label="Holding yearly">
                        {fmtYearly(h)}
                      </td>
                      <td className="r" data-label="Ahead of holding">
                        {y !== null && h !== null ? `${y - h >= 0 ? '+' : '−'}${Math.abs(y - h).toFixed(1)} pts` : '–'}
                      </td>
                      <td className="r" data-label="€1,000 became">
                        {eur(r.pts[r.pts.length - 1][1], true)}
                      </td>
                      <td className="r" data-label="Worst drop">
                        {pct(-worstDrop(r.pts), 1)}
                      </td>
                      <td className="r">
                        <button className="btn ghost small" aria-label={`Remove ${r.label}`} onClick={() => onChange(keys.filter((k) => k !== r.key))}>
                          Remove
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
