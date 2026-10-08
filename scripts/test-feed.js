#!/usr/bin/env node
// Check a feed URL before adding it:  npm run test-feed -- https://example.com/feed
import { fetchText } from '../src/ingest/fetch.js';
import { parseFeed } from '../src/ingest/parse.js';

const url = process.argv[2];
if (!url) { console.error('usage: npm run test-feed -- <url>'); process.exit(2); }
try {
  const t = Date.now();
  const r = await fetchText(url);
  const items = parseFeed(r.body);
  console.log(`OK  ${items.length} items in ${Date.now() - t} ms`);
  for (const i of items.slice(0, 8)) console.log(` - ${i.published ? i.published.toISOString().slice(0, 16) : '(no date)       '}  ${i.title}`);
  if (!items.some(i => i.published)) console.log('WARNING: items have no dates; retrieval time will be used.');
} catch (e) { console.error('FAIL', e.message); process.exit(1); }
