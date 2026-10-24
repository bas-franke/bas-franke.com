import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { Fragment, useMemo } from 'react';
import { mediaUrl } from '../api';
import type { ArticleImage, Chart as ChartData } from '../types';
import Chart from './Chart';

marked.setOptions({ gfm: true, breaks: false });

const MARKER = /^\s*\[\[(chart|image):(\d+)\]\]\s*$/m;

type Part = { html: string } | { chart: ChartData } | { image: ArticleImage };

/**
 * Normalises writer output: a marker glued into a heading or sentence moves to its own line
 * (so "## [[chart:1]] Title" becomes a chart followed by "## Title").
 */
function normalise(markdown: string) {
  return markdown.replace(/^(#{1,6}\s*)?(.*?)\s*(\[\[(?:chart|image):\d+\]\])\s*(.*)$/gm, (line, hashes, before, marker, after) => {
    if (!before && !after) return line; // already standalone
    const rest = `${before}${after}`.trim();
    return `${marker}\n\n${rest ? `${hashes ?? ''}${rest}` : ''}`;
  });
}

/** Renders article Markdown, replacing [[chart:N]] and [[image:N]] lines with real charts and figures. */
export default function Markdown({ markdown, charts, images = [] }: { markdown: string; charts: ChartData[]; images?: ArticleImage[] }) {
  const parts = useMemo(() => {
    const out: Part[] = [];
    const usedCharts = new Set<number>();
    const usedImages = new Set<number>();
    const chunks = normalise(markdown).split(/^\s*(\[\[(?:chart|image):\d+\]\])\s*$/m);
    for (const chunk of chunks) {
      const m = chunk.match(MARKER);
      if (m) {
        const index = Number(m[2]) - 1;
        if (m[1] === 'chart') {
          const chart = charts[index];
          if (chart && !usedCharts.has(index)) {
            out.push({ chart });
            usedCharts.add(index);
          }
        } else {
          // Image 1 is the cover, shown above the article, never inline. Each figure shows once.
          const image = index > 0 ? images[index] : undefined;
          if (image && !usedImages.has(index)) {
            out.push({ image });
            usedImages.add(index);
          }
        }
      } else if (chunk.trim()) {
        out.push({ html: DOMPurify.sanitize(marked.parse(chunk) as string, { ADD_ATTR: ['target'] }) });
      }
    }
    // Charts the writer forgot to place still get shown, at the end.
    charts.forEach((chart, i) => {
      if (!usedCharts.has(i)) out.push({ chart });
    });
    return out;
  }, [markdown, charts, images]);

  return (
    <div className="prose">
      {parts.map((p, i) => (
        <Fragment key={i}>
          {'chart' in p ? (
            <Chart chart={p.chart} />
          ) : 'image' in p ? (
            <figure className="figure">
              <img src={mediaUrl(p.image.file) ?? ''} alt={p.image.alt} loading="lazy" />
              {p.image.caption && <figcaption>{p.image.caption}</figcaption>}
            </figure>
          ) : (
            <div dangerouslySetInnerHTML={{ __html: p.html }} />
          )}
        </Fragment>
      ))}
    </div>
  );
}
