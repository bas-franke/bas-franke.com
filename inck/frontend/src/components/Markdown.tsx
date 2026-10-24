import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { Fragment, useMemo } from 'react';
import { mediaUrl } from '../api';
import type { ArticleImage, Chart as ChartData } from '../types';
import Chart from './Chart';

marked.setOptions({ gfm: true, breaks: false });

const MARKER = /^\s*\[\[(chart|image):(\d+)\]\]\s*$/m;

type Part = { html: string } | { chart: ChartData } | { image: ArticleImage };

/** Renders article Markdown, replacing [[chart:N]] and [[image:N]] lines with real charts and figures. */
export default function Markdown({ markdown, charts, images = [] }: { markdown: string; charts: ChartData[]; images?: ArticleImage[] }) {
  const parts = useMemo(() => {
    const out: Part[] = [];
    const usedCharts = new Set<number>();
    const chunks = markdown.split(/^\s*(\[\[(?:chart|image):\d+\]\])\s*$/m);
    for (const chunk of chunks) {
      const m = chunk.match(MARKER);
      if (m) {
        const index = Number(m[2]) - 1;
        if (m[1] === 'chart') {
          const chart = charts[index];
          if (chart) {
            out.push({ chart });
            usedCharts.add(index);
          }
        } else {
          // Image 1 is the cover, shown above the article, never inline.
          const image = index > 0 ? images[index] : undefined;
          if (image) out.push({ image });
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
