// Writes the static JSON the PWA reads. Secrets and push subscriptions are never published.
import { mkdirSync, writeFileSync, readdirSync, rmSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { J, getMeta } from './db.js';
import { snapshot } from './reports/snapshot.js';
import { rank } from './engine/score.js';

const H = 3600e3;
const PUBLIC_CONFIG = ['sources', 'publishers', 'entities', 'categories', 'scoring', 'rules', 'templates', 'flameon', 'preferences', 'push'];

const write = (p, obj) => writeFileSync(p, JSON.stringify(obj));

export function publish(db, cfg, now, outDir, { channels = [], provider = 'rules', configDir } = {}) {
  const dataDir = join(outDir, 'data');
  mkdirSync(join(dataDir, 'briefings'), { recursive: true });
  mkdirSync(join(dataDir, 'config'), { recursive: true });
  const nowMs = Date.parse(now);
  const iso = h => new Date(nowMs - h * H).toISOString();

  // Live feed: everything Notable+ from the last 72h with full detail, plus some background for context.
  const recent = db.prepare('SELECT * FROM stories WHERE last_dev_at>=? ORDER BY score DESC').all(iso(72));
  const main = recent.filter(s => rank(s.level) >= rank('notable')).slice(0, 220);
  const bg = recent.filter(s => s.level === 'background' && !s.muted).slice(0, 80);
  const briefIdx = db.prepare('SELECT id, kind, created_at FROM briefings ORDER BY created_at DESC LIMIT 120').all();
  write(join(dataDir, 'feed.json'), {
    generatedAt: now, provider,
    stories: main.map(s => snapshot(db, cfg, s)),
    background: bg.map(s => snapshot(db, cfg, s, { full: false })),
    latestBriefings: Object.fromEntries(['daily', 'evening', 'weekly', 'monthly'].map(k => [k, briefIdx.find(b => b.kind === k)?.id || null]))
  });

  // 30-day archive (compact) for watchlist + search.
  const arch = db.prepare('SELECT * FROM stories WHERE last_dev_at>=? AND last_dev_at<? ORDER BY last_dev_at DESC').all(iso(30 * 24), iso(72))
    .filter(s => rank(s.peak_level) >= rank('notable')).slice(0, 1500);
  write(join(dataDir, 'archive.json'), { generatedAt: now, stories: arch.map(s => snapshot(db, cfg, s, { full: false })) });

  // Briefings: index + one file each (last 120). Remove files that dropped out of the window.
  const keep = new Set();
  for (const b of briefIdx) {
    const row = db.prepare('SELECT json FROM briefings WHERE id=?').get(b.id);
    writeFileSync(join(dataDir, 'briefings', `${b.id}.json`), row.json);
    keep.add(`${b.id}.json`);
  }
  for (const f of readdirSync(join(dataDir, 'briefings'))) if (f !== 'index.json' && !keep.has(f)) rmSync(join(dataDir, 'briefings', f));
  write(join(dataDir, 'briefings', 'index.json'), briefIdx.map(b => {
    const j = J(db.prepare('SELECT json FROM briefings WHERE id=?').get(b.id).json) || {};
    return { id: b.id, kind: b.kind, createdAt: b.created_at, title: j.title, lead: j.top?.[0]?.headline || j.biggest?.headline || j.fresh?.[0]?.headline || j.topStories?.[0]?.headline || null };
  }));

  write(join(dataDir, 'health.json'), health(db, cfg, now, channels, provider));

  if (configDir) for (const n of PUBLIC_CONFIG) { const p = join(configDir, `${n}.json`); if (existsSync(p)) copyFileSync(p, join(dataDir, 'config', `${n}.json`)); }
  return { stories: main.length, background: bg.length, archive: arch.length, briefings: briefIdx.length };
}

export function health(db, cfg, now, channels, provider) {
  const nowMs = Date.parse(now);
  const iso = h => new Date(nowMs - h * H).toISOString();
  const feeds = db.prepare(`SELECT f.id, f.source_id, s.name source, f.url, f.kind, f.category, f.active, f.fetch_every_min every, f.last_fetch_at, f.last_success_at,
      f.last_error, f.last_error_at, f.consecutive_failures fails, f.items_last, f.total_new, s.tier
      FROM feeds f JOIN sources s ON s.id=f.source_id ORDER BY f.consecutive_failures DESC, s.name`).all();
  const n = (sql, ...a) => db.prepare(sql).get(...a).n;
  const runs = db.prepare("SELECT at, message, stats, level FROM processing_logs WHERE stage='run' ORDER BY id DESC LIMIT 30").all().map(r => ({ at: r.at, level: r.level, message: r.message, ...(J(r.stats) || {}) }));
  const lastBrief = Object.fromEntries(['daily', 'evening', 'weekly', 'monthly'].map(k => [k, db.prepare('SELECT id, created_at FROM briefings WHERE kind=? ORDER BY created_at DESC LIMIT 1').get(k) || null]));
  return {
    generatedAt: now, provider,
    totals: {
      feedsActive: feeds.filter(f => f.active).length,
      feedsFailing: feeds.filter(f => f.active && f.fails > 0).length,
      articles: n('SELECT COUNT(*) n FROM articles'), articles24h: n('SELECT COUNT(*) n FROM articles WHERE retrieved_at>=?', iso(24)),
      stories: n('SELECT COUNT(*) n FROM stories'), stories24h: n('SELECT COUNT(*) n FROM stories WHERE first_seen>=?', iso(24)),
      byLevel24h: Object.fromEntries(['critical', 'important', 'notable', 'background'].map(l => [l, n('SELECT COUNT(*) n FROM stories WHERE level=? AND last_dev_at>=?', l, iso(24))])),
      notificationsSent24h: n("SELECT COUNT(*) n FROM notifications WHERE status='sent' AND created_at>=?", iso(24)),
      notificationsSent7d: n("SELECT COUNT(*) n FROM notifications WHERE status='sent' AND created_at>=?", iso(168)),
      notificationsFailed7d: n("SELECT COUNT(*) n FROM notifications WHERE status IN ('failed','undeliverable') AND created_at>=?", iso(168)),
      held: n("SELECT COUNT(*) n FROM notifications WHERE status='held'"),
      suppressed7d: n("SELECT COUNT(*) n FROM notifications WHERE status='suppressed' AND created_at>=?", iso(168))
    },
    channels: channels.map(c => ({ name: c.name, ok: c.ok, why: c.why, targets: c.ok ? c.targets().length : 0 })),
    feeds,
    runs,
    lastBriefings: lastBrief,
    notifications: db.prepare(`SELECT n.id, n.kind, n.level, n.title, n.body, n.created_at, n.status, n.status_reason, n.story_id,
        (SELECT group_concat(d.channel || ':' || d.status || COALESCE(' ' || d.error,''), ' | ') FROM notification_deliveries d WHERE d.notification_id=n.id) deliveries
        FROM notifications n ORDER BY n.id DESC LIMIT 40`).all(),
    testFeed: J(getMeta(db, 'last_test_feed')),
    db: { sizeNote: 'SQLite database persisted on the data branch' }
  };
}
