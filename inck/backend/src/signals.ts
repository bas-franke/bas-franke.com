/**
 * Free, keyless "what is the world looking at right now" signals, fed to the trend scout.
 * Every source is optional: a failure just yields an empty list.
 */

export interface Signal {
  source: string;
  items: string[];
}

const TIMEOUT = 8000;

const text = async (url: string, headers: Record<string, string> = {}) => {
  const res = await fetch(url, { headers: { 'User-Agent': 'inck.ai trend scout (bas-franke.com)', ...headers }, signal: AbortSignal.timeout(TIMEOUT) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
};

const decode = (s: string) => s.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").trim();

/** Google Trends daily trending searches (RSS), with approximate search volume. */
export async function googleTrends(geo = 'US'): Promise<Signal> {
  const xml = await text(`https://trends.google.com/trending/rss?geo=${geo}`);
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 20).map((m) => {
    const title = decode(m[1].match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '');
    const traffic = decode(m[1].match(/<ht:approx_traffic>([\s\S]*?)<\/ht:approx_traffic>/)?.[1] ?? '');
    const news = decode(m[1].match(/<ht:news_item_title>([\s\S]*?)<\/ht:news_item_title>/)?.[1] ?? '');
    return `${title}${traffic ? ` (${traffic} searches)` : ''}${news ? `: ${news}` : ''}`;
  });
  return { source: `Google Trends ${geo}, trending searches today`, items: items.filter(Boolean) };
}

const SKIP_WIKI = /^(Main_Page|Special:|Wikipedia:|Portal:|File:|Help:|Talk:|Template:|Category:|Index_|.*_\(disambiguation\))/;

/** Wikipedia's most-read English articles yesterday (today's figures are not complete yet). */
export async function wikipediaTop(): Promise<Signal> {
  const d = new Date(Date.now() - 36 * 3600 * 1000);
  const path = `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`;
  const json = JSON.parse(await text(`https://wikimedia.org/api/rest_v1/metrics/pageviews/top/en.wikipedia/all-access/${path}`, { Accept: 'application/json' }));
  const articles = (json.items?.[0]?.articles ?? []) as { article: string; views: number }[];
  const items = articles
    .filter((a) => !SKIP_WIKI.test(a.article))
    .slice(0, 30)
    .map((a) => `${a.article.replace(/_/g, ' ')} (${Math.round(a.views / 1000)}k views)`);
  return { source: 'Wikipedia, most-read articles yesterday', items };
}

/** Hacker News front page: what the tech/science crowd is reading. */
export async function hackerNews(): Promise<Signal> {
  const json = JSON.parse(await text('https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=30'));
  const items = ((json.hits ?? []) as { title: string; points: number }[]).map((h) => `${h.title} (${h.points} points)`);
  return { source: 'Hacker News front page', items };
}

export async function collectSignals(): Promise<Signal[]> {
  const results = await Promise.allSettled([googleTrends('US'), googleTrends('GB'), wikipediaTop(), hackerNews()]);
  return results.flatMap((r) => {
    if (r.status === 'fulfilled' && r.value.items.length) return [r.value];
    if (r.status === 'rejected') console.warn('trend signal failed:', (r.reason as Error).message);
    return [];
  });
}

export const formatSignals = (signals: Signal[]) =>
  signals.map((s) => `### ${s.source}\n${s.items.map((i) => `- ${i}`).join('\n')}`).join('\n\n') || '(no live signals available; rely on web search)';
