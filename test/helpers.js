// Shared test helpers: real config, in-memory DB, fake network, fake notification channel.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { runPipeline } from '../src/pipeline.js';

export function cfgWith(prefsPatch = {}) {
  const cfg = loadConfig();
  cfg.preferences = { ...cfg.preferences, ...prefsPatch };
  return cfg;
}

export const memDb = () => openDb(':memory:');

const xmlEsc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export function rss(items) {
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>${items.map(i =>
    `<item><title>${xmlEsc(i.title)}</title><link>${xmlEsc(i.link)}</link>${i.date ? `<pubDate>${new Date(i.date).toUTCString()}</pubDate>` : ''}<description>${xmlEsc(i.desc || '')}</description>${i.source ? `<source url="${i.sourceUrl || ''}">${xmlEsc(i.source)}</source>` : ''}</item>`).join('')}</channel></rss>`;
}

// feeds: { [feedId]: xmlString | Error }. Anything unlisted returns an empty valid feed.
export function fakeFetch(cfg, feeds) {
  const byUrl = new Map(cfg.compiled.feeds.map(f => [f.url, f.id]));
  return async url => {
    const id = byUrl.get(url);
    const body = feeds[id];
    if (body instanceof Error) throw body;
    return new Response(body ?? rss([]), { status: 200, headers: { 'content-type': 'application/rss+xml' } });
  };
}

export class FakeChannel {
  constructor() { this.name = 'fake'; this.ok = true; this.why = null; this.sent = []; }
  targets() { return [{ id: 'fake:1' }]; }
  async send(t, msg) { this.sent.push(msg); return { ok: true }; }
}

export function tmpOut() { return mkdtempSync(join(tmpdir(), 'ca-test-')); }

export async function run(cfg, db, feeds, now, channel = new FakeChannel(), env = {}) {
  const stats = await runPipeline({ cfg, db, now, fetchImpl: fakeFetch(cfg, feeds), channels: [channel], outDir: tmpOut(), env: { QUIET: '1', ...env }, force: true });
  return { stats, channel };
}

export const iso = (base, minutes) => new Date(Date.parse(base) + minutes * 60e3).toISOString();
