// SQLite storage via Node's built-in node:sqlite (no native build step, no external service).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS preferences (user_id INTEGER PRIMARY KEY REFERENCES users(id), json TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS watchlists (id TEXT NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id), label TEXT NOT NULL, match TEXT NOT NULL, PRIMARY KEY (user_id, id));

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, homepage TEXT, country TEXT, source_type TEXT,
  tier TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, updated_at TEXT);
CREATE TABLE IF NOT EXISTS feeds (
  id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id), url TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'rss',
  category TEXT, default_country TEXT, fetch_every_min INTEGER NOT NULL DEFAULT 30, active INTEGER NOT NULL DEFAULT 1,
  etag TEXT, last_modified TEXT, last_fetch_at TEXT, last_success_at TEXT, last_error TEXT, last_error_at TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0, items_last INTEGER DEFAULT 0, new_last INTEGER DEFAULT 0, total_new INTEGER DEFAULT 0);

CREATE TABLE IF NOT EXISTS categories (id TEXT PRIMARY KEY, label TEXT NOT NULL, section TEXT, keywords TEXT, noise INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS entities (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT, country TEXT, aliases TEXT, distinctive INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS rules (id TEXT PRIMARY KEY, kind TEXT NOT NULL, description TEXT, cond TEXT NOT NULL, action TEXT, enabled INTEGER NOT NULL DEFAULT 1);

CREATE TABLE IF NOT EXISTS stories (
  id INTEGER PRIMARY KEY, headline TEXT NOT NULL, latest_headline TEXT,
  first_seen TEXT NOT NULL, updated_at TEXT NOT NULL, last_dev_at TEXT NOT NULL,
  score INTEGER NOT NULL DEFAULT 0, level TEXT NOT NULL DEFAULT 'background', peak_level TEXT NOT NULL DEFAULT 'background',
  breakdown TEXT, sections TEXT, topics TEXT, countries TEXT, entities TEXT, vector TEXT,
  source_count INTEGER NOT NULL DEFAULT 1, article_count INTEGER NOT NULL DEFAULT 1, tier_best INTEGER,
  flags TEXT, why TEXT, flameon TEXT, watch TEXT, muted INTEGER NOT NULL DEFAULT 0,
  notified_level TEXT, notified_at TEXT);
CREATE INDEX IF NOT EXISTS stories_updated ON stories(updated_at);
CREATE INDEX IF NOT EXISTS stories_level ON stories(level, updated_at);

CREATE TABLE IF NOT EXISTS articles (
  id INTEGER PRIMARY KEY, feed_id TEXT REFERENCES feeds(id), source_id TEXT REFERENCES sources(id),
  publisher TEXT NOT NULL, tier INTEGER NOT NULL, url TEXT NOT NULL, url_canon TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL, title_norm TEXT NOT NULL, title_hash TEXT NOT NULL, author TEXT, excerpt TEXT,
  published_at TEXT NOT NULL, published_estimated INTEGER NOT NULL DEFAULT 0, retrieved_at TEXT NOT NULL,
  category TEXT, tokens TEXT, countries TEXT, topics TEXT, entities TEXT, signals TEXT,
  score INTEGER, breakdown TEXT, story_id INTEGER REFERENCES stories(id), notification_status TEXT NOT NULL DEFAULT 'none');
CREATE INDEX IF NOT EXISTS articles_pub ON articles(published_at);
CREATE INDEX IF NOT EXISTS articles_story ON articles(story_id);
CREATE INDEX IF NOT EXISTS articles_titlehash ON articles(title_hash);

CREATE TABLE IF NOT EXISTS story_articles (story_id INTEGER NOT NULL REFERENCES stories(id), article_id INTEGER NOT NULL REFERENCES articles(id), relation TEXT NOT NULL, similarity REAL, PRIMARY KEY (story_id, article_id));
CREATE TABLE IF NOT EXISTS story_updates (
  id INTEGER PRIMARY KEY, story_id INTEGER NOT NULL REFERENCES stories(id), article_id INTEGER REFERENCES articles(id),
  at TEXT NOT NULL, kind TEXT NOT NULL, headline TEXT NOT NULL, publisher TEXT, url TEXT, tier INTEGER, score_after INTEGER, level_after TEXT);
CREATE INDEX IF NOT EXISTS story_updates_story ON story_updates(story_id, at);
CREATE INDEX IF NOT EXISTS story_updates_at ON story_updates(at);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY, story_id INTEGER REFERENCES stories(id), briefing_id TEXT REFERENCES briefings(id),
  kind TEXT NOT NULL, level TEXT, title TEXT NOT NULL, body TEXT, url TEXT, reason TEXT,
  created_at TEXT NOT NULL, deliver_after TEXT, status TEXT NOT NULL, status_reason TEXT);
CREATE INDEX IF NOT EXISTS notifications_created ON notifications(created_at);
CREATE TABLE IF NOT EXISTS notification_deliveries (
  id INTEGER PRIMARY KEY, notification_id INTEGER NOT NULL REFERENCES notifications(id), channel TEXT NOT NULL, target TEXT,
  status TEXT NOT NULL, error TEXT, attempts INTEGER NOT NULL DEFAULT 0, last_attempt_at TEXT, sent_at TEXT);
CREATE TABLE IF NOT EXISTS dead_targets (target TEXT PRIMARY KEY, channel TEXT, reason TEXT, at TEXT);

CREATE TABLE IF NOT EXISTS briefings (id TEXT PRIMARY KEY, kind TEXT NOT NULL, period_start TEXT, period_end TEXT, created_at TEXT NOT NULL, json TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS processing_logs (id INTEGER PRIMARY KEY, run_id TEXT NOT NULL, at TEXT NOT NULL, stage TEXT NOT NULL, level TEXT NOT NULL, message TEXT, stats TEXT);
CREATE INDEX IF NOT EXISTS logs_run ON processing_logs(run_id);
`;

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = DELETE; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;');
  db.exec(SCHEMA);
  const v = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
  if (!v) db.prepare("INSERT INTO meta(key,value) VALUES('schema_version',?)").run(String(SCHEMA_VERSION));
  if (!db.prepare('SELECT 1 FROM users WHERE id=1').get()) db.prepare("INSERT INTO users(id,name,created_at) VALUES(1,'owner',?)").run(new Date().toISOString());
  return db;
}

export function tx(db, fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { try { db.exec('ROLLBACK'); } catch { /* ignore */ } throw e; }
}

export const getMeta = (db, k) => db.prepare('SELECT value FROM meta WHERE key=?').get(k)?.value ?? null;
export const setMeta = (db, k, v) => db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));

export const J = s => { if (s == null || s === '') return null; try { return JSON.parse(s); } catch { return null; } };
export const S = v => (v == null ? null : JSON.stringify(v));

// Mirror config into tables so the DB is self-describing; config files stay the source of truth.
export function syncConfig(db, cfg, now) {
  tx(db, () => {
    const upSrc = db.prepare(`INSERT INTO sources(id,name,homepage,country,source_type,tier,active,updated_at) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,homepage=excluded.homepage,country=excluded.country,source_type=excluded.source_type,tier=excluded.tier,active=excluded.active,updated_at=excluded.updated_at`);
    const upFeed = db.prepare(`INSERT INTO feeds(id,source_id,url,kind,category,default_country,fetch_every_min,active) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET source_id=excluded.source_id,url=excluded.url,kind=excluded.kind,category=excluded.category,default_country=excluded.default_country,fetch_every_min=excluded.fetch_every_min,active=excluded.active`);
    const seenFeeds = new Set();
    for (const s of cfg.sources.sources) upSrc.run(s.id, s.name, s.homepage || null, s.country || null, s.type || null, String(s.tier), s.active === false ? 0 : 1, now);
    for (const f of cfg.compiled.feeds) {
      seenFeeds.add(f.id);
      upFeed.run(f.id, f.sourceId, f.url, f.kind, f.category || null, f.defaultCountry || null, f.everyMin, f.active ? 1 : 0);
    }
    // Feeds removed from config: deactivate (keep rows so old articles keep their foreign keys).
    for (const r of db.prepare('SELECT id FROM feeds').all()) if (!seenFeeds.has(r.id)) db.prepare('UPDATE feeds SET active=0 WHERE id=?').run(r.id);
    const srcIds = new Set(cfg.sources.sources.map(s => s.id));
    for (const r of db.prepare('SELECT id FROM sources').all()) if (!srcIds.has(r.id)) db.prepare('UPDATE sources SET active=0 WHERE id=?').run(r.id);

    db.exec('DELETE FROM categories; DELETE FROM entities; DELETE FROM rules;');
    const ic = db.prepare('INSERT INTO categories(id,label,section,keywords,noise) VALUES(?,?,?,?,?)');
    for (const t of cfg.categories.topics) ic.run(t.id, t.label, t.section || null, S(t.keywords || []), t.noise ? 1 : 0);
    const ie = db.prepare('INSERT INTO entities(id,name,type,country,aliases,distinctive) VALUES(?,?,?,?,?,?)');
    for (const e of cfg.entities.entities) ie.run(e.id, e.name, e.type || null, e.country || null, S([...(e.aliases || []), ...(e.cs || [])]), e.distinctive === false ? 0 : 1);
    const ir = db.prepare('INSERT INTO rules(id,kind,description,cond,action,enabled) VALUES(?,?,?,?,?,?)');
    for (const r of cfg.rules.rules) ir.run('rule:' + r.id, 'rule', r.description || null, S(r.if), S(r.then), r.enabled === false ? 0 : 1);
    for (const f of cfg.scoring.topicFactors) ir.run('score:' + f.id, 'score', f.label, S(f.when), S({ points: f.points }), 1);
    for (const t of cfg.templates.templates) ir.run('why:' + t.id, 'template', t.text, S(t.when), null, 1);
    for (const r of cfg.flameon.rules) ir.run('flameon:' + r.id, 'flameon', r.text, S(r.when), S({ kind: r.kind, direct: !!r.direct }), 1);

    db.prepare('INSERT INTO preferences(user_id,json,updated_at) VALUES(1,?,?) ON CONFLICT(user_id) DO UPDATE SET json=excluded.json,updated_at=excluded.updated_at').run(S(cfg.preferences), now);
    db.exec('DELETE FROM watchlists');
    const iw = db.prepare('INSERT INTO watchlists(id,user_id,label,match) VALUES(?,1,?,?)');
    for (const w of cfg.preferences.watchlist || []) iw.run(w.id, w.label, S(w.match || null));
  });
}

export function log(db, runId, stage, level, message, stats) {
  try {
    db.prepare('INSERT INTO processing_logs(run_id,at,stage,level,message,stats) VALUES(?,?,?,?,?,?)').run(runId, new Date().toISOString(), stage, level, message ?? null, stats ? S(stats) : null);
  } catch { /* logging must never break the run */ }
  if (process.env.QUIET !== '1') console.log(`[${stage}] ${level === 'info' ? '' : level.toUpperCase() + ' '}${message || ''}`);
}

// Retention: keep the DB small enough to live in git. Background stories go after 21 days,
// articles after 45, everything else after 400 days (monthly/annual context).
export function prune(db, now) {
  const t = Date.parse(now);
  const iso = d => new Date(t - d * 864e5).toISOString();
  tx(db, () => {
    // Articles: 45 days for stories that reached Notable+, 14 days for background-only stories.
    const oldArts = `SELECT a.id FROM articles a LEFT JOIN stories s ON s.id=a.story_id
      WHERE a.retrieved_at < ? OR (a.retrieved_at < ? AND (s.id IS NULL OR s.peak_level='background'))`;
    db.prepare(`DELETE FROM story_articles WHERE article_id IN (${oldArts})`).run(iso(45), iso(14));
    db.prepare(`UPDATE story_updates SET article_id=NULL WHERE article_id IN (${oldArts})`).run(iso(45), iso(14));
    db.prepare(`DELETE FROM articles WHERE id IN (${oldArts})`).run(iso(45), iso(14));
    db.prepare(`UPDATE articles SET tokens=NULL WHERE retrieved_at < ? AND tokens IS NOT NULL`).run(iso(4)); // only needed for clustering
    const oldBg = `SELECT id FROM stories WHERE peak_level='background' AND updated_at < ?`;
    db.prepare(`DELETE FROM story_updates WHERE story_id IN (${oldBg})`).run(iso(21));
    db.prepare(`DELETE FROM story_articles WHERE story_id IN (${oldBg})`).run(iso(21));
    db.prepare(`UPDATE articles SET story_id=NULL WHERE story_id IN (${oldBg})`).run(iso(21));
    db.prepare(`DELETE FROM notification_deliveries WHERE notification_id IN (SELECT id FROM notifications WHERE story_id IN (${oldBg}))`).run(iso(21));
    db.prepare(`DELETE FROM notifications WHERE story_id IN (${oldBg})`).run(iso(21));
    db.prepare(`DELETE FROM stories WHERE peak_level='background' AND updated_at < ?`).run(iso(21));
    db.prepare(`UPDATE stories SET vector=NULL WHERE updated_at < ?`).run(iso(10));
    db.prepare(`DELETE FROM processing_logs WHERE at < ?`).run(iso(14));
  });
  const last = getMeta(db, 'last_vacuum');
  if (!last || t - Date.parse(last) > 864e5) { db.exec('VACUUM'); setMeta(db, 'last_vacuum', now); }
}
