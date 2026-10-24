export interface Source {
  title: string;
  url: string;
}

const normaliseUrl = (u: string) => u.trim().replace(/\/+$/, '').toLowerCase();

/**
 * Presentation-side safety net (older articles, or a writer that ignored the rules): links and bare URLs in the
 * body become numbered citations "[n]" pointing at the source list, which grows with any URL it did not have.
 */
export function applyCitations(markdown: string, sources: Source[]) {
  const list = sources.map((s) => ({ ...s }));
  const indexOf = (url: string, title: string) => {
    const key = normaliseUrl(url);
    let i = list.findIndex((s) => normaliseUrl(s.url) === key);
    if (i === -1) {
      list.push({ title: title || url, url });
      i = list.length - 1;
    }
    return i + 1;
  };
  const body = markdown
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, text: string, url: string) => `${text} [${indexOf(url, text)}]`)
    .replace(/(^|[\s(])<?(https?:\/\/[^\s<>)]+)>?/g, (_, lead: string, url: string) => `${lead}[${indexOf(url, '')}]`)
    .replace(/ \[(\d+)\]([.,;:])/g, '$2 [$1]');
  return { body, sources: list };
}

/** "[3]" → superscript link to #src-3, for numbers that exist in the source list. */
export function markCitations(markdown: string, sourceCount: number) {
  return markdown.replace(/\s?\[(\d{1,2})\](?!\()/g, (m, n: string) => {
    const i = Number(n);
    return i >= 1 && i <= sourceCount ? `<sup class="cite"><a href="#src-${i}">${i}</a></sup>` : m;
  });
}
