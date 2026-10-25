import { useId, useState, type ReactNode } from 'react';
import Art from './Art';
import { full, type Delta } from './format';
import { RANGES, setDays } from './router';
import type { Fix } from './types';

/** A dashboard section: icon + title row, optional actions, and an optional Chart/Table toggle. */
export function Panel({
  icon,
  title,
  subtitle,
  actions,
  table,
  className = '',
  children,
}: {
  icon?: string;
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  /** When given, the panel offers the same numbers as a table, one click away. */
  table?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const id = useId();
  return (
    <section className={`panel ${className}`} aria-labelledby={id}>
      <header className="panel-head">
        {icon && <Art name={icon} className="panel-icon" />}
        <div className="panel-title">
          <h2 id={id}>{title}</h2>
          {subtitle && <span className="muted">{subtitle}</span>}
        </div>
        <div className="panel-actions">
          {actions}
          {table && (
            <Seg
              label={`Show ${title} as`}
              small
              value={view}
              options={[
                { value: 'chart', label: 'Chart' },
                { value: 'table', label: 'Table' },
              ]}
              onChange={setView}
            />
          )}
        </div>
      </header>
      {table && view === 'table' ? table : children}
    </section>
  );
}

/** A segmented control (pressed-button group). */
export function Seg<T extends string | number>({
  label,
  value,
  options,
  onChange,
  small = false,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; title?: string }[];
  onChange: (value: T) => void;
  small?: boolean;
}) {
  return (
    <span className={`seg${small ? ' small' : ''}`} role="group" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.value)} type="button" className={value === o.value ? 'on' : ''} aria-pressed={value === o.value} title={o.title} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </span>
  );
}

export function RangePicker({ days }: { days: number }) {
  return (
    <Seg
      label="Show visitor numbers for the last"
      value={days}
      options={RANGES.map((r) => ({ value: r.days, label: r.label, title: `Last ${r.long}` }))}
      onChange={setDays}
    />
  );
}

export function DeltaPill({ delta, title }: { delta?: Delta; title?: string }) {
  if (!delta) return null;
  const arrow = delta.dir === 'up' ? '↑' : delta.dir === 'down' ? '↓' : '→';
  return (
    <span className={`delta delta-${delta.tone}`} title={title}>
      {delta.text !== 'new' && <span aria-hidden="true">{arrow}</span>}
      {delta.text}
    </span>
  );
}

export type Cell = string | number | { text: string; node?: ReactNode; title?: string; className?: string };

export function DataTable({ head, rows, mono = false, caption }: { head: string[]; rows: Cell[][]; mono?: boolean; caption?: string }) {
  return (
    <div className="table-wrap">
      <table className="atable">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={h} scope="col" className={i ? 'num' : ''}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => {
                if (typeof cell === 'number') {
                  return (
                    <td key={j} className="num">
                      {full(cell)}
                    </td>
                  );
                }
                const c = typeof cell === 'string' ? { text: cell } : cell;
                return (
                  <td key={j} className={c.className ?? (j ? 'num' : mono ? 'path' : '')} title={c.title ?? (j ? undefined : c.text)}>
                    {c.node ?? c.text}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export interface BarRow {
  key: string;
  label: ReactNode;
  /** Plain-text label for the title/tooltip. */
  text?: string;
  value: number;
  /** Optional second number shown muted (e.g. views next to visitors). */
  extra?: string;
}

/**
 * Ranked list with a soft bar behind each label (length = share of the top row) and the number plus share on the
 * right. Long lists collapse to `limit` rows with a "Show all" toggle.
 */
export function BarList({ rows, total, limit = 8, unit = 'visitors', empty = 'Nothing in this period.' }: { rows: BarRow[]; total?: number; limit?: number; unit?: string; empty?: string }) {
  const [all, setAll] = useState(false);
  if (!rows.length || rows.every((r) => r.value === 0)) return <p className="muted small empty-line">{empty}</p>;
  const max = Math.max(...rows.map((r) => r.value));
  const sum = total ?? rows.reduce((s, r) => s + r.value, 0);
  const shown = all ? rows : rows.slice(0, limit);
  return (
    <>
      <ul className="barlist">
        {shown.map((r) => {
          const share = sum ? r.value / sum : 0;
          return (
            <li key={r.key} title={`${r.text ?? r.key}: ${full(r.value)} ${unit} (${Math.round(share * 100)}%)`}>
              <span className="bl-bar" style={{ width: `${max ? (r.value / max) * 100 : 0}%` }} />
              <span className="bl-label">{r.label}</span>
              {r.extra && <span className="bl-extra">{r.extra}</span>}
              <span className="bl-value">{full(r.value)}</span>
              <span className="bl-share">{Math.round(share * 100)}%</span>
            </li>
          );
        })}
      </ul>
      {rows.length > limit && (
        <button type="button" className="link-btn" onClick={() => setAll(!all)} aria-expanded={all}>
          {all ? 'Show fewer' : `Show all ${rows.length}`}
        </button>
      )}
    </>
  );
}

export function Skeleton({ height = 16, width = '100%', className = '' }: { height?: number; width?: number | string; className?: string }) {
  return <span className={`skeleton ${className}`} style={{ height, width }} aria-hidden="true" />;
}

export function StateCard({ art, title, children, compact = false }: { art?: string; title: string; children?: ReactNode; compact?: boolean }) {
  return (
    <section className={`state-card${compact ? ' state-compact' : ''}`}>
      {art && <Art name={art} className="state-art" />}
      <h2>{title}</h2>
      {children}
    </section>
  );
}

/** Shown while the status backend has no database: page views are dropped until it gets one. */
export function AnalyticsSetup({ detail, fix }: { detail?: string; fix?: Fix }) {
  return (
    <section className="analytics-setup">
      <p>
        <strong>Visitor analytics are off.</strong> <span className="muted">{detail}</span>
      </p>
      {fix && <FixBlock fix={fix} open={false} />}
    </section>
  );
}

export function FixBlock({ fix, open }: { fix: Fix; open: boolean }) {
  return (
    <details className="fix" open={open}>
      <summary>
        <span className="fix-label">How to fix</span> {fix.summary}
      </summary>
      <ol>
        {fix.steps.map((step, i) => (
          <li key={i}>
            <p>{step.text}</p>
            {step.code && <CodeBlock code={step.code} />}
          </li>
        ))}
      </ol>
      {fix.doc && (
        <a className="doc-link" href={fix.doc} target="_blank" rel="noreferrer">
          Full instructions ↗
        </a>
      )}
    </details>
  );
}

function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="code">
      <pre>{code}</pre>
      <button
        type="button"
        className="copy"
        onClick={() =>
          navigator.clipboard.writeText(code).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
        }
      >
        {copied ? 'Copied ✓' : 'Copy'}
      </button>
    </div>
  );
}
