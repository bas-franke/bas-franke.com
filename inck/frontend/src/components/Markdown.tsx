import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { useMemo } from 'react';

marked.setOptions({ gfm: true, breaks: false });

/** Renders a story body: a handful of short Markdown paragraphs, sanitised. */
export default function Markdown({ markdown, className = 'prose' }: { markdown: string; className?: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(markdown) as string, { FORBID_TAGS: ['img', 'a'] }), [markdown]);
  return <div className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}
