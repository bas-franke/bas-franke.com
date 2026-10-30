// One replayed stretch of the bot: price with its buys and sells, and below it how much of the pot was in coins.
import { useEffect, useMemo, useRef, useState } from 'react';
import { eur } from '../format';
import type { TradeChartData } from './data';

const MIN = 60_000;
const M = { top: 22, right: 12, left: 58, gap: 14 };
const STRIP = 52;
const AXIS = 24;
const BADGE = 9;

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)));
    ro.observe(el);
    setW(Math.round(el.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/** A few round prices between min and max. */
function priceTicks(min: number, max: number, log: boolean) {
  if (log) {
    const out: number[] = [];
    for (let e = Math.floor(Math.log10(min)); e <= Math.ceil(Math.log10(max)); e++)
      for (const m of [1, 2, 5]) {
        const v = m * 10 ** e;
        if (v >= min && v <= max) out.push(v);
      }
    return out;
  }
  const raw = (max - min) / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => (max - min) / s <= 4.5) ?? 10 * mag;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max; v += step) out.push(Math.round(v / step) * step);
  return out;
}

const when = (ms: number, withTime: boolean, withYear: boolean) =>
  new Date(ms).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    ...(withYear ? { year: 'numeric' as const } : {}),
    ...(withTime ? { hour: '2-digit' as const, minute: '2-digit' as const, timeZone: 'UTC' } : { timeZone: 'UTC' }),
  });

const axisDate = (ms: number, spanDays: number) =>
  new Date(ms).toLocaleDateString('en-GB', { timeZone: 'UTC', ...(spanDays > 400 ? { year: 'numeric' as const } : { day: 'numeric' as const, month: 'short' as const }) });

export function TradeChart({ data, label, height = 230, log = false }: { data: TradeChartData; label: string; height?: number; log?: boolean }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const days = data.end / 1440;

  const g = useMemo(() => {
    if (width < 10) return null;
    const left = width < 460 ? 48 : M.left;
    const pw = width - left - M.right;
    const priceBottom = M.top + height;
    const stripTop = priceBottom + M.gap;
    const stripBottom = stripTop + STRIP;
    const lo = Math.min(...data.p);
    const hi = Math.max(...data.p);
    const pad = log ? 0 : (hi - lo) * 0.14;
    const dom0 = log ? lo : lo - pad;
    const dom1 = log ? hi : hi + pad;
    const f = (v: number) => (log ? Math.log(v) : v);
    const x = (t: number) => left + (t / data.end) * pw;
    const y = (v: number) => priceBottom - ((f(v) - f(dom0)) / (f(dom1) - f(dom0))) * height;
    const line = data.t.map((t, i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)} ${y(data.p[i]).toFixed(1)}`).join('');
    const posY = (s: number) => stripBottom - s * STRIP;
    let strip = `M${x(0).toFixed(1)} ${stripBottom}`;
    let prev = 0;
    for (const [t, s] of data.pos) {
      strip += `L${x(t).toFixed(1)} ${posY(prev).toFixed(1)}L${x(t).toFixed(1)} ${posY(s).toFixed(1)}`;
      prev = s;
    }
    strip += `L${x(data.end).toFixed(1)} ${posY(prev).toFixed(1)}L${x(data.end).toFixed(1)} ${stripBottom}Z`;
    // Numbered badges sit above a buy and below a sell, and step away from a neighbour so they stay readable.
    const taken: { x: number; y: number }[] = [];
    const badges = data.marks
      .filter((m) => m[4] !== undefined)
      .map((m) => {
        const buy = m[3] > m[2];
        const mx = x(m[0]);
        const my = y(m[1]);
        let by = my + (buy ? -20 : 20);
        for (let tries = 0; tries < 8 && taken.some((o) => Math.abs(o.x - mx) < BADGE * 2.1 && Math.abs(o.y - by) < BADGE * 2.1); tries++) by += buy ? -BADGE * 2.1 : BADGE * 2.1;
        by = Math.max(BADGE + 1, Math.min(priceBottom - BADGE - 1, by));
        taken.push({ x: mx, y: by });
        return { n: m[4], buy, mx, my, by: by };
      });
    const n = width < 460 ? 3 : 5;
    const xTicks = Array.from({ length: n }, (_, i) => (data.end * (i + 0.5)) / n);
    return { left, pw, priceBottom, stripTop, stripBottom, x, y, line, strip, posY, badges, xTicks, yTicks: priceTicks(dom0, dom1, log), total: stripBottom + AXIS };
  }, [data, width, height, log]);

  const at = hover === null ? null : data.t.reduce((best, t, i) => (Math.abs(t - hover) < Math.abs(data.t[best] - hover) ? i : best), 0);
  const heldAt = (t: number) => data.pos.reduce((s, [pt, v]) => (pt <= t ? v : s), 0);
  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    if (!g) return;
    const box = e.currentTarget.getBoundingClientRect();
    setHover(Math.max(0, Math.min(data.end, ((e.clientX - box.left) / box.width) * data.end)));
  };

  return (
    <div className="hit-chart" ref={ref}>
      {g && (
        <svg width={width} height={g.total} role="img" aria-label={label}>
          {data.bands.map(([a, b, kind], i) => (
            <rect key={i} className={kind === 2 ? 'hit-band hot' : 'hit-band'} x={g.x(a)} y={M.top} width={Math.max(1, g.x(b) - g.x(a))} height={g.stripBottom - M.top} />
          ))}
          {g.yTicks.map((v) => (
            <g key={v}>
              <line className="hit-grid" x1={g.left} x2={width - M.right} y1={g.y(v)} y2={g.y(v)} />
              <text className="hit-tick" x={g.left - 8} y={g.y(v) + 4} textAnchor="end">
                €{v.toLocaleString('en-US')}
              </text>
            </g>
          ))}
          <path className="hit-line" d={g.line} />

          <path className="hit-strip" d={g.strip} />
          <line className="hit-grid" x1={g.left} x2={width - M.right} y1={g.stripBottom} y2={g.stripBottom} />
          <line className="hit-grid" x1={g.left} x2={width - M.right} y1={g.stripTop} y2={g.stripTop} />
          <text className="hit-tick" x={g.left - 8} y={g.stripTop + 10} textAnchor="end">
            100%
          </text>
          <text className="hit-tick" x={g.left - 8} y={g.stripBottom} textAnchor="end">
            0%
          </text>
          {g.xTicks.map((t) => (
            <text key={t} className="hit-tick" x={g.x(t)} y={g.stripBottom + 17} textAnchor="middle">
              {axisDate(data.start + t * MIN, days)}
            </text>
          ))}

          {data.marks.map((m, i) => {
            const buy = m[3] > m[2];
            const mx = g.x(m[0]);
            const my = g.y(m[1]);
            const s = m[4] === undefined ? 3.6 : 5;
            return <path key={i} className={buy ? 'hit-mark buy' : 'hit-mark sell'} d={buy ? `M${mx} ${my - s}l${s} ${s * 1.7}h${-2 * s}Z` : `M${mx} ${my + s}l${s} ${-s * 1.7}h${-2 * s}Z`} />;
          })}
          {g.badges.map((b) => (
            <g key={b.n}>
              <line className="hit-stem" x1={b.mx} x2={b.mx} y1={b.my} y2={b.by} />
              <circle className={b.buy ? 'hit-badge buy' : 'hit-badge sell'} cx={b.mx} cy={b.by} r={BADGE} />
              <text className="hit-badge-n" x={b.mx} y={b.by + 3.6} textAnchor="middle">
                {b.n}
              </text>
            </g>
          ))}

          {at !== null && <line className="hit-cross" x1={g.x(data.t[at])} x2={g.x(data.t[at])} y1={M.top} y2={g.stripBottom} />}
          {at !== null && <circle className="hit-dot" cx={g.x(data.t[at])} cy={g.y(data.p[at])} r={4} />}
          <rect x={g.left} y={M.top} width={g.pw} height={g.stripBottom - M.top} fill="transparent" onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={() => setHover(null)} />
        </svg>
      )}
      {g && at !== null && (
        <div className="hit-tip" style={{ left: Math.min(width - 150, Math.max(0, g.x(data.t[at]) - 70)) }}>
          <span className="tiny muted">{when(data.start + data.t[at] * MIN, days < 40, days > 300)}</span>
          <b className="tnum">{eur(data.p[at])}</b>
          <span className="tiny soft">{Math.round(heldAt(data.t[at]) * 100)}% in ETH</span>
        </div>
      )}
    </div>
  );
}

export function ChartLegend({ bull = true, hot = false }: { bull?: boolean; hot?: boolean }) {
  return (
    <ul className="hit-legend tiny soft">
      <li>
        <i className="hit-key line" /> ETH price
      </li>
      <li>
        <svg width="11" height="10" aria-hidden="true">
          <path className="hit-mark buy" d="M5.5 0l5 9h-10Z" />
        </svg>{' '}
        Buy or add
      </li>
      <li>
        <svg width="11" height="10" aria-hidden="true">
          <path className="hit-mark sell" d="M5.5 10l5 -9h-10Z" />
        </svg>{' '}
        Sell or trim
      </li>
      <li>
        <i className="hit-key strip" /> Share of the pot in ETH
      </li>
      {bull && (
        <li>
          <i className="hit-key band" /> Bitcoin bull market
        </li>
      )}
      {hot && (
        <li>
          <i className="hit-key band hot" /> Overheated
        </li>
      )}
    </ul>
  );
}

export type Note = { day: string; act: 'buy' | 'sell'; text: string };

/** The numbered story under a chart: the same numbers as its badges. */
export function ChartNotes({ notes }: { notes: Note[] }) {
  return (
    <ol className="hit-notes">
      {notes.map((n, i) => (
        <li key={i}>
          <span className={`hit-num ${n.act}`}>{i + 1}</span>
          <span>
            <b>{n.day}.</b> {n.text}
          </span>
        </li>
      ))}
    </ol>
  );
}
