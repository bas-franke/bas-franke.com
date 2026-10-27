import { useMemo } from 'react';
import { api } from '../api';
import { LineChart, type LineSeries } from '../components/charts';
import { ErrorBox, Skeleton, useAsync } from '../components/ui';
import { eur } from '../format';
import { navigate, useLocation } from '../router';
import type { Writeup, WriteupChart, WriteupSection } from '../types';

// A long-form explanation of one strategy (SPEC §8b): /writeup?spec=<spec id>. The content is stored in the database.

const COLORS: Record<string, string> = {
  ink: 'var(--ink)', ink2: 'var(--ink-2)', ink3: 'var(--ink-3)', brass: 'var(--brass)', s2: 'var(--s2)', loss: 'var(--loss)', gain: 'var(--gain)',
};
const color = (c?: string) => (c ? (COLORS[c] ?? c) : 'var(--ink)');
const FORMATS: Record<string, (v: number) => string> = {
  eur: (v) => `€${Math.round(v).toLocaleString('en-US')}`,
  num3: (v) => v.toFixed(3),
  pct: (v) => `${Math.round(v)}%`,
};

export default function WriteupPage() {
  const { query } = useLocation();
  const id = query.get('spec') ?? '';
  const w = useAsync(() => api.writeup(id), [id]);
  return (
    <div className="stack writeup" style={{ gap: 22 }}>
      <div className="page-head">
        <div>
          <span className="eyebrow">
            <a href="/research" onClick={(e) => (e.preventDefault(), navigate('/research?bucket=mixed'))}>
              ← Research
            </a>
          </span>
          <h1>{w.data?.title ?? 'Strategy write-up'}</h1>
          {w.data?.subtitle && <p className="lede">{w.data.subtitle}</p>}
        </div>
      </div>
      {w.error && <ErrorBox error={w.error} onRetry={w.reload} />}
      {!w.data && !w.error && <Skeleton h={400} />}
      {w.data && <Toc doc={w.data} />}
      {w.data?.sections.map((s, i) => <Section key={i} s={s} n={i} />)}
    </div>
  );
}

function Toc({ doc }: { doc: Writeup }) {
  const examples = doc.sections.filter((s) => s.type === 'example');
  if (!examples.length) return null;
  return (
    <nav className="card quiet writeup-toc" aria-label="Examples">
      <div className="eyebrow">Examples in this write-up</div>
      <ol>
        {examples.map((s) => (
          <li key={s.key}>
            <a href={`#ex-${s.key}`}>{s.title}</a> <span className={`chip ${s.trades ? 'brass' : 'outline'}`}>{s.trades ? 'trades' : 'no trade'}</span>
          </li>
        ))}
      </ol>
    </nav>
  );
}

function Paragraphs({ text }: { text?: string }) {
  if (!text) return null;
  return (
    <>
      {text.split(/\n\n+/).map((p, i) => (
        <p key={i}>{p}</p>
      ))}
    </>
  );
}

function Section({ s, n }: { s: WriteupSection; n: number }) {
  switch (s.type) {
    case 'heading':
      return (
        <div style={{ marginTop: 14 }}>
          <h2 className="writeup-h">{s.title}</h2>
          <Paragraphs text={s.body} />
        </div>
      );
    case 'text':
      return (
        <section className="card">
          <h2>{s.title}</h2>
          <div className="writeup-text">
            <Paragraphs text={s.body} />
          </div>
        </section>
      );
    case 'callout':
      return (
        <div className={`callout ${s.tone === 'gain' ? 'gain' : s.tone === 'warn' ? 'loss' : 'brass'}`}>
          <b>{s.title}</b>
          <Paragraphs text={s.body} />
        </div>
      );
    case 'rules':
      return (
        <section className="card">
          <h2>{s.title}</h2>
          <dl className="writeup-rules">
            {(s.items ?? []).map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </section>
      );
    case 'table':
      return (
        <section className="card">
          <h2>{s.title}</h2>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>{(s.head ?? []).map((h) => <th key={h}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {(s.rows ?? []).map((r, i) => (
                  <tr key={i}>
                    {r.map((c, j) => (
                      <td key={j}>{c}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      );
    case 'candles':
      return (
        <section className="card">
          <h2>{s.title}</h2>
          <Candles candles={s.candles ?? []} />
          <Paragraphs text={s.body} />
        </section>
      );
    case 'example':
      return <Example s={s} n={n} />;
    default:
      return null;
  }
}

/** Three hand-drawn daily candles with their wicks labelled. */
function Candles({ candles }: { candles: NonNullable<WriteupSection['candles']> }) {
  const lo = Math.min(...candles.map((c) => c.l));
  const hi = Math.max(...candles.map((c) => c.h));
  const H = 180;
  const y = (v: number) => 12 + ((hi - v) / (hi - lo || 1)) * (H - 24);
  return (
    <div className="writeup-candles">
      {candles.map((c) => {
        const up = c.c >= c.o;
        const col = up ? 'var(--gain)' : 'var(--loss)';
        return (
          <figure key={c.label}>
            <svg viewBox={`0 0 80 ${H}`} width="80" height={H} role="img" aria-label={`${c.label}: ${c.note}`}>
              <line x1="40" x2="40" y1={y(c.h)} y2={y(c.l)} stroke={col} strokeWidth="2" />
              <rect x="25" width="30" y={y(Math.max(c.o, c.c))} height={Math.max(2, Math.abs(y(c.o) - y(c.c)))} fill={col} rx="2" />
            </svg>
            <figcaption>
              <b>{c.label}</b>
              <span className="small soft">{c.note}</span>
            </figcaption>
          </figure>
        );
      })}
    </div>
  );
}

/** Position change points -> a step line (each level held until the next change). */
function stepPoints(points: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  points.forEach(([t, v], i) => {
    if (i > 0) out.push([t, points[i - 1][1]]);
    out.push([t, v]);
  });
  return out;
}

function Chart({ c }: { c: WriteupChart }) {
  const series: LineSeries[] = useMemo(
    () => c.series.map((s) => ({ name: s.name, color: color(s.color), dash: s.dash, points: s.points, width: 1.8 })),
    [c],
  );
  return (
    <div className="writeup-chart">
      <div className="eyebrow">{c.title}</div>
      <LineChart series={series} height={c.height ?? 200} ariaLabel={c.title} yFormat={FORMATS[c.yFormat ?? 'eur'] ?? FORMATS.eur} legend={series.length > 1} />
      {c.band && (
        <>
          <div className="tiny soft" style={{ marginTop: 6 }}>Share of the portfolio in ETH</div>
          <LineChart
            series={[{ name: 'in ETH', color: 'var(--brass)', area: true, points: stepPoints(c.band.points), width: 2 }]}
            height={80}
            legend={false}
            baseline={0}
            ariaLabel="Share of the portfolio in ETH"
            yFormat={(v) => (v > 100.5 || v < -0.5 ? '' : `${Math.round(v)}%`)}
          />
        </>
      )}
    </div>
  );
}

function Example({ s, n }: { s: WriteupSection; n: number }) {
  const r = s.result;
  return (
    <section className="card writeup-example" id={`ex-${s.key}`}>
      <div className="row" style={{ gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <h2 style={{ marginRight: 'auto' }}>{s.title}</h2>
        <span className={`chip ${s.trades ? 'brass' : 'outline'}`}>{s.trades ? 'trades' : 'no trade'}</span>
      </div>
      {s.eli5 && <p className="notes">“{s.eli5}”</p>}
      <Paragraphs text={s.story} />
      <div className="writeup-charts">{(s.charts ?? []).map((c, i) => <Chart key={`${n}-${i}`} c={c} />)}</div>
      <div className="writeup-outcome">
        <div>
          <div className="eyebrow">What the bot does here</div>
          {s.events && s.events.length ? (
            <ul>
              {s.events.map((e) => (
                <li key={e.ts}>
                  <span className="mono small soft">{new Date(e.ts).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} UTC</span>{' '}
                  {e.text}
                </li>
              ))}
            </ul>
          ) : (
            <p className="small">Nothing: no orders in this stretch (it {s.startPosition ? 'keeps holding ETH' : 'stays in euros'}).</p>
          )}
        </div>
        {r && (
          <div>
            <div className="eyebrow">€1,000 at the start of this stretch</div>
            <p className="small">
              Strategy <b className={r.strategy >= r.hold ? 'gain' : 'loss'}>{eur(r.strategy)}</b> · holding ETH <b>{eur(r.hold)}</b>
            </p>
          </div>
        )}
      </div>
      {s.verdict && <div className="callout brass">{s.verdict}</div>}
    </section>
  );
}
