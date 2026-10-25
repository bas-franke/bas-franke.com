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
    // A citation cut off mid-way, such as "([the-star.co.ke]" or "([apnews.com](https://apnews.com/arti".
    .replace(/\s*\(\[[^\]\n]*\](?:\([^)\s]*\)?)?\)?/g, '')
    // A bare domain in brackets, such as "(investing.com)" or "(apnews.com; reuters.com)".
    .replace(/\s*\(\s*(?:[\w-]+\.)+[a-z]{2,}(?:\s*[,;]\s*(?:[\w-]+\.)+[a-z]{2,})*\s*\)/gi, '')
    .replace(/\(\s*\)/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([.,;:!?])/g, '$1')
    .trim();
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const W = WEEKDAYS.join('|');
const M = MONTHS.join('|');
/** "Saturday, 24 October" or "Saturday, October 24", not already followed by a year. */
const WEEKDAY_DATE = new RegExp(`\\b(${W}),? (?:(\\d{1,2}) (${M})|(${M}) (\\d{1,2}))\\b(?!,? \\d{4})`, 'g');

/** "Saturday, 24 October 2026": a weekday with its full date. */
const FULL_WEEKDAY_DATE = new RegExp(`\\b(${W}), (\\d{1,2} (?:${M}) \\d{4}|(?:${M}) \\d{1,2}, \\d{4})`, 'g');
/**
 * A weekday standing alone ("On Sunday, voters…", "Saturday evening"), not followed by its date, not possessive, and
 * not part of a rule such as "the last Sunday in October".
 */
const BARE_WEEKDAY = new RegExp(
  `(?<!\\b(?:last|first|second|third|fourth|every|each|next|on a|of a) )\\b(${W})( (?:morning|afternoon|evening|night))?\\b(?!’s|'s|,? (?:\\d|${M})| (?:in|of) )`,
  'g',
);

/**
 * Stories are read long after they are written, so "Saturday, 24 October" gets its year: the one, within a year of
 * now, in which that date falls on that weekday (left alone when no such year fits). A weekday that stands alone
 * then gets the date the story gives that weekday elsewhere: "on Sunday" becomes "on Sunday, 25 October 2026".
 */
export function completeDates(text: string, now = new Date()) {
  const withYears = text.replace(WEEKDAY_DATE, (match, weekday: string, d1?: string, m1?: string, m2?: string, d2?: string) => {
    const month = MONTHS.indexOf((m1 ?? m2)!);
    const day = Number(d1 ?? d2);
    const year = [0, 1, -1]
      .map((offset) => now.getUTCFullYear() + offset)
      .filter((y) => new Date(Date.UTC(y, month, day)).getUTCDay() === WEEKDAYS.indexOf(weekday))
      .find((y) => Math.abs(Date.UTC(y, month, day) - now.getTime()) < 366 * 86400_000);
    return year ? `${match}${m2 ? ',' : ''} ${year}` : match;
  });
  const dates = new Map<string, Set<string>>();
  for (const [, weekday, date] of withYears.matchAll(FULL_WEEKDAY_DATE)) dates.set(weekday, (dates.get(weekday) ?? new Set()).add(date));
  if (!dates.size) return withYears;
  return withYears.replace(BARE_WEEKDAY, (match, weekday: string, part = '') => {
    const known = dates.get(weekday);
    return known?.size === 1 ? `${weekday}${part}, ${[...known][0]}` : match;
  });
}

/** A single line of plain text, citations removed, cut to a length. */
export const cleanLine = (text: string | null | undefined, max = 300) => stripCitations(String(text ?? '')).replace(/\s+/g, ' ').slice(0, max);

/**
 * Cleans a story body: citations and links out, weekday dates get their year, HTML line breaks become paragraph
 * breaks, headings become bold paragraphs, inline citation numbers and horizontal rules vanish, blank lines collapse.
 */
export function tidyBody(body: string, now = new Date()) {
  return completeDates(stripCitations(body), now)
    .replace(/[ \t]*(?:<br\s*\/?>[ \t]*)+/gi, '\n\n')
    .replace(/^#{1,6}\s*(.+)$/gm, '**$1**')
    .replace(/\s?\[\d{1,2}\](?!\()/g, '')
    .replace(/^\s*(-{3,}|\*{3,}|_{3,})\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
