import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

/**
 * Small hand-rolled SVG charts for the analytics panels: a multi-series line chart and a single-series bar
 * chart, both with a hover/keyboard tooltip. Marks follow the house rules: 2px lines, 4px rounded bar caps,
 * hairline grid, text in ink colours (never the series colour), selective direct labels only.
 */

export interface Series {
  name: string;
  /** A CSS colour, normally one of the --series-N tokens. */
  color: string;
}

export interface Point {
  /** Short axis label ("24 Oct"). */
  label: string;
  /** Full label for the tooltip ("Fri 24 Oct 2026"). */
  title: string;
  /** One value per series. */
  values: number[];
}

export const compact = (n: number) =>
  n >= 1_000_000 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}K` : String(n);

export const full = (n: number) => n.toLocaleString('en');

const HEIGHT = 190;
const PAD = { top: 14, bottom: 26, left: 8, right: 8 };

/** Y axis in 1-2-5 steps, so ticks for counts stay whole numbers. */
function yScale(max: number) {
  if (max < 4) return { top: 4, ticks: [0, 1, 2, 3, 4] };
  const raw = max / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const n = raw / pow;
  const step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(v);
  return { top, ticks };
}

/** Show about six x labels, always including the first. */
const labelStep = (n: number) => Math.max(1, Math.ceil(n / 6));

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(el);
    setWidth(el.clientWidth);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/** Arrow keys walk the data points; Escape clears. Returns the new index or null. */
function stepIndex(e: KeyboardEvent, active: number | null, n: number) {
  if (e.key === 'Escape') return null;
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return active;
  e.preventDefault();
  if (active === null) return e.key === 'ArrowRight' ? 0 : n - 1;
  return Math.max(0, Math.min(n - 1, active + (e.key === 'ArrowRight' ? 1 : -1)));
}

function ChartTooltip({ x, width, title, rows }: { x: number; width: number; title: string; rows: { name: string; color?: string; value: string }[] }) {
  return (
    <div className={`chart-tooltip${x > width * 0.6 ? ' flip' : ''}`} style={{ left: x }} role="status">
      <div className="tt-title">{title}</div>
      {rows.map((r) => (
        <div key={r.name} className="tt-row">
          {r.color && <span className="tt-key" style={{ background: r.color }} />}
          <span className="tt-value">{r.value}</span>
          <span className="tt-name">{r.name}</span>
        </div>
      ))}
    </div>
  );
}

export function LineChart({ points, series, label }: { points: Point[]; series: Series[]; label: string }) {
  const [ref, width] = useWidth();
  const [active, setActive] = useState<number | null>(null);
  const n = points.length;
  const max = Math.max(0, ...points.flatMap((p) => p.values));
  const { top, ticks } = yScale(max);
  const left = PAD.left + compact(top).length * 7 + 8;
  const right = PAD.right + 34;
  const plotW = Math.max(0, width - left - right);
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const x = (i: number) => left + (n > 1 ? (i / (n - 1)) * plotW : plotW / 2);
  const y = (v: number) => PAD.top + plotH - (v / top) * plotH;
  const step = labelStep(n);
  const lastIdx = n - 1;

  const paths = series.map((_, s) => points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.values[s]).toFixed(1)}`).join(' '));

  // End labels: one per series, unless they would overlap; then only the higher one keeps its label.
  const ends = series.map((_, s) => ({ s, value: points[lastIdx]?.values[s] ?? 0, yy: y(points[lastIdx]?.values[s] ?? 0) }));
  const labelled = new Set<number>();
  let previousY = -Infinity;
  for (const end of [...ends].sort((a, b) => a.yy - b.yy)) {
    if (end.yy - previousY >= 14) {
      labelled.add(end.s);
      previousY = end.yy;
    }
  }

  const onPointerMove = (e: PointerEvent<SVGSVGElement>) => {
    if (n < 2 || plotW <= 0) return;
    const px = e.clientX - e.currentTarget.getBoundingClientRect().left;
    setActive(Math.max(0, Math.min(n - 1, Math.round(((px - left) / plotW) * (n - 1)))));
  };

  return (
    <div className="chart" ref={ref} onPointerLeave={() => setActive(null)}>
      {width > 0 && n > 0 && (
        <svg
          width={width}
          height={HEIGHT}
          role="img"
          aria-label={label}
          tabIndex={0}
          onPointerMove={onPointerMove}
          onKeyDown={(e) => setActive(stepIndex(e, active, n))}
          onBlur={() => setActive(null)}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line x1={left} x2={width - right} y1={y(t)} y2={y(t)} className={t === 0 ? 'axis' : 'grid'} />
              <text x={left - 8} y={y(t)} className="tick" textAnchor="end" dominantBaseline="middle">
                {compact(t)}
              </text>
            </g>
          ))}
          {points.map((p, i) =>
            i % step === 0 ? (
              <text key={i} x={x(i)} y={HEIGHT - 8} className="tick" textAnchor="middle">
                {p.label}
              </text>
            ) : null,
          )}
          {series.length === 1 && n > 1 && (
            <path d={`${paths[0]} L${x(lastIdx).toFixed(1)},${y(0)} L${x(0).toFixed(1)},${y(0)} Z`} className="area" style={{ fill: series[0].color }} />
          )}
          {series.map((s, si) => (
            <path key={si} d={paths[si]} className="line" style={{ stroke: s.color }} />
          ))}
          {series.map((s, si) => (
            <circle key={si} cx={x(lastIdx)} cy={ends[si].yy} r={4} className="dot" style={{ fill: s.color }} />
          ))}
          {ends
            .filter((end) => labelled.has(end.s))
            .map((end) => (
              <text key={end.s} x={x(lastIdx) + 9} y={end.yy} className="end-label" dominantBaseline="middle">
                {compact(end.value)}
              </text>
            ))}
          {active !== null && (
            <g>
              <line x1={x(active)} x2={x(active)} y1={PAD.top} y2={PAD.top + plotH} className="crosshair" />
              {series.map((s, si) => (
                <circle key={si} cx={x(active)} cy={y(points[active].values[si])} r={4} className="dot" style={{ fill: s.color }} />
              ))}
            </g>
          )}
        </svg>
      )}
      {active !== null && (
        <ChartTooltip x={x(active)} width={width} title={points[active].title} rows={series.map((s, si) => ({ name: s.name, color: s.color, value: full(points[active].values[si]) }))} />
      )}
      {series.length > 1 && (
        <ul className="legend">
          {series.map((s) => (
            <li key={s.name}>
              <span className="legend-line" style={{ background: s.color }} /> {s.name}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function BarChart({ points, name, label }: { points: Point[]; name: string; label: string }) {
  const [ref, width] = useWidth();
  const [active, setActive] = useState<number | null>(null);
  const n = points.length;
  const values = points.map((p) => p.values[0]);
  const max = Math.max(0, ...values);
  const { top, ticks } = yScale(max);
  const left = PAD.left + compact(top).length * 7 + 8;
  const right = PAD.right + 4;
  const plotW = Math.max(0, width - left - right);
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const slot = n ? plotW / n : 0;
  const barW = Math.min(24, Math.max(3, slot * 0.6));
  const x = (i: number) => left + i * slot + (slot - barW) / 2;
  const y = (v: number) => PAD.top + plotH - (v / top) * plotH;
  const base = y(0);
  const step = labelStep(n);

  // Direct labels only on the tallest bar and the current (last) one; tooltip and table carry the rest.
  const labelled = new Set(n ? [values.indexOf(max), n - 1] : []);
  // A tallest bar right next to the last one gets no label when the slots are too narrow for two.
  if (n > 1 && values.indexOf(max) === n - 2 && slot < 44) labelled.delete(n - 2);

  /** 4px rounded top corners, square at the baseline. */
  const barPath = (i: number) => {
    const h = base - y(values[i]);
    if (h <= 0) return '';
    const r = Math.min(4, h, barW / 2);
    const x0 = x(i);
    const yTop = base - h;
    return `M${x0},${base} V${yTop + r} Q${x0},${yTop} ${x0 + r},${yTop} H${x0 + barW - r} Q${x0 + barW},${yTop} ${x0 + barW},${yTop + r} V${base} Z`;
  };

  return (
    <div className="chart" ref={ref} onPointerLeave={() => setActive(null)}>
      {width > 0 && n > 0 && (
        <svg width={width} height={HEIGHT} role="img" aria-label={label} tabIndex={0} onKeyDown={(e) => setActive(stepIndex(e, active, n))} onBlur={() => setActive(null)}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={left} x2={width - right} y1={y(t)} y2={y(t)} className={t === 0 ? 'axis' : 'grid'} />
              <text x={left - 8} y={y(t)} className="tick" textAnchor="end" dominantBaseline="middle">
                {compact(t)}
              </text>
            </g>
          ))}
          {points.map((p, i) =>
            i % step === 0 ? (
              <text key={i} x={x(i) + barW / 2} y={HEIGHT - 8} className="tick" textAnchor="middle">
                {p.label}
              </text>
            ) : null,
          )}
          {points.map((_, i) => (
            <path key={i} d={barPath(i)} className={`bar${active === i ? ' bar-active' : ''}`} />
          ))}
          {points.map((_, i) =>
            labelled.has(i) && values[i] > 0 ? (
              <text key={`label-${i}`} x={x(i) + barW / 2} y={y(values[i]) - 5} className="cap-label" textAnchor="middle">
                {compact(values[i])}
              </text>
            ) : null,
          )}
          {/* Hit targets cover the whole slot, so the pointer never has to land on the bar itself. */}
          {points.map((_, i) => (
            <rect key={`hit-${i}`} x={left + i * slot} y={PAD.top} width={slot} height={plotH} className="hit" onPointerEnter={() => setActive(i)} />
          ))}
        </svg>
      )}
      {active !== null && <ChartTooltip x={x(active) + barW / 2} width={width} title={points[active].title} rows={[{ name, value: full(values[active]) }]} />}
    </div>
  );
}
