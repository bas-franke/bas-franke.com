import type { Channel } from './types.js';

/**
 * Traffic channel of a visit, from the utm tags of its landing URL and the referrer host.
 * utm tags win: a recognised source/medium gives email, social or search, any other utm_source is a campaign.
 * Without tags the referrer decides; an unrecognised external host is a referral, no referrer at all is direct.
 */

// Matched against whole dot-separated labels of a host ("l.facebook.com") or a utm value ("facebook", "fb").
const EMAIL = /(^|\.)(e-?mail|webmail|mail|newsletter|outlook|gmail)(\.|$)/;
const SOCIAL =
  /(^|\.)(facebook|fb|instagram|ig|t\.co|twitter|x|linkedin|lnkd\.in|reddit|youtube|youtu\.be|tiktok|pinterest|mastodon|mstdn|bsky|bluesky|threads|news\.ycombinator|ycombinator|hn|social|whatsapp|telegram|discord)(\.|$)/;
const SEARCH = /(^|\.)(google|bing|duckduckgo|yahoo|ecosia|baidu|yandex|ya|brave|startpage|qwant|kagi|search|cpc|ppc)(\.|$)/;

function classify(name: string): Channel | undefined {
  // Email before search: mail.google.com and mail.yahoo.com are webmail, not search results.
  if (EMAIL.test(name)) return 'email';
  if (SOCIAL.test(name)) return 'social';
  if (SEARCH.test(name)) return 'search';
  return undefined;
}

export function channelFor(referrerHost: string | null, utmSource: string | null, utmMedium: string | null): Channel {
  // Source first: utm_source=facebook&utm_medium=cpc is paid social, not search.
  const tagged = (utmSource && classify(utmSource)) || (utmMedium && classify(utmMedium));
  if (tagged) return tagged;
  if (utmSource) return 'campaign';
  if (referrerHost) return classify(referrerHost) ?? 'referral';
  return 'direct';
}

/**
 * The same referrer rules as a SQL expression over a referrer-host column, used once to give the rows from before
 * the channel column existed a channel (they have no utm tags).
 */
export const referrerChannelSql = (column: string) =>
  `CASE WHEN ${column} IS NULL THEN 'direct' WHEN ${column} ~ '${EMAIL.source}' THEN 'email' WHEN ${column} ~ '${SOCIAL.source}' THEN 'social'
   WHEN ${column} ~ '${SEARCH.source}' THEN 'search' ELSE 'referral' END`;
