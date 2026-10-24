/**
 * Cleaning of model text. With web search on, the models decorate their prose with inline citations such as
 * "([nato.int](https://www.nato.int/...?utm_source=openai))" or bare URLs; readers get plain text, sources live in
 * their own field.
 */

const DOMAIN = /^[\w.-]+\.[a-z]{2,}$/i;

/** Removes inline citations: parenthesised source links, Markdown links (their label stays unless it is a domain), bare URLs. */
export function stripCitations(text: string) {
  return text
    .replace(/\s*\(\s*(?:\[[^\]\n]*\]\([^)\s]*\)\s*[,;]?\s*)+\)/g, '')
    .replace(/\[([^\]\n]*)\]\((?:https?:\/\/)[^)\s]*\)/g, (_, label: string) => (DOMAIN.test(label.trim()) ? '' : label))
    .replace(/\s*\(?(?:https?:\/\/|www\.)[^\s<>)]+\)?/g, '')
    .replace(/\(\s*\)/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([.,;:!?])/g, '$1')
    .trim();
}

/** A single line of plain text, citations removed, cut to a length. */
export const cleanLine = (text: string | null | undefined, max = 300) => stripCitations(String(text ?? '')).replace(/\s+/g, ' ').slice(0, max);

/**
 * Cleans a story body: citations and links out, headings become bold paragraphs, inline citation numbers and
 * horizontal rules vanish, blank lines collapse.
 */
export function tidyBody(body: string) {
  return stripCitations(body)
    .replace(/^#{1,6}\s*(.+)$/gm, '**$1**')
    .replace(/\s?\[\d{1,2}\](?!\()/g, '')
    .replace(/^\s*(-{3,}|\*{3,}|_{3,})\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
