// Loads and validates every config/*.json file, and compiles keyword/entity matchers once.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileKeywords } from './text.js';
import { validateCondition } from './engine/conditions.js';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LEVELS = ['background', 'notable', 'important', 'critical'];

function readJson(dir, name, fallback) {
  const p = join(dir, name);
  if (!existsSync(p)) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing config file ${name}`);
  }
  try { return JSON.parse(readFileSync(p, 'utf8')); }
  catch (e) { throw new Error(`Invalid JSON in ${name}: ${e.message}`); }
}

export function loadConfig(dir = join(ROOT, 'config')) {
  const cfg = {
    sources: readJson(dir, 'sources.json'),
    publishers: readJson(dir, 'publishers.json'),
    entities: readJson(dir, 'entities.json'),
    categories: readJson(dir, 'categories.json'),
    scoring: readJson(dir, 'scoring.json'),
    rules: readJson(dir, 'rules.json'),
    templates: readJson(dir, 'templates.json'),
    flameon: readJson(dir, 'flameon.json'),
    preferences: readJson(dir, 'preferences.json'),
    push: readJson(dir, 'push.json', { vapidPublicKey: '', subject: '' }),
    subscriptions: readJson(dir, 'subscriptions.json', { subscriptions: [] })
  };
  const errors = validateConfig(cfg);
  if (errors.length) {
    const e = new Error('Config validation failed:\n  ' + errors.join('\n  '));
    e.errors = errors;
    throw e;
  }
  return compile(cfg);
}

export function validateConfig(cfg) {
  const errs = [];
  const ids = new Set(), feedIds = new Set();
  for (const s of cfg.sources.sources || []) {
    if (!s.id || !/^[a-z0-9-]+$/.test(s.id)) errs.push(`sources: bad id "${s.id}"`);
    if (ids.has(s.id)) errs.push(`sources: duplicate id ${s.id}`);
    ids.add(s.id);
    if (!(s.tier === 'publisher' || [1, 2, 3, 4].includes(s.tier))) errs.push(`sources.${s.id}: tier must be 1-4 or "publisher"`);
    for (const f of s.feeds || []) {
      if (feedIds.has(f.id)) errs.push(`sources.${s.id}: duplicate feed id ${f.id}`);
      feedIds.add(f.id);
      if (f.kind === 'gnews') { if (!f.query) errs.push(`feed ${f.id}: gnews feed needs a query`); }
      else if (!/^https?:\/\//.test(f.url || '')) errs.push(`feed ${f.id}: url must be http(s)`);
    }
  }
  const topicIds = new Set((cfg.categories.topics || []).map(t => t.id));
  const sectionIds = new Set((cfg.categories.sections || []).map(s => s.id));
  for (const t of cfg.categories.topics || []) {
    if (t.section && !sectionIds.has(t.section)) errs.push(`categories.${t.id}: unknown section ${t.section}`);
  }
  const check = (cond, where) => errs.push(...validateCondition(cond, where));
  for (const f of cfg.scoring.topicFactors || []) check(f.when, `scoring.topicFactors.${f.id}`);
  for (const r of cfg.rules.rules || []) {
    check(r.if, `rules.${r.id}.if`);
    const t = r.then || {};
    for (const k of ['minLevel', 'maxLevel']) if (t[k] && !LEVELS.includes(t[k])) errs.push(`rules.${r.id}: bad ${k}`);
  }
  for (const t of cfg.templates.templates || []) check(t.when, `templates.${t.id}`);
  for (const r of cfg.flameon.rules || []) check(r.when, `flameon.${r.id}`);
  for (const w of cfg.preferences.watchlist || []) if (w.match) check(w.match, `watchlist.${w.id}`);
  const p = cfg.preferences;
  if (!['critical', 'critical+important', 'all'].includes(p.severity)) errs.push('preferences.severity must be critical | critical+important | all');
  for (const k of ['daily', 'evening', 'weekly', 'monthly']) if (p[k]?.time && !/^\d{2}:\d{2}$/.test(p[k].time)) errs.push(`preferences.${k}.time must be HH:MM`);
  if (p.quietHours?.enabled && !(/^\d{2}:\d{2}$/.test(p.quietHours.start) && /^\d{2}:\d{2}$/.test(p.quietHours.end))) errs.push('preferences.quietHours start/end must be HH:MM');
  try { new Intl.DateTimeFormat('en', { timeZone: p.timezone }); } catch { errs.push(`preferences.timezone invalid: ${p.timezone}`); }
  // Topic references inside conditions are not checked against topicIds: unknown topic ids simply never match.
  void topicIds;
  return errs;
}

function compile(cfg) {
  const entities = (cfg.entities.entities || []).map(e => ({
    ...e,
    distinctive: e.distinctive !== false,
    re: compileKeywords(e.aliases || [], false),
    reCs: compileKeywords(e.cs || [], true)
  }));
  const topics = (cfg.categories.topics || []).map(t => ({
    ...t,
    re: compileKeywords(t.keywords || [], false),
    reCs: compileKeywords(t.cs || [], true)
  }));
  const sc = cfg.scoring;
  const urgency = {
    breaking: (sc.urgency.breakingPatterns || []).map(p => new RegExp(p, 'iu')),
    major: (sc.urgency.majorPatterns || []).map(p => new RegExp(p, 'iu'))
  };
  const pubIndex = [];
  for (const p of cfg.publishers.publishers || []) {
    pubIndex.push({ tier: p.tier, name: p.name, country: p.country || null, names: [p.name, ...(p.aliases || [])].map(n => n.toLowerCase()), domains: p.domains || [] });
  }
  const feeds = [];
  for (const s of cfg.sources.sources || []) {
    for (const f of s.feeds || []) {
      const url = f.kind === 'gnews'
        ? `https://news.google.com/rss/search?q=${encodeURIComponent(f.query)}&hl=en-PK&gl=PK&ceid=PK:en`
        : f.url;
      feeds.push({ ...f, url, kind: f.kind || 'rss', sourceId: s.id, sourceName: s.name, sourceCountry: s.country, sourceTier: s.tier, sourceType: s.type, active: s.active !== false && f.active !== false, everyMin: f.everyMin || 30 });
    }
  }
  return { ...cfg, compiled: { entities, topics, urgency, pubIndex, feeds, regions: cfg.entities.regions || {} }, LEVELS };
}

export function resolvePublisherTier(cfg, publisherName, url) {
  const name = (publisherName || '').toLowerCase().trim();
  let host = '';
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { /* ignore */ }
  for (const p of cfg.compiled.pubIndex) {
    if (name && p.names.includes(name)) return { tier: p.tier, name: p.name, country: p.country };
    if (host && p.domains.some(d => host === d || host.endsWith('.' + d))) return { tier: p.tier, name: p.name, country: p.country };
  }
  return { tier: cfg.publishers.defaultTier ?? 4, name: publisherName || host || 'Unknown' };
}

export { LEVELS };
