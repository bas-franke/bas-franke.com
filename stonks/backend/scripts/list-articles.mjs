// Lists the articles of the dashboard as JSON ([{slug, title, blurb, date, tag}]), read from the frontend's articles.tsx.
// The deploy workflow ships it to the server, where bot/articleMail.js mails the owner about each article that is new and visible.
// Usage: node scripts/list-articles.mjs [path/to/articles.tsx] > articles.json

import { readFileSync } from 'node:fs';

const file = process.argv[2] ?? new URL('../../frontend/src/articles.tsx', import.meta.url);
const src = readFileSync(file, 'utf8').replaceAll('\r\n', '\n');
const list = src.slice(src.indexOf('export const ARTICLES'));

const str = (block, key) => {
  const m = new RegExp(`\\n\\s*${key}:\\s*(['"\`])((?:\\\\.|(?!\\1)[^\\\\])*)\\1`).exec(block);
  return m ? m[2].replace(/\\(['"`\\])/g, '$1') : '';
};

const articles = [];
for (let block of list.split(/\n  \{\n/).slice(1)) {
  block = `
${block}`;
  const slug = str(block, 'slug');
  if (!slug) continue;
  articles.push({ slug, title: str(block, 'title'), blurb: str(block, 'blurb'), date: str(block, 'date'), tag: str(block, 'tag') });
}
if (!articles.length) {
  console.error('No articles found in articles.tsx');
  process.exit(1);
}
console.log(JSON.stringify(articles, null, 1));
