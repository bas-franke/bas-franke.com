import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { LineChart, type LineSeries } from '../components/charts';
import { Segmented, useAsync } from '../components/ui';
import { eur, pct } from '../format';
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

/** A year or more reads as yearly return on calendar time, a shorter stretch as its plain return. */
function resultOf(pts: Pts, spanMs: number): string {
  if (pts.length < 2) return '–';
  const growth = pts[pts.length - 1][1] / pts[0][1];
  const years = spanMs / YEAR_MS;
  return years >= 1 ? `${pct((growth ** (1 / years) - 1) * 100, 0, true)} a year` : pct((growth - 1) * 100, 0, true);
}

const euroAxis = (v: number) => `€${Math.round(v).toLocaleString('en-US')}`;
const sessionNo = (b: string) => Number(/^session(\d+)$/.exec(b)?.[1] ?? -1);

/** The one graph of a write-up: pick a coin and a stretch, then add any other research on that coin. */
export function ResearchGraph({
  specId,
  coins,
  coin,
  rangeId,
  onCoin,
  onRange,
}: {
  specId: string;
  coins: WriteupCoin[];
  coin: WriteupCoin;
  rangeId: string;
  onCoin: (id: string) => void;
  onRange: (id: string) => void;
}) {
  const range = coin.ranges.find((r) => r.id === rangeId) ?? coin.ranges[0];
  const coinId = coinOf(coin.id);
  const research = useAsync(() => api.research(), []);
  const writeups = useAsync(() => api.writeups().then((r) => new Set(r.writeups.map((w) => w.specId))), []);
  const [picked, setPicked] = useState<string[]>(loadPicked);
  const [adding, setAdding] = useState(false);
  const [from, setFrom] = useState('');
  const [choice, setChoice] = useState('');
  const [scale, setScale] = useState<Scale>('log');
  const [hold, setHold] = useState(true);
  const [loaded, setLoaded] = useState<Record<string, Curves | 'failed'>>({});

  // On a phone the coins are one scrolling row: keep the picked coin in view when it is picked from the table.
  const coinRow = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const row = coinRow.current;
    const on = row?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (row && on) row.scrollTo({ left: on.offsetLeft - row.offsetLeft - (row.clientWidth - on.offsetWidth) / 2, behavior: 'smooth' });
  }, [coin.id]);

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
        return t && e ? [{ key, id: e.spec.id, label: `${e.spec.name.replace(/, ETH \d+\w$/, '')} · ${t.title}` }] : [];
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
    const own = positive(range.equity);
    const curves = others.flatMap((o, i) => {
      const c = loaded[o.id];
      const curve = c && c !== 'failed' ? c[coinId] : undefined;
      return curve ? [{ ...o, color: COLORS[i % COLORS.length], pts: positive(curve.equity) }] : [];
    });
    const lo = own.length ? own[0][0] : 0;
    const hi = own.length ? own[own.length - 1][0] : 0;
    const inRange = curves.filter((c) => c.pts.some(([t]) => t >= lo && t <= hi));
    const start = Math.max(lo, ...inRange.map((c) => c.pts[0][0]));
    const end = Math.min(hi, ...inRange.map((c) => c.pts[c.pts.length - 1][0]));
    const span = end - start;
    const lines = [
      { key: 'self', label: 'This research', color: 'var(--s1)', pts: rebase(own, start, end) },
      ...inRange.map((c) => ({ key: c.key, label: c.label, color: c.color, pts: rebase(c.pts, start, end) })),
    ].filter((l) => l.pts.length > 1);
    const holdPts = rebase(positive(range.holdEquity), start, end);
    const series: LineSeries[] = lines.map((l) => ({ name: l.label, color: l.color, points: l.pts, width: l.key === 'self' ? 2.4 : 1.8 }));
    if (hold && holdPts.length > 1) series.push({ name: `Holding ${coinId}`, color: 'var(--ink-3)', dash: '6 5', points: holdPts, width: 1.6 });
    return { lines, series, span, holdResult: resultOf(holdPts, span) };
  }, [range, others, loaded, coinId, hold]);

  const missing = others.filter((o) => loaded[o.id] && !view.lines.some((l) => l.key === o.key));
  const waiting = others.some((o) => !(o.id in loaded));
  const gap = range.strategy - range.hold;

  return (
    <div className="research-graph" id="coin-charts">
      <div className="writeup-picks" role="group" aria-label="Coin" ref={coinRow}>
        {coins.map((c) => (
          <button key={c.id} type="button" className={`chip ${c.id === coin.id ? 'brass' : 'outline'}`} aria-pressed={c.id === coin.id} onClick={() => onCoin(c.id)}>
            {c.id}
          </button>
        ))}
      </div>
      {coin.ranges.length > 1 && (
        <div className="writeup-picks" role="group" aria-label="Period">
          {coin.ranges.map((r) => (
            <button key={r.id} type="button" className={`chip ${r.id === range.id ? 'brass' : 'outline'}`} aria-pressed={r.id === range.id} onClick={() => onRange(r.id)}>
              {r.label}
            </button>
          ))}
        </div>
      )}

      <dl className="graph-stats">
        <div>
          <dt>This research</dt>
          <dd className={gap >= 0 ? 'gain' : 'loss'}>{eur(range.strategy, true)}</dd>
        </div>
        <div>
          <dt>Holding {coinId}</dt>
          <dd>{eur(range.hold, true)}</dd>
        </div>
        <div>
          <dt>{gap >= 0 ? 'Ahead' : 'Behind'}</dt>
          <dd className={gap >= 0 ? 'gain' : 'loss'}>{eur(Math.abs(gap), true)}</dd>
        </div>
      </dl>

      <LineChart
        series={view.series}
        height={250}
        legend={false}
        log={scale === 'log'}
        ariaLabel={`Value of €1,000 on ${coinId}`}
        yFormat={euroAxis}
        tipFormat={(v) => eur(v, true)}
        baseline={1000}
      />

      <div className="graph-lines">
        {view.lines.map((l) => (
          <span className="graph-line" key={l.key}>
            <span className="swatch" style={{ color: l.color }} />
            <span className="graph-line-name">{l.label}</span>
            <b>{resultOf(l.pts, view.span)}</b>
            {l.key !== 'self' && (
              <button type="button" aria-label={`Remove ${l.label}`} onClick={() => change(picked.filter((k) => k !== l.key))}>
                ×
              </button>
            )}
          </span>
        ))}
        <button type="button" className="graph-line" aria-pressed={hold} onClick={() => setHold((v) => !v)}>
          <span className="swatch dashed" style={{ color: 'var(--ink-3)' }} />
          <span className="graph-line-name">Holding {coinId}</span>
          <b>{hold ? view.holdResult : 'off'}</b>
        </button>
        {missing.map((o) => (
          <span className="graph-line is-missing" key={o.key}>
            <span className="graph-line-name">{o.label}: no {coinId}</span>
            <button type="button" aria-label={`Remove ${o.label}`} onClick={() => change(picked.filter((k) => k !== o.key))}>
              ×
            </button>
          </span>
        ))}
        {waiting && <span className="tiny soft">Loading…</span>}
      </div>

      <div className="graph-actions" id="compare-research">
        <button type="button" className="btn small" aria-expanded={adding} disabled={!!research.error || !!writeups.error} onClick={() => setAdding((v) => !v)}>
          {adding ? 'Done' : '+ Compare'}
        </button>
        <Segmented<Scale>
          label="Graph scale"
          value={scale}
          onChange={setScale}
          options={[
            { value: 'log', label: 'Growth' },
            { value: 'euro', label: 'Euros' },
          ]}
        />
      </div>

      {adding && (
        <div className="compare-pick">
          <select
            className="input"
            aria-label="Research"
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
          <select className="input" aria-label="Strategy" value={chosen?.spec.id ?? ''} onChange={(ev) => setChoice(ev.target.value)}>
            {tab?.top.map((e) => (
              <option key={e.spec.id} value={e.spec.id}>
                #{e.rank} {e.spec.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn brass"
            disabled={!canAdd}
            onClick={() => {
              if (!tab || !chosen) return;
              change([...picked, `${tab.key}:${chosen.spec.id}`]);
              setChoice('');
            }}
          >
            Add
          </button>
        </div>
      )}
    </div>
  );
}
