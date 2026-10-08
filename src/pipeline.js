// One complete run: collect -> normalize -> dedupe -> enrich -> cluster -> score -> notify -> brief -> publish.
// Every stage is isolated: a failure is logged and the run continues with what it has.
import { join } from 'node:path';
import { loadConfig, ROOT } from './config.js';
import { openDb, syncConfig, log, getMeta, setMeta, prune, S } from './db.js';
import { collect, fetchText } from './ingest/fetch.js';
import { parseFeed } from './ingest/parse.js';
import { normalizeItem } from './ingest/normalize.js';
import { ingestArticles } from './engine/stories.js';
import { getProvider } from './analysis/provider.js';
import { decideAlerts, releaseHeld } from './notify/decide.js';
import { buildChannels, deliverPending } from './notify/deliver.js';
import { generateDue } from './reports/briefings.js';
import { publish } from './publish.js';

export async function runPipeline(opts = {}) {
  const env = opts.env || process.env;
  const now = opts.now || new Date().toISOString();
  const runId = now.replace(/[-:.TZ]/g, '').slice(0, 14);
  const configDir = opts.configDir || join(ROOT, 'config');
  const cfg = opts.cfg || loadConfig(configDir);
  const db = opts.db || openDb(opts.dbPath || join(ROOT, 'state', 'intel.db'));
  const outDir = opts.outDir || join(ROOT, 'public');
  const appUrl = env.APP_URL || cfg.push.appUrl || '';
  const started = Date.now();
  const stats = { runId };
  const stage = async (name, fn) => {
    try { return await fn(); }
    catch (e) { stats.errors = (stats.errors || 0) + 1; log(db, runId, name, 'error', e.stack?.split('\n').slice(0, 3).join(' | ') || String(e)); return null; }
  };

  syncConfig(db, cfg, now);
  const bootstrap = !getMeta(db, 'bootstrapped');
  const provider = getProvider(cfg, env);
  const channels = opts.channels || buildChannels(cfg, env);
  log(db, runId, 'start', 'info', `run ${runId}${bootstrap ? ' (first run: existing news will not be pushed)' : ''} · provider=${provider.name}`);

  if (env.TEST_FEED_URL) await stage('test-feed', async () => {
    const u = env.TEST_FEED_URL;
    let result;
    try {
      const r = await fetchText(u, { fetchImpl: opts.fetchImpl });
      const items = parseFeed(r.body);
      result = { url: u, ok: true, items: items.length, sample: items.slice(0, 5).map(i => i.title), at: now };
    } catch (e) { result = { url: u, ok: false, error: e.message, at: now }; }
    setMeta(db, 'last_test_feed', S(result));
    log(db, runId, 'test-feed', result.ok ? 'info' : 'warn', `${u} -> ${result.ok ? result.items + ' items' : result.error}`);
  });

  const col = await stage('collect', () => collect(cfg.compiled.feeds, db, { now, force: !!opts.force, fetchImpl: opts.fetchImpl }));
  if (col) {
    const errs = col.results.filter(r => r.status === 'error');
    stats.feedsFetched = col.dueCount; stats.feedsFailed = errs.length; stats.feedsSkipped = col.skipped;
    log(db, runId, 'collect', errs.length ? 'warn' : 'info', `${col.dueCount} feeds due, ${errs.length} failed${errs.length ? ': ' + errs.map(e => `${e.feed.id} (${e.error})`).join(', ') : ''}`);
  }

  const normalized = [];
  await stage('normalize', () => {
    for (const r of col?.results || []) {
      let n = 0;
      for (const it of r.items) {
        try { const a = normalizeItem(it, r.feed, cfg, now); if (a) { normalized.push(a); n++; } }
        catch (e) { log(db, runId, 'normalize', 'warn', `${r.feed.id}: ${e.message}`); }
      }
      r.normalized = n;
    }
    stats.itemsSeen = normalized.length;
  });

  const ing = await stage('process', () => ingestArticles(db, cfg, provider, normalized, now));
  if (ing) {
    stats.newArticles = ing.inserted; stats.duplicates = ing.dupUrl + ing.dupTitle; stats.newStories = ing.created.length; stats.storiesTouched = ing.stories.length;
    log(db, runId, 'process', 'info', `${ing.inserted} new articles (${ing.dupUrl + ing.dupTitle} duplicates skipped) -> ${ing.created.length} new stories, ${ing.stories.length} stories updated`);
    const upd = db.prepare('UPDATE feeds SET new_last=?, total_new=total_new+? WHERE id=?');
    const counts = new Map();
    for (const r of db.prepare('SELECT feed_id, COUNT(*) n FROM articles WHERE retrieved_at=? GROUP BY feed_id').all(now)) counts.set(r.feed_id, r.n);
    for (const r of col?.results || []) { const c = counts.get(r.feed.id) || 0; upd.run(c, c, r.feed.id); }
  }

  await stage('notify-decide', () => {
    const d = decideAlerts(db, cfg, ing?.stories || [], now, { bootstrap, appUrl });
    stats.alertsCreated = d.created.length;
    if (d.created.length) log(db, runId, 'notify', 'info', d.created.map(c => `#${c.storyId} ${c.level} ${c.kind} -> ${c.status} (${c.reason})`).join('; '));
    stats.heldReleased = releaseHeld(db, cfg, now, appUrl);
    if (env.TEST_PUSH === 'true') {
      db.prepare("INSERT INTO notifications(kind,level,title,body,url,reason,created_at,deliver_after,status) VALUES('test','important',?,?,?,?,?,?,'pending')")
        .run('🟠 IMPORTANT · Test alert', 'Server test: the pipeline can reach this device.\nMatched: manual test from the app', `${appUrl}#/health`, S({ tag: 'server-test' }), now, now);
      log(db, runId, 'notify', 'info', 'test notification queued');
    }
  });

  await stage('briefings', () => {
    const made = generateDue(db, cfg, now, appUrl);
    stats.briefings = made.map(b => b.id);
    if (made.length) log(db, runId, 'briefings', 'info', 'generated ' + made.map(b => b.id).join(', '));
  });

  await stage('deliver', async () => {
    const r = await deliverPending(db, channels, now);
    stats.pushSent = r.sent; stats.pushFailed = r.failed;
    if (r.notifications) log(db, runId, 'deliver', r.failed ? 'warn' : 'info', `${r.notifications} pending -> ${r.sent} deliveries sent, ${r.failed} failed${r.noChannel ? `, ${r.noChannel} with no channel configured` : ''}`);
  });

  if (bootstrap) setMeta(db, 'bootstrapped', now);
  await stage('prune', () => prune(db, now));
  stats.ms = Date.now() - started;
  log(db, runId, 'run', stats.errors ? 'warn' : 'ok', `finished in ${stats.ms} ms`, stats);
  await stage('publish', () => { stats.published = publish(db, cfg, now, outDir, { channels, provider: provider.name, configDir }); });
  if (!opts.db) db.close();
  return stats;
}
