import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { compact, full, hourText, WEEKDAYS } from './format';

/**
 * Small hand-rolled SVG charts for the analytics pages: a multi-series line chart, a single-series bar chart,
 * a sparkline and a weekday x hour heatmap, all but the sparkline with a hover/keyboard tooltip. Marks follow the
 * house rules: 2px lines, 4px rounded bar caps, hairline grid, text in ink colours (never the series colour),
 * selective direct labels only, a sequential single-hue ramp for magnitude.
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
  /** One value per series; null is a gap (no data that day), not a zero. */
  values: (number | null)[];
}

/** How a chart prints its numbers: `tick` on the axis and direct labels, `value` in the tooltip. */
export interface Formats {
  tick?: (n: number) => string;
  value?: (n: number) => string;
  /** Pick y steps that read well as durations (values in seconds) rather than 1-2-5. */
  seconds?: boolean;
}

const HEIGHT = 190;
const PAD = { top: 14, bottom: 26, left: 8, right: 8 };
const TIME_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];

/** Y axis in 1-2-5 steps (or duration-friendly steps), so ticks stay whole numbers. */
function yScale(max: number, seconds = false) {
  if (max < 4 && !seconds) return { top: 4, ticks: [0, 1, 2, 3, 4] };
  const raw = Math.max(max, 1) / 4;
  let step: number;
  if (seconds) {
    step = TIME_STEPS.find((s) => s >= raw) ?? Math.ceil(raw / 3600) * 3600;
  } else {
    const pow = 10 ** Math.floor(Math.log10(raw));
    const n = raw / pow;
    step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
  }
  const top = Math.max(step, Math.ceil(max / step) * step);
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

function ChartTooltip({ x, width, title, rows, top = 6 }: { x: number; width: number; title: string; rows: { name: string; color?: string; value: string }[]; top?: number }) {
  return (
    <div className={`chart-tooltip${x > width * 0.6 ? ' flip' : ''}`} style={{ left: x, top }} role="status">
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

export function LineChart({ points, series, label, format = {} }: { points: Point[]; series: Series[]; label: string; format?: Formats }) {
  const [ref, width] = useWidth();
  const [active, setActive] = useState<number | null>(null);
  const tick = format.tick ?? compact;
  const value = format.value ?? full;
  const n = points.length;
  const max = Math.max(0, ...points.flatMap((p) => p.values.filter((v): v is number => v !== null)));
  const { top, ticks } = yScale(max, format.seconds);
  const left = PAD.left + Math.max(...ticks.map((t) => tick(t).length)) * 6.5 + 8;
  const right = PAD.right + 34;
  const plotW = Math.max(0, width - left - right);
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const x = (i: number) => left + (n > 1 ? (i / (n - 1)) * plotW : plotW / 2);
  const y = (v: number) => PAD.top + plotH - (v / top) * plotH;
  const step = labelStep(n);
  const lastIdx = n - 1;

  // Nulls break the line, so a day without data never reads as a zero.
  const paths = series.map((_, s) => {
    let d = '';
    let pen = false;
    points.forEach((p, i) => {
      const v = p.values[s];
      if (v === null) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)} `;
      pen = true;
    });
    return d.trim();
  });
  const hasGaps = points.some((p) => p.values.some((v) => v === null));

  // End labels: one per series on its last value, unless they would overlap; then only the higher one keeps it.
  const ends = series.map((_, s) => {
    let i = lastIdx;
    while (i >= 0 && points[i].values[s] === null) i--;
    const v = i >= 0 ? (points[i].values[s] as number) : null;
    return { s, i, value: v, yy: v === null ? 0 : y(v) };
  });
  const labelled = new Set<number>();
  let previousY = -Infinity;
  for (const end of ends.filter((e) => e.value !== null).sort((a, b) => a.yy - b.yy)) {
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
                {tick(t)}
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
          {series.length === 1 && n > 1 && !hasGaps && (
            <path d={`${paths[0]} L${x(lastIdx).toFixed(1)},${y(0)} L${x(0).toFixed(1)},${y(0)} Z`} className="area" style={{ fill: series[0].color }} />
          )}
          {series.map((s, si) => (
            <path key={si} d={paths[si]} className="line" style={{ stroke: s.color }} />
          ))}
          {ends.map((end) =>
            end.value === null ? null : <circle key={end.s} cx={x(end.i)} cy={end.yy} r={4} className="dot" style={{ fill: series[end.s].color }} />,
          )}
          {ends
            .filter((end) => labelled.has(end.s) && end.value !== null)
            .map((end) => (
              <text key={end.s} x={x(end.i) + 9} y={end.yy} className="end-label" dominantBaseline="middle">
                {tick(end.value as number)}
              </text>
            ))}
          {active !== null && (
            <g>
              <line x1={x(active)} x2={x(active)} y1={PAD.top} y2={PAD.top + plotH} className="crosshair" />
              {series.map((s, si) => {
                const v = points[active].values[si];
                return v === null ? null : <circle key={si} cx={x(active)} cy={y(v)} r={4} className="dot" style={{ fill: s.color }} />;
              })}
            </g>
          )}
        </svg>
      )}
      {active !== null && (
        <ChartTooltip
          x={x(active)}
          width={width}
          title={points[active].title}
          rows={series.map((s, si) => {
            const v = points[active].values[si];
            return { name: s.name, color: s.color, value: v === null ? 'no data' : value(v) };
          })}
        />
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

export function BarChart({ points, name, label, format = {} }: { points: Point[]; name: string; label: string; format?: Formats }) {
  const [ref, width] = useWidth();
  const [active, setActive] = useState<number | null>(null);
  const tick = format.tick ?? compact;
  const value = format.value ?? full;
  const n = points.length;
  const values = points.map((p) => p.values[0] ?? 0);
  const max = Math.max(0, ...values);
  const { top, ticks } = yScale(max, format.seconds);
  const left = PAD.left + Math.max(...ticks.map((t) => tick(t).length)) * 6.5 + 8;
  const right = PAD.right + 4;
  const plotW = Math.max(0, width - left - right);
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const slot = n ? plotW / n : 0;
  const barW = Math.min(32, Math.max(3, slot * 0.6));
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
                {tick(t)}
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
                {tick(values[i])}
              </text>
            ) : null,
          )}
          {/* Hit targets cover the whole slot, so the pointer never has to land on the bar itself. */}
          {points.map((_, i) => (
            <rect key={`hit-${i}`} x={left + i * slot} y={PAD.top} width={slot} height={plotH} className="hit" onPointerEnter={() => setActive(i)} />
          ))}
        </svg>
      )}
      {active !== null && <ChartTooltip x={x(active) + barW / 2} width={width} title={points[active].title} rows={[{ name, value: value(values[active]) }]} />}
    </div>
  );
}

/** A tiny trend line for cards. Decorative: the numbers next to it carry the meaning. */
export function Sparkline({ values, className = '' }: { values: number[]; className?: string }) {
  const n = values.length;
  const W = 100;
  const H = 32;
  const max = Math.max(1, ...values);
  const x = (i: number) => (n > 1 ? (i / (n - 1)) * W : W / 2);
  const y = (v: number) => H - 2 - (v / max) * (H - 4);
  const line = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(2)},${y(v).toFixed(2)}`).join(' ');
  return (
    <svg className={`sparkline ${className}`} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
      {n > 1 && <path d={`${line} L${W},${H} L0,${H} Z`} className="spark-area" />}
      {n > 1 && <path d={line} className="spark-line" vectorEffect="non-scaling-stroke" />}
    </svg>
  );
}

/** Sequential steps (one hue, light to dark) for the heatmap; step 0 is "none". */
const HEAT_STEPS = 5;
const heatStep = (v: number, max: number) => (v <= 0 || max <= 0 ? 0 : Math.min(HEAT_STEPS, Math.ceil((v / max) * HEAT_STEPS)));

/**
 * Page views by weekday x hour as a CSS grid of cells. Focus the grid and use the arrow keys to walk the cells;
 * hovering shows the same tooltip.
 */
export function Heatmap({ data, label, unit = 'views' }: { data: number[][]; label: string; unit?: string }) {
  const [active, setActive] = useState<[number, number] | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const max = Math.max(0, ...data.flat());

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') return setActive(null);
    const moves: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    const move = moves[e.key];
    if (!move) return;
    e.preventDefault();
    if (!active) return setActive([0, 0]);
    const [d, h] = active;
    setActive([Math.max(0, Math.min(data.length - 1, d + move[0])), Math.max(0, Math.min(23, h + move[1]))]);
  };

  let tip: { left: number; top: number; flip: boolean } | null = null;
  if (active && ref.current) {
    const cell = ref.current.querySelector<HTMLElement>(`[data-cell="${active[0]}-${active[1]}"]`);
    if (cell) {
      tip = { left: cell.offsetLeft + cell.offsetWidth / 2, top: cell.offsetTop + cell.offsetHeight + 6, flip: active[1] > 14 };
    }
  }

  return (
    <div className="heatmap-wrap" ref={ref} onPointerLeave={() => setActive(null)}>
      <div className="heatmap" role="img" aria-label={label} tabIndex={0} onKeyDown={onKeyDown} onBlur={() => setActive(null)}>
        {data.map((row, d) => (
          <div className="heat-row" key={d}>
            <span className="heat-day" aria-hidden="true">
              {WEEKDAYS[d].slice(0, 3)}
            </span>
            {row.map((v, h) => (
              <span
                key={h}
                data-cell={`${d}-${h}`}
                className={`heat-cell heat-${heatStep(v, max)}${active && active[0] === d && active[1] === h ? ' heat-active' : ''}`}
                onPointerEnter={() => setActive([d, h])}
              />
            ))}
          </div>
        ))}
        <div className="heat-row heat-hours" aria-hidden="true">
          <span className="heat-day" />
          {Array.from({ length: 24 }, (_, h) => (
            <span key={h} className="heat-hour">
              {h % 6 === 0 ? hourText(h).slice(0, 2) : ''}
            </span>
          ))}
        </div>
      </div>
      {active && tip && (
        <div className={`chart-tooltip heat-tip${tip.flip ? ' flip' : ''}`} style={{ left: tip.left, top: tip.top }} role="status">
          <div className="tt-title">
            {WEEKDAYS[active[0]]} {hourText(active[1])}–{hourText((active[1] + 1) % 24)}
          </div>
          <div className="tt-row">
            <span className="tt-value">{full(data[active[0]][active[1]])}</span>
            <span className="tt-name">{unit}</span>
          </div>
        </div>
      )}
      <div className="heat-legend" aria-hidden="true">
        <span>Less</span>
        {Array.from({ length: HEAT_STEPS + 1 }, (_, i) => (
          <span key={i} className={`heat-cell heat-${i}`} />
        ))}
        <span>More</span>
      </div>
    </div>
  );
}
