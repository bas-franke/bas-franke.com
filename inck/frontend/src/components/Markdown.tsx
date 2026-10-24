import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { Fragment, useMemo } from 'react';
import type { Chart as ChartData } from '../types';
import Chart from './Chart';

marked.setOptions({ gfm: true, breaks: false });

const MARKER = /^\s*\[\[chart:(\d+)\]\]\s*$/m;

/** Renders article Markdown, replacing [[chart:N]] lines with real charts. */
export default function Markdown({ markdown, charts }: { markdown: string; charts: ChartData[] }) {
  const parts = useMemo(() => {
    const out: ({ html: string } | { chart: ChartData })[] = [];
    const used = new Set<number>();
    const chunks = markdown.split(/^\s*(\[\[chart:\d+\]\])\s*$/m);
    for (const chunk of chunks) {
      const m = chunk.match(MARKER);
      if (m) {
        const chart = charts[Number(m[1]) - 1];
        if (chart) {
          out.push({ chart });
          used.add(Number(m[1]) - 1);
        }
      } else if (chunk.trim()) {
        out.push({ html: DOMPurify.sanitize(marked.parse(chunk) as string, { ADD_ATTR: ['target'] }) });
      }
    }
    // Charts the writer forgot to place still get shown, at the end.
    charts.forEach((chart, i) => {
      if (!used.has(i)) out.push({ chart });
    });
    return out;
  }, [markdown, charts]);

  return (
    <div className="prose">
      {parts.map((p, i) => (
        <Fragment key={i}>{'chart' in p ? <Chart chart={p.chart} /> : <div dangerouslySetInnerHTML={{ __html: p.html }} />}</Fragment>
      ))}
    </div>
  );
}
