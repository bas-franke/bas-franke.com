// Hand-drawn SVG charts: no chart library. Thin 2px lines, recessive grid, crosshair + tooltip on hover.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

export interface LineSeries {
  name: string;
  color: string;
  points: [number, number][]; // [ms, value]
  dash?: string;
  width?: number;
  area?: boolean;
  /** Tooltip text for a point (default: the chart's tipFormat of its value). */
  tip?: (p: [number, number]) => string;
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
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

function niceTicks(min: number, max: number, count = 4) {
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const span = max - min;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count + 0.5) ?? 10 * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v / step) * step);
  return { lo, hi, ticks };
}

const nearest = (pts: [number, number][], x: number) => {
  let lo = 0;
  let hi = pts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (pts[mid][0] < x) lo = mid;
    else hi = mid;
  }
  return Math.abs(pts[lo][0] - x) <= Math.abs(pts[hi][0] - x) ? lo : hi;
};

const shortDate = (ms: number, spanDays: number) =>
  new Date(ms).toLocaleDateString('en-GB', spanDays > 400 ? { month: 'short', year: '2-digit' } : spanDays > 3 ? { day: 'numeric', month: 'short' } : { hour: '2-digit', minute: '2-digit' });

export function LineChart({
  series,
  height = 240,
  yFormat = (v) => String(Math.round(v)),
  tipFormat,
  baseline,
  baselineLabel,
  legend = true,
  ariaLabel,
}: {
  series: LineSeries[];
  height?: number;
  yFormat?: (v: number) => string;
  tipFormat?: (v: number) => string;
  baseline?: number;
  baselineLabel?: string;
  legend?: boolean;
  ariaLabel: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const live = series.filter((s) => s.points.length > 1);

  const geo = useMemo(() => {
    if (!live.length || !width) return null;
    let xmin = Infinity,
      xmax = -Infinity,
      ymin = Infinity,
      ymax = -Infinity;
    for (const s of live)
      for (const [x, y] of s.points) {
        if (x < xmin) xmin = x;
        if (x > xmax) xmax = x;
        if (y < ymin) ymin = y;
        if (y > ymax) ymax = y;
      }
    if (baseline !== undefined) {
      ymin = Math.min(ymin, baseline);
      ymax = Math.max(ymax, baseline);
    }
    const pad = (ymax - ymin) * 0.06;
    const { lo, hi, ticks } = niceTicks(ymin >= 0 ? Math.max(0, ymin - pad) : ymin - pad, ymax + pad, height < 200 ? 3 : 4);
    const labelW = Math.max(...ticks.map((t) => yFormat(t).length)) * 6.6 + 10;
    const m = { l: labelW, r: 8, t: 10, b: 26 };
    const iw = Math.max(10, width - m.l - m.r);
    const ih = height - m.t - m.b;
    const sx = (x: number) => m.l + ((x - xmin) / (xmax - xmin || 1)) * iw;
    const sy = (y: number) => m.t + (1 - (y - lo) / (hi - lo || 1)) * ih;
    const spanDays = (xmax - xmin) / 86400_000;
    const nx = width < 420 ? 3 : 5;
    const xticks = Array.from({ length: nx }, (_, i) => xmin + ((xmax - xmin) * i) / (nx - 1));
    return { m, iw, ih, sx, sy, ticks, xticks, xmin, xmax, spanDays, lo };
  }, [live, width, height, baseline, yFormat]);

  const paths = useMemo(() => {
    if (!geo) return [];
    return live.map((s) => {
      // Thin long series down to ~2 points per pixel so the SVG stays light.
      const stride = Math.max(1, Math.floor(s.points.length / (geo.iw * 2)));
      const pts = s.points.filter((_, i) => i % stride === 0 || i === s.points.length - 1);
      const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${geo.sx(x).toFixed(1)},${geo.sy(y).toFixed(1)}`).join('');
      const area = s.area
        ? `${d}L${geo.sx(pts[pts.length - 1][0]).toFixed(1)},${geo.m.t + geo.ih}L${geo.sx(pts[0][0]).toFixed(1)},${geo.m.t + geo.ih}Z`
        : null;
      return { s, d, area };
    });
  }, [geo, live]);

  const onMove = (e: React.PointerEvent) => {
    if (!geo) return;
    const rect = (e.currentTarget as SVGElement).getBoundingClientRect();
    const px = e.clientX - rect.left;
    const x = geo.xmin + ((px - geo.m.l) / geo.iw) * (geo.xmax - geo.xmin);
    setHover(Math.max(geo.xmin, Math.min(geo.xmax, x)));
  };

  const fmtTip = tipFormat ?? yFormat;
  let tip: ReactNode = null;
  if (geo && hover !== null) {
    const rows = live.map((s) => ({ s, p: s.points[nearest(s.points, hover)] }));
    const hx = geo.sx(rows[0].p[0]);
    const left = hx > width / 2 ? hx - 12 : hx + 12;
    tip = (
      <>
        <line className="crosshair" x1={hx} x2={hx} y1={geo.m.t} y2={geo.m.t + geo.ih} />
        {rows.map(({ s, p }) => (
          <circle key={s.name} cx={geo.sx(p[0])} cy={geo.sy(p[1])} r={4} style={{ fill: s.color, stroke: 'var(--surface)' }} strokeWidth={2} />
        ))}
        <foreignObject x={0} y={0} width={1} height={1} style={{ overflow: 'visible' }}>
          <div
            className="chart-tip"
            style={{ left, transform: hx > width / 2 ? 'translateX(-100%)' : undefined, top: geo.m.t }}
          >
            <div className="t-date">
              {new Date(rows[0].p[0]).toLocaleString('en-GB', {
                day: 'numeric',
                month: 'short',
                year: geo.spanDays > 300 ? 'numeric' : undefined,
                hour: geo.spanDays < 60 ? '2-digit' : undefined,
                minute: geo.spanDays < 60 ? '2-digit' : undefined,
              })}
            </div>
            {rows.map(({ s, p }) => (
              <div className="t-row" key={s.name}>
                <span className={`swatch${s.dash ? ' dashed' : ''}`} style={{ color: s.color }} />
                <span>{s.name}</span>
                <b>{s.tip ? s.tip(p) : fmtTip(p[1])}</b>
              </div>
            ))}
          </div>
        </foreignObject>
      </>
    );
  }

  return (
    <div className="chart" ref={ref}>
      {legend && live.length > 1 && (
        <div className="legend">
          {live.map((s) => (
            <span key={s.name}>
              <span className={`swatch${s.dash ? (s.dash.startsWith('1 ') ? ' dotted' : ' dashed') : ''}`} style={{ color: s.color }} />
              {s.name}
            </span>
          ))}
        </div>
      )}
      <svg
        height={height}
        role="img"
        aria-label={ariaLabel}
        onPointerMove={onMove}
        onPointerDown={onMove}
        onPointerLeave={() => setHover(null)}
      >
        {geo && (
          <>
            {geo.ticks.map((t) => (
              <g key={t}>
                <line className="grid-line" x1={geo.m.l} x2={geo.m.l + geo.iw} y1={geo.sy(t)} y2={geo.sy(t)} />
                <text className="axis-label" x={geo.m.l - 8} y={geo.sy(t) + 4} textAnchor="end">
                  {yFormat(t)}
                </text>
              </g>
            ))}
            {geo.xticks.map((t, i) => (
              <text
                key={t}
                className="axis-label"
                x={geo.sx(t)}
                y={height - 6}
                textAnchor={i === 0 ? 'start' : i === geo.xticks.length - 1 ? 'end' : 'middle'}
              >
                {shortDate(t, geo.spanDays)}
              </text>
            ))}
            {baseline !== undefined && (
              <g>
                <line
                  x1={geo.m.l}
                  x2={geo.m.l + geo.iw}
                  y1={geo.sy(baseline)}
                  y2={geo.sy(baseline)}
                  style={{ stroke: 'var(--ink-3)' }}
                  strokeWidth={1}
                  strokeDasharray="1 4"
                  strokeLinecap="round"
                />
                {baselineLabel && (
                  <text className="axis-label" x={geo.m.l + 4} y={geo.sy(baseline) - 5}>
                    {baselineLabel}
                  </text>
                )}
              </g>
            )}
            <defs>
              {paths.map(
                ({ s }, i) =>
                  s.area && (
                    <linearGradient key={i} id={`area-${i}-${ariaLabel.length}`} x1="0" x2="0" y1="0" y2="1">
                      <stop offset="0%" style={{ stopColor: s.color }} stopOpacity={0.14} />
                      <stop offset="100%" style={{ stopColor: s.color }} stopOpacity={0} />
                    </linearGradient>
                  ),
              )}
            </defs>
            {paths.map(({ area }, i) => area && <path key={`a${i}`} d={area} fill={`url(#area-${i}-${ariaLabel.length})`} />)}
            {paths.map(({ s, d }) => (
              <path
                key={s.name}
                d={d}
                fill="none"
                style={{ stroke: s.color }}
                strokeWidth={s.width ?? 2}
                strokeDasharray={s.dash}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ))}
            {tip}
          </>
        )}
      </svg>
    </div>
  );
}

/** Diverging daily bars around zero: sage up, terracotta down. */
export function DailyBars({
  days,
  height = 150,
  format,
  limit,
}: {
  days: { day: string; value: number }[];
  height?: number;
  format: (v: number) => string;
  limit?: number;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  if (!days.length) return <div ref={ref} />;
  const max = Math.max(1, ...days.map((d) => Math.abs(d.value)), limit ? limit * 0.4 : 0);
  const m = { l: 6, r: 6, t: 10, b: 22 };
  const iw = Math.max(10, width - m.l - m.r);
  const ih = height - m.t - m.b;
  const zero = m.t + ih / 2;
  const slot = iw / days.length;
  const bw = Math.max(2, Math.min(22, slot - 2));
  const scale = ih / 2 / max;
  const h = hover !== null ? days[hover] : null;
  return (
    <div className="chart" ref={ref}>
      <svg height={height} role="img" aria-label="Profit or loss per day" onPointerLeave={() => setHover(null)}>
        {width > 0 && (
          <>
            <line className="grid-line" x1={m.l} x2={m.l + iw} y1={zero} y2={zero} style={{ stroke: 'var(--line-strong)' }} />
            {limit !== undefined && limit * scale < ih / 2 && (
              <g>
                <line
                  x1={m.l}
                  x2={m.l + iw}
                  y1={zero + limit * scale}
                  y2={zero + limit * scale}
                  style={{ stroke: 'var(--loss)' }}
                  strokeOpacity={0.5}
                  strokeDasharray="2 4"
                />
                <text className="axis-label" x={m.l + iw} y={zero + limit * scale - 5} textAnchor="end">
                  daily limit
                </text>
              </g>
            )}
            {days.map((d, i) => {
              const x = m.l + i * slot + (slot - bw) / 2;
              const hgt = Math.max(1.5, Math.abs(d.value) * scale);
              const up = d.value >= 0;
              const r = Math.min(4, bw / 2, hgt);
              // Rounded at the data end only, square at the baseline.
              const y0 = zero;
              const y1 = up ? zero - hgt : zero + hgt;
              const dpath = up
                ? `M${x},${y0}V${y1 + r}Q${x},${y1} ${x + r},${y1}H${x + bw - r}Q${x + bw},${y1} ${x + bw},${y1 + r}V${y0}Z`
                : `M${x},${y0}V${y1 - r}Q${x},${y1} ${x + r},${y1}H${x + bw - r}Q${x + bw},${y1} ${x + bw},${y1 - r}V${y0}Z`;
              return (
                <g key={d.day} onPointerEnter={() => setHover(i)} onPointerDown={() => setHover(i)}>
                  <rect x={m.l + i * slot} y={m.t} width={slot} height={ih} fill="transparent" />
                  <path d={dpath} style={{ fill: up ? 'var(--gain)' : 'var(--loss)' }} opacity={hover === null || hover === i ? 0.9 : 0.45} />
                </g>
              );
            })}
            {[0, days.length - 1].map((i, k) => (
              <text
                key={k}
                className="axis-label"
                x={m.l + i * slot + slot / 2}
                y={height - 5}
                textAnchor={k === 0 ? 'start' : 'end'}
              >
                {new Date(days[i].day).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
              </text>
            ))}
          </>
        )}
      </svg>
      {h && hover !== null && (
        <div
          className="chart-tip"
          style={{
            left: m.l + hover * slot + slot / 2,
            transform: hover > days.length / 2 ? 'translateX(-105%)' : 'translateX(5%)',
            top: 0,
            minWidth: 120,
          }}
        >
          <div className="t-date">{new Date(h.day).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}</div>
          <div className="t-row">
            <span>Result</span>
            <b className={h.value >= 0 ? 'gain' : 'loss'}>{format(h.value)}</b>
          </div>
        </div>
      )}
    </div>
  );
}

/** Tiny inline sparkline for comparison tables. */
export function Spark({ points, color, width = 96, height = 28 }: { points: [number, number][]; color: string; width?: number; height?: number }) {
  if (points.length < 2) return null;
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const d = points
    .map(([x, y], i) => `${i ? 'L' : 'M'}${(((x - x0) / (x1 - x0 || 1)) * (width - 2) + 1).toFixed(1)},${(height - 2 - ((y - y0) / (y1 - y0 || 1)) * (height - 4)).toFixed(1)}`)
    .join('');
  return (
    <svg width={width} height={height} aria-hidden="true" style={{ display: 'block' }}>
      <path d={d} fill="none" style={{ stroke: color }} strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
