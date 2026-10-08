// Feed collector. Each feed is fetched independently with a timeout; a failure is recorded
// against that feed only (with exponential back-off) and never stops the run.
import { parseFeed } from './parse.js';

const UA = 'Mozilla/5.0 (compatible; PersonalCurrentAffairsMonitor/1.0; RSS reader; personal non-commercial use)';
const MAX_BYTES = 6 * 1024 * 1024;

export async function fetchText(url, { etag, lastModified, timeoutMs = 20000, fetchImpl = fetch } = {}) {
  const headers = { 'user-agent': UA, accept: 'application/rss+xml, application/atom+xml, application/rdf+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5' };
  if (etag) headers['if-none-match'] = etag;
  if (lastModified) headers['if-modified-since'] = lastModified;
  const res = await fetchImpl(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  if (res.status === 304) return { notModified: true, status: 304 };
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_BYTES) throw new Error(`Feed too large (${len} bytes)`);
  const body = await res.text();
  if (body.length > MAX_BYTES) throw new Error('Feed too large');
  return { body, status: res.status, etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified') };
}

export function isDue(feedRow, nowMs) {
  if (!feedRow.last_fetch_at) return true;
  const last = Date.parse(feedRow.last_fetch_at);
  let every = (feedRow.fetch_every_min || 30) * 60e3;
  const fails = feedRow.consecutive_failures || 0;
  if (fails >= 3) every = Math.min(every * 2 ** (fails - 2), 12 * 3600e3); // back off dead feeds, retry at least twice a day
  return nowMs - last >= every - 90e3; // 90 s slack for cron jitter
}

export async function collect(feeds, db, { now, force = false, concurrency = 8, fetchImpl, onlyFeedIds } = {}) {
  const nowMs = Date.parse(now);
  const rows = new Map(db.prepare('SELECT * FROM feeds').all().map(r => [r.id, r]));
  const due = feeds.filter(f => f.active && (!onlyFeedIds || onlyFeedIds.includes(f.id)) && (force || isDue(rows.get(f.id) || {}, nowMs)));
  const results = [];
  let i = 0;
  const ok = db.prepare('UPDATE feeds SET last_fetch_at=?, last_success_at=?, etag=?, last_modified=?, consecutive_failures=0, items_last=?, last_error=NULL WHERE id=?');
  const nm = db.prepare('UPDATE feeds SET last_fetch_at=?, last_success_at=?, consecutive_failures=0, last_error=NULL WHERE id=?');
  const bad = db.prepare('UPDATE feeds SET last_fetch_at=?, last_error=?, last_error_at=?, consecutive_failures=consecutive_failures+1 WHERE id=?');
  async function worker() {
    while (i < due.length) {
      const f = due[i++];
      const row = rows.get(f.id) || {};
      const started = Date.now();
      try {
        const r = await fetchText(f.url, { etag: row.etag, lastModified: row.last_modified, fetchImpl });
        if (r.notModified) { nm.run(now, now, f.id); results.push({ feed: f, items: [], status: 'not-modified', ms: Date.now() - started }); continue; }
        const items = parseFeed(r.body);
        ok.run(now, now, r.etag || null, r.lastModified || null, items.length, f.id);
        results.push({ feed: f, items, status: 'ok', ms: Date.now() - started });
      } catch (e) {
        const msg = (e.name === 'TimeoutError' ? 'Timed out' : (e.cause?.code ? `${e.message} (${e.cause.code})` : e.message)).slice(0, 300);
        bad.run(now, msg, now, f.id);
        results.push({ feed: f, items: [], status: 'error', error: msg, ms: Date.now() - started });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, due.length || 1) }, worker));
  return { results, dueCount: due.length, skipped: feeds.filter(f => f.active).length - due.length };
}
