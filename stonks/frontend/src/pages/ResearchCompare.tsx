import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { LineChart, type LineSeries } from '../components/charts';
import { Segmented, useAsync } from '../components/ui';
import { dateOnly, eur, pct } from '../format';
import type { ResearchBucket, ResearchEntry, WriteupCoin } from '../types';

const STORE = 'stonks.research.compare';
const MAX = 8;
const YEAR_MS = 365 * 86_400_000;
const COLORS = ['var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)'];

type Pts = [number, number][];
type Scale = 'log' | 'euro';
/** One research's full-history curves per coin; the rest of its write-up is not kept. */
type Curves = Record<string, { equity: Pts; holdEquity: Pts }>;

const curveCache = new Map<string, Promise<Curves>>();

/** Session 12's boards name their single-coin rows "ETH alone". */
const coinOf = (id: string) => id.replace(/ alone$/, '');

function curvesOf(specId: string): Promise<Curves> {
  let p = curveCache.get(specId);
  if (!p) {
    p = api.writeup(specId).then((doc) => {
      const out: Curves = {};
      for (const c of doc.sections.find((s) => s.coins?.length)?.coins ?? []) {
        const all = c.ranges.find((r) => r.id === 'all');
        if (all) out[coinOf(c.id)] = { equity: all.equity, holdEquity: all.holdEquity };
      }
      return out;
    });
    p.catch(() => curveCache.delete(specId));
    curveCache.set(specId, p);
  }
  return p;
}

function loadPicked(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(STORE) ?? '[]');
    return Array.isArray(v) ? v.filter((k): k is string => typeof k === 'string').slice(0, MAX) : [];
  } catch {
    return [];
  }
}

function savePicked(keys: string[]) {
  try {
    localStorage.setItem(STORE, JSON.stringify(keys));
  } catch {
    // Private windows may refuse storage: the picks then last until the page closes.
  }
}

const positive = (pts: Pts) => pts.filter(([t, v]) => t > 0 && v > 0);
const rebase = (pts: Pts, from: number, to: number): Pts => {
  const cut = pts.filter(([t]) => t >= from && t <= to);
  return cut.length ? cut.map(([t, v]) => [t, (v / cut[0][1]) * 1000]) : cut;
};

/** Yearly return on calendar time, so old and new research read the same way. */
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
const sessionNo = (b: string) => Number(/^session(\d+)$/.exec(b)?.[1] ?? -1);

/** This research on one coin against any other research on that same coin. Lives under the coin charts of a write-up. */
export function CompareResearch({ specId, coin }: { specId: string; coin: WriteupCoin }) {
  const coinId = coinOf(coin.id);
  const research = useAsync(() => api.research(), []);
  const writeups = useAsync(() => api.writeups().then((r) => new Set(r.writeups.map((w) => w.specId))), []);
  const [picked, setPicked] = useState<string[]>(loadPicked);
  const [from, setFrom] = useState('');
  const [choice, setChoice] = useState('');
  const [scale, setScale] = useState<Scale>('log');
  const [hold, setHold] = useState(true);
  const [loaded, setLoaded] = useState<Record<string, Curves | 'failed'>>({});

  /** Research tabs that have strategies with coin curves, sessions newest first. */
  const tabs = useMemo(() => {
    const r = research.data;
    const buckets = (r && 'buckets' in r ? r.buckets : undefined) ?? {};
    const have = writeups.data;
    return Object.entries(buckets as Record<string, ResearchBucket>)
      .map(([key, b]) => ({ key, title: b.label || key, top: b.top.filter((e) => have?.has(e.spec.id) && e.spec.id !== specId) }))
      .filter((t) => t.top.length)
      .sort((a, b) => sessionNo(b.key) - sessionNo(a.key));
  }, [research.data, writeups.data, specId]);

  const tab = tabs.find((t) => t.key === from) ?? tabs[0];
  const chosen = tab?.top.find((e) => e.spec.id === choice) ?? tab?.top.find((e) => !picked.includes(`${tab.key}:${e.spec.id}`));
  const canAdd = !!tab && !!chosen && !picked.includes(`${tab.key}:${chosen.spec.id}`) && picked.length < MAX;

  const change = (keys: string[]) => {
    setPicked(keys);
    savePicked(keys);
  };

  const others = useMemo(
    () =>
      picked.flatMap((key) => {
        const cut = key.indexOf(':');
        const t = tabs.find((x) => x.key === key.slice(0, cut));
        const e: ResearchEntry | undefined = t?.top.find((x) => x.spec.id === key.slice(cut + 1));
        return t && e ? [{ key, id: e.spec.id, label: `${e.spec.name} (${t.title})` }] : [];
      }),
    [picked, tabs],
  );

  useEffect(() => {
    for (const { id } of others) {
      if (id in loaded) continue;
      curvesOf(id).then(
        (c) => setLoaded((l) => ({ ...l, [id]: c })),
        () => setLoaded((l) => ({ ...l, [id]: 'failed' })),
      );
    }
  }, [others, loaded]);

  const view = useMemo(() => {
    const own = coin.ranges.find((r) => r.id === 'all') ?? coin.ranges[0];
    const lines = [
      { key: 'self', label: 'This research', color: 'var(--s1)', equity: positive(own?.equity ?? []), holdEquity: positive(own?.holdEquity ?? []) },
      ...others.flatMap((o, i) => {
        const c = loaded[o.id];
        const curve = c && c !== 'failed' ? c[coinId] : undefined;
        return curve ? [{ key: o.key, label: o.label, color: COLORS[i % COLORS.length], equity: positive(curve.equity), holdEquity: positive(curve.holdEquity) }] : [];
      }),
    ].filter((l) => l.equity.length > 1);
    const start = Math.max(...lines.map((l) => l.equity[0][0]));
    const end = Math.min(...lines.map((l) => l.equity[l.equity.length - 1][0]));
    const rows = lines.map((l) => ({ ...l, equity: rebase(l.equity, start, end), holdEquity: rebase(l.holdEquity, start, end) })).filter((l) => l.equity.length > 1);
    const series: LineSeries[] = rows.map((r) => ({ name: r.label, color: r.color, points: r.equity, width: r.key === 'self' ? 2.4 : 1.8 }));
    if (hold && rows[0]?.holdEquity.length) series.push({ name: `Holding ${coinId}`, color: 'var(--ink-3)', dash: '6 5', points: rows[0].holdEquity, width: 1.6 });
    return { rows, series, start, end };
  }, [coin, coinId, others, loaded, hold]);

  const waiting = others.filter((o) => !(o.id in loaded));
  const without = others.filter((o) => loaded[o.id] && (loaded[o.id] === 'failed' || !(loaded[o.id] as Curves)[coinId]));

  return (
    <div className="compare-research" id="compare-research">
      <h3>Compare {coinId} with other research</h3>
      <p className="small soft writeup-hint">Tap a coin above to switch. Every line uses that coin, from the first day they all share.</p>
      {research.error || writeups.error ? (
        <p className="small soft">The other research could not be loaded.</p>
      ) : (
        <div className="compare-pick">
          <div className="field">
            <label htmlFor="compare-from">Research</label>
            <select
              id="compare-from"
              className="input"
              value={tab?.key ?? ''}
              onChange={(ev) => {
                setFrom(ev.target.value);
                setChoice('');
              }}
            >
              {tabs.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.title}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="compare-choice">Strategy</label>
            <select id="compare-choice" className="input" value={chosen?.spec.id ?? ''} onChange={(ev) => setChoice(ev.target.value)}>
              {tab?.top.map((e) => (
                <option key={e.spec.id} value={e.spec.id}>
                  #{e.rank} {e.spec.name}
                </option>
              ))}
            </select>
          </div>
          <button
            className="btn brass"
            disabled={!canAdd}
            onClick={() => {
              if (!tab || !chosen) return;
              change([...picked, `${tab.key}:${chosen.spec.id}`]);
              setChoice('');
            }}
          >
            Add to graph
          </button>
        </div>
      )}

      {view.rows.length > 0 && (
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
            <label className="compare-hold">
              <input type="checkbox" checked={hold} onChange={(ev) => setHold(ev.target.checked)} /> Holding
            </label>
          </div>
          <LineChart
            series={view.series}
            height={280}
            log={scale === 'log'}
            ariaLabel={`Value of €1,000 on ${coinId} in this research and the chosen ones`}
            yFormat={euroAxis}
            tipFormat={(v) => eur(v, true)}
            baseline={1000}
            baselineLabel="€1,000 start"
          />
          <p className="small soft">
            Every line starts at €1,000 on {dateOnly(view.start)} and ends on {dateOnly(view.end)}. Even growth draws doubling as the same height wherever it happens. Figures use
            calendar years and the points on the graph, so a worst drop can read a little under the write-up&rsquo;s.
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
                  const y = yearly(r.equity);
                  const h = yearly(r.holdEquity);
                  return (
                    <tr key={r.key}>
                      <td className="full">
                        <span className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
                          <span className="swatch" style={{ color: r.color }} />
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
                        {eur(r.equity[r.equity.length - 1][1], true)}
                      </td>
                      <td className="r" data-label="Worst drop">
                        {pct(-worstDrop(r.equity), 1)}
                      </td>
                      <td className="r">
                        {r.key !== 'self' && (
                          <button className="btn ghost small" aria-label={`Remove ${r.label}`} onClick={() => change(picked.filter((k) => k !== r.key))}>
                            Remove
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
      {waiting.length > 0 && <p className="small soft">Loading {waiting.length === 1 ? waiting[0].label : `${waiting.length} strategies`}…</p>}
      {without.map((o) => (
        <p className="small soft compare-missing" key={o.key}>
          {o.label} has no {coinId} curve.{' '}
          <button className="btn ghost small" onClick={() => change(picked.filter((k) => k !== o.key))}>
            Remove
          </button>
        </p>
      ))}
    </div>
  );
}
