import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFeed, parseDate } from '../src/ingest/parse.js';
import { normalizeItem } from '../src/ingest/normalize.js';
import { canonicalUrl, tokenize } from '../src/text.js';
import { cfgWith, memDb, rss, run } from './helpers.js';

process.env.QUIET = '1';

test('reads RSS 2.0', () => {
  const items = parseFeed(rss([{ title: 'Pakistan, IMF reach staff-level agreement', link: 'https://a.com/1', date: '2026-10-08T05:00:00Z', desc: '<p>Hello &amp; welcome</p>' }]));
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Pakistan, IMF reach staff-level agreement');
  assert.equal(items[0].published.toISOString(), '2026-10-08T05:00:00.000Z');
});

test('reads Atom', () => {
  const xml = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>x</title>
    <entry><title type="html">SBP keeps policy rate unchanged</title><link rel="alternate" href="https://b.com/x"/><updated>2026-10-08T04:00:00Z</updated><summary>s</summary></entry></feed>`;
  const items = parseFeed(xml);
  assert.equal(items[0].link, 'https://b.com/x');
  assert.equal(items[0].kind, 'atom');
});

test('reads RSS 1.0 / RDF', () => {
  const xml = `<?xml version="1.0"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
    <item><title>Rupee gains against dollar</title><link>https://c.com/r</link><dc:date>2026-10-08T03:00:00+05:00</dc:date></item></rdf:RDF>`;
  const items = parseFeed(xml);
  assert.equal(items[0].published.toISOString(), '2026-10-07T22:00:00.000Z');
});

test('malformed and non-feed documents throw clear errors', () => {
  assert.throws(() => parseFeed('<rss><channel><item><title>x</title></channel>'), /Malformed|Not an RSS/);
  assert.throws(() => parseFeed('<!doctype html><html><body>blocked</body></html>'), /HTML page/);
  assert.throws(() => parseFeed(''), /Empty/);
});

test('missing / broken / future dates fall back to retrieval time', () => {
  const cfg = cfgWith();
  const feed = cfg.compiled.feeds.find(f => f.id === 'dawn-home');
  const now = '2026-10-08T06:00:00.000Z';
  const a = normalizeItem({ title: 'Pakistan announces new tax measures for retailers', link: 'https://dawn.com/x', description: '', published: null }, feed, cfg, now);
  assert.equal(a.published_at, now); assert.equal(a.published_estimated, 1);
  const b = normalizeItem({ title: 'Pakistan announces new tax measures for retailers', link: 'https://dawn.com/y', published: new Date('2027-01-01') }, feed, cfg, now);
  assert.equal(b.published_at, now);
  assert.equal(parseDate('Wed, 08 Oct 2026 10:00:00 PKT').toISOString(), '2026-10-08T05:00:00.000Z');
  assert.equal(parseDate('not a date'), null);
});

test('stale items and TV-bulletin roll-ups are dropped', () => {
  const cfg = cfgWith();
  const feed = cfg.compiled.feeds.find(f => f.id === 'dawn-home');
  const now = '2026-10-08T06:00:00.000Z';
  assert.equal(normalizeItem({ title: 'Old story about the economy of Pakistan', link: 'https://d/1', published: new Date('2026-09-01') }, feed, cfg, now), null);
  assert.equal(normalizeItem({ title: 'PTI March | Petrol Price | Inflation | 11PM', link: 'https://d/2', published: new Date(now) }, feed, cfg, now), null);
});

test('Google News items are credited to the original publisher and tiered by it', () => {
  const cfg = cfgWith();
  const feed = cfg.compiled.feeds.find(f => f.kind === 'gnews');
  const now = '2026-10-08T06:00:00.000Z';
  const a = normalizeItem({ title: 'IMF reaches staff deal with Pakistan - Reuters', link: 'https://news.google.com/x', published: new Date(now), source: { name: 'Reuters', url: 'https://www.reuters.com' } }, feed, cfg, now);
  assert.equal(a.publisher, 'Reuters'); assert.equal(a.tier, 2);
  assert.equal(a.title, 'IMF reaches staff deal with Pakistan');
  const b = normalizeItem({ title: 'Some unverified claim about prices - Random Blog', link: 'https://news.google.com/y', published: new Date(now), source: { name: 'Random Blog', url: 'https://random.example' } }, feed, cfg, now);
  assert.equal(b.tier, 4);
});

test('URL canonicalisation and tokenisation are stable', () => {
  assert.equal(canonicalUrl('http://www.dawn.com/news/123/?utm_source=x&id=5#top'), canonicalUrl('https://dawn.com/news/123?id=5'));
  assert.deepEqual(tokenize('Govt hikes petrol by Rs1.82'), tokenize('Government raises petrol by Rs 1.82'));
});

test('one broken feed does not stop the system', async () => {
  const cfg = cfgWith();
  const db = memDb();
  const now = '2026-10-08T06:00:00.000Z';
  const feeds = {
    'dawn-home': new Error('ECONNRESET'),
    'tribune-pakistan': '<html>not a feed</html>',
    'geo-latest': rss([{ title: 'Pakistan, IMF reach staff-level agreement on $1.2bn tranche', link: 'https://geo.tv/1', date: now }])
  };
  const { stats } = await run(cfg, db, feeds, now);
  assert.equal(stats.feedsFailed, 2);
  assert.equal(stats.newArticles, 1);
  const bad = db.prepare("SELECT id, last_error, consecutive_failures FROM feeds WHERE id IN ('dawn-home','tribune-pakistan') ORDER BY id").all();
  assert.equal(bad.length, 2);
  assert.ok(bad.every(f => f.consecutive_failures === 1 && f.last_error));
  const ok = db.prepare("SELECT last_success_at FROM feeds WHERE id='geo-latest'").get();
  assert.ok(ok.last_success_at);
});
