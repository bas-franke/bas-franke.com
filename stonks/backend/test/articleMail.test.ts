import assert from 'node:assert/strict';
import test from 'node:test';
import { articleHtml, articleSubject, articleText, articleUrl, type ArticleInfo } from '../src/bot/articleMail.js';

const a: ArticleInfo = { slug: 'less-bitcoin', title: 'Less <bitcoin>', blurb: 'Did it work?', date: '2026-11-01T10:00:00+01:00', tag: 'Research' };

test('article mail: subject, link and escaped html', () => {
  assert.equal(articleSubject(a), 'New article: Less <bitcoin>');
  assert.equal(articleUrl(a), 'https://stonks.bas-franke.com/article?slug=less-bitcoin');
  assert.ok(articleText(a).includes(articleUrl(a)));
  const html = articleHtml(a);
  assert.ok(html.includes('Less &#60;bitcoin&#62;') && !html.includes('<bitcoin>'));
  assert.ok(html.includes(`href="${articleUrl(a)}"`));
});
