// Mails the owner once about every article that is live and visible on the dashboard. The deploy workflow runs this after the health
// check: `node dist/bot/articleMail.js articles.json notified.json`. articles.json comes from scripts/list-articles.mjs. notified.json
// is the memory of slugs already mailed; the first run only fills it (the articles that exist then are not news).
// An article counts as visible when the site's own script bundle contains its slug, so the mail never goes out before the page does.

import { readFile, writeFile } from 'node:fs/promises';
import { alertsConfigured, deliver } from './alerts.js';

const SITE = 'https://stonks.bas-franke.com';
const TRIES = 8;
const WAIT_MS = 10_000;

export interface ArticleInfo {
  slug: string;
  title: string;
  blurb: string;
  date: string;
  tag: string;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const sans = "system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export const articleUrl = (a: ArticleInfo) => `${SITE}/article?slug=${encodeURIComponent(a.slug)}`;
export const articleSubject = (a: ArticleInfo) => `New article: ${a.title}`;
export const articleText = (a: ArticleInfo) => `${a.title}\n\n${a.blurb}\n\nRead it: ${articleUrl(a)}\n`;

/** Tables and inline styles only, in the dashboard's paper colours, like the trade mail. */
export function articleHtml(a: ArticleInfo): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"></head>
<body style="margin:0;padding:0;background:#f4ede3;font-family:${sans}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4ede3"><tr><td align="center" style="padding:28px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#fbf7f0;border:1px solid #e4d9c7;border-radius:16px;overflow:hidden">
<tr><td style="padding:24px 28px 0;color:#18223a;font-family:Georgia,'Times New Roman',serif;font-size:20px;font-weight:700">stonks<span style="color:#c9a24a">.</span></td></tr>
<tr><td style="padding:18px 28px 0"><div style="color:#8a6a22;font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase">New article${a.tag ? ` · ${escapeHtml(a.tag)}` : ''}</div>
<div style="margin-top:8px;color:#18223a;font-family:Georgia,'Times New Roman',serif;font-size:24px;line-height:1.25;font-weight:700">${escapeHtml(a.title)}</div>
<div style="margin-top:12px;color:#4f5668;font-size:15px;line-height:1.5">${escapeHtml(a.blurb)}</div></td></tr>
<tr><td style="padding:22px 28px 26px"><a href="${articleUrl(a)}" style="display:inline-block;background:#c9a24a;color:#18223a;font-size:14px;font-weight:700;text-decoration:none;padding:11px 20px;border-radius:11px">Read the article</a></td></tr>
</table></td></tr></table></body></html>`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** True when the published site's scripts carry the article. */
export async function isVisible(slug: string): Promise<boolean> {
  try {
    const page = await (await fetch(`${SITE}/?v=${Date.now()}`, { signal: AbortSignal.timeout(15_000) })).text();
    const scripts = [...page.matchAll(/<script[^>]+src="([^"]+\.js)"/g)].map((m) => new URL(m[1], SITE).href);
    for (const src of scripts) {
      const js = await (await fetch(src, { signal: AbortSignal.timeout(30_000) })).text();
      if (js.includes(`"${slug}"`) || js.includes(`'${slug}'`) || js.includes(`\`${slug}\``)) return true;
    }
  } catch {
    // Not reachable yet: the caller tries again.
  }
  return false;
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

async function main(): Promise<number> {
  const [listFile, stateFile] = process.argv.slice(2);
  if (!listFile || !stateFile) {
    console.error('usage: articleMail.js articles.json notified.json');
    return 2;
  }
  const articles = await readJson<ArticleInfo[]>(listFile, []);
  if (!articles.length) {
    console.error('No articles in the list.');
    return 1;
  }
  const state = await readJson<{ slugs: string[] } | null>(stateFile, null);
  if (!state) {
    await writeFile(stateFile, JSON.stringify({ slugs: articles.map((a) => a.slug) }));
    console.log(`Article mail starts here: ${articles.length} existing articles are not announced.`);
    return 0;
  }
  const fresh = articles.filter((a) => !state.slugs.includes(a.slug));
  if (!fresh.length) {
    console.log('No new articles.');
    return 0;
  }
  if (!alertsConfigured()) {
    console.error('Mail is not set up: SENDGRID_API_KEY must be set on the server.');
    return 1;
  }
  let failed = 0;
  for (const a of fresh.reverse()) {
    let seen = false;
    for (let i = 0; i < TRIES && !seen; i++) {
      seen = await isVisible(a.slug);
      if (!seen) await sleep(WAIT_MS);
    }
    if (!seen) {
      console.error(`"${a.title}" is not visible on ${SITE} yet; it is mailed by the next deploy.`);
      failed++;
      continue;
    }
    const sent = await deliver(articleSubject(a), articleText(a), articleHtml(a));
    if (!sent.ok) {
      console.error(`Mail for "${a.title}" not sent: ${sent.error}`);
      failed++;
      continue;
    }
    state.slugs.push(a.slug);
    await writeFile(stateFile, JSON.stringify(state));
    console.log(`Mailed "${a.title}"`);
  }
  return failed ? 1 : 0;
}

// Only when run as the script (the tests import the builders above).
if (process.argv[1]?.endsWith('articleMail.js')) process.exit(await main());
