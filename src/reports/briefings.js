// Scheduled briefings and reports, built by deterministic aggregation of scored stories.
// Nothing here is generated prose: headings, rankings, counts and predefined template lines only.
import { J, S } from '../db.js';
import { localParts, zonedToUtc, addDays } from '../time.js';
import { snapshot } from './snapshot.js';
import { rank } from '../engine/score.js';

const H = 3600e3;
const SECTION_ORDER = ['pakistan', 'world', 'geopolitics', 'economy', 'technology'];

export function dueBriefings(db, prefs, now) {
  const tz = prefs.timezone;
  const nowMs = Date.parse(now);
  const lp = localParts(now, tz);
  const exists = id => !!db.prepare('SELECT 1 FROM briefings WHERE id=?').get(id);
  const out = [];
  const check = (kind, id, date, time, windowH, extra = {}) => {
    const at = zonedToUtc(date, time, tz).getTime();
    if (nowMs >= at && nowMs < at + windowH * H && !exists(id)) out.push({ kind, id, scheduledAt: new Date(at).toISOString(), localDate: date, ...extra });
  };
  if (prefs.daily?.enabled) check('daily', `daily-${lp.date}`, lp.date, prefs.daily.time, 12);
  if (prefs.evening?.enabled) check('evening', `evening-${lp.date}`, lp.date, prefs.evening.time, 4);
  if (prefs.weekly?.enabled && lp.dow === prefs.weekly.day) check('weekly', `weekly-${lp.date}`, lp.date, prefs.weekly.time, 24);
  if (prefs.monthly?.enabled && lp.day === Number(prefs.monthly.day)) {
    const prev = lp.month === 1 ? `${lp.year - 1}-12` : `${lp.year}-${String(lp.month - 1).padStart(2, '0')}`;
    check('monthly', `monthly-${prev}`, lp.date, prefs.monthly.time, 48, { month: prev });
  }
  return out;
}

// Level first (a Critical story always outranks an Important one), then score.
const storiesBetween = (db, from, to, minLevel = 'notable') =>
  db.prepare('SELECT * FROM stories WHERE last_dev_at>=? AND first_seen<=? ORDER BY score DESC').all(from, to)
    .filter(s => rank(s.level) >= rank(minLevel) && !s.muted)
    .sort((a, b) => rank(b.level) - rank(a.level) || b.score - a.score);

function pickSections(stories, exclude, perSection = 4) {
  const used = new Set(exclude);
  const out = {};
  for (const sec of SECTION_ORDER) {
    out[sec] = [];
    for (const s of stories) {
      if (out[sec].length >= perSection) break;
      if (used.has(s.id)) continue;
      if ((J(s.sections) || []).includes(sec)) { out[sec].push(s); used.add(s.id); }
    }
  }
  return out;
}

function reasonLine(snap) {
  const top = (snap.breakdown || []).filter(l => l.points > 0).sort((a, b) => b.points - a.points).slice(0, 3).map(l => l.label);
  return 'Prioritised because it matched: ' + top.join(' + ');
}

function counts(stories) {
  const c = { total: stories.length, critical: 0, important: 0, notable: 0, bySection: {} };
  for (const s of stories) {
    if (c[s.level] != null) c[s.level]++;
    for (const sec of J(s.sections) || []) c.bySection[sec] = (c.bySection[sec] || 0) + 1;
  }
  return c;
}

export function buildDaily(db, cfg, now, due) {
  const prev = db.prepare("SELECT created_at FROM briefings WHERE kind='daily' ORDER BY created_at DESC LIMIT 1").get();
  const from = new Date(Math.max(Date.parse(now) - 26 * H, prev ? Date.parse(prev.created_at) - 2 * H : 0)).toISOString();
  const pool = storiesBetween(db, from, now);
  const snap = s => snapshot(db, cfg, s);
  const top = pool.slice(0, 5);
  const secs = pickSections(pool, top.map(s => s.id));
  const fo = db.prepare("SELECT * FROM stories WHERE last_dev_at>=? AND sections LIKE '%flameon%' ORDER BY score DESC LIMIT 6").all(new Date(Date.parse(now) - 48 * H).toISOString()).filter(s => rank(s.level) >= rank('notable'));
  const one = top[0] ? snap(top[0]) : null;
  return {
    kind: 'daily', title: '🌍 Daily Intelligence', period: { from, to: now },
    top: top.map(snap),
    sections: Object.fromEntries(Object.entries(secs).map(([k, v]) => [k, v.map(snap)])),
    flameon: fo.map(snap),
    oneThing: one ? { story: one, fact: one.headline, context: one.why[0]?.text || null, reason: reasonLine(one) } : null,
    stats: counts(pool),
    empty: !pool.length
  };
}

export function buildEvening(db, cfg, now, due) {
  const tz = cfg.preferences.timezone;
  const lp = localParts(now, tz);
  const morning = db.prepare('SELECT created_at, json FROM briefings WHERE id=?').get(`daily-${lp.date}`);
  const since = morning ? morning.created_at : zonedToUtc(lp.date, cfg.preferences.daily?.time || '08:00', tz).toISOString();
  const seenMorning = new Set();
  if (morning) {
    const m = J(morning.json) || {};
    for (const s of m.top || []) seenMorning.add(s.id);
    for (const arr of Object.values(m.sections || {})) for (const s of arr) seenMorning.add(s.id);
  }
  const fresh = db.prepare('SELECT * FROM stories WHERE first_seen>=? ORDER BY score DESC').all(since).filter(s => rank(s.level) >= rank('notable') && !s.muted && !seenMorning.has(s.id));
  const esc = db.prepare(`SELECT DISTINCT s.* FROM stories s JOIN story_updates u ON u.story_id=s.id
      WHERE u.at>=? AND u.kind IN ('escalation','official','update') AND s.first_seen<? ORDER BY s.score DESC`).all(since, since)
    .filter(s => rank(s.level) >= rank('important') && !s.muted);
  const escalated = esc.filter(s => !seenMorning.has(s.id) || db.prepare("SELECT 1 FROM story_updates WHERE story_id=? AND at>=? AND kind IN ('escalation','official')").get(s.id, since));
  const snap = s => {
    const o = snapshot(db, cfg, s);
    o.newUpdates = (o.updates || []).filter(u => u.at >= since && u.kind !== 'new');
    return o;
  };
  return {
    kind: 'evening', title: '🌙 Evening Recap — what you might have missed', period: { from: since, to: now },
    fresh: fresh.slice(0, 8).map(snap), escalated: escalated.slice(0, 6).map(snap),
    empty: !fresh.length && !escalated.length,
    emptyText: 'Nothing new crossed your importance threshold since the morning briefing.'
  };
}

export function buildWeekly(db, cfg, now) {
  const from = new Date(Date.parse(now) - 7 * 24 * H).toISOString();
  const pool = storiesBetween(db, from, now);
  const snap = s => snapshot(db, cfg, s);
  const bySec = sec => pool.find(s => (J(s.sections) || []).includes(sec));
  const inBriefs = new Set();
  for (const b of db.prepare("SELECT json FROM briefings WHERE kind='daily' AND created_at>=?").all(from)) for (const s of (J(b.json)?.top || [])) inBriefs.add(s.id);
  const missed = pool.find(s => !inBriefs.has(s.id) && !s.notified_at) || pool.find(s => !inBriefs.has(s.id));
  const devCounts = db.prepare(`SELECT story_id, COUNT(*) n, SUM(kind='escalation') e FROM story_updates WHERE at>=? AND kind!='new' GROUP BY story_id ORDER BY n DESC`).all(from);
  const poolIds = new Map(pool.map(s => [s.id, s]));
  const changed = devCounts.filter(d => poolIds.has(d.story_id)).slice(0, 5).map(d => ({ ...snap(poolIds.get(d.story_id)), developments: d.n, escalations: d.e }));
  const recent = new Date(Date.parse(now) - 48 * H).toISOString();
  const watchNext = pool.filter(s => s.last_dev_at >= recent && (db.prepare("SELECT COUNT(*) n FROM story_updates WHERE story_id=? AND kind!='coverage'").get(s.id).n >= 3 || (J(s.watch) || []).length))
    .slice(0, 5).map(snap);
  const pick = s => (s ? snap(s) : null);
  return {
    kind: 'weekly', title: '🗓️ Weekly Report', period: { from, to: now },
    biggest: pick(pool[0]),
    pakistan: pick(bySec('pakistan')), geopolitics: pick(bySec('geopolitics')), economy: pick(bySec('economy')), technology: pick(bySec('technology')),
    missed: pick(missed),
    changed,
    watchNext, watchNextNote: 'Ongoing stories with recent activity (3+ developments, or on your watchlist). This is a list of active stories, not a forecast.',
    stats: counts(pool)
  };
}

export function buildMonthly(db, cfg, now, due) {
  const tz = cfg.preferences.timezone;
  const [y, m] = due.month.split('-').map(Number);
  const startDate = `${due.month}-01`;
  const endDate = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  const from = zonedToUtc(startDate, '00:00', tz).toISOString(), to = zonedToUtc(endDate, '00:00', tz).toISOString();
  const prevStart = m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, '0')}-01`;
  const pFrom = zonedToUtc(prevStart, '00:00', tz).toISOString();
  const pool = storiesBetween(db, from, to);
  const prevPool = storiesBetween(db, pFrom, from);
  const names = new Map(cfg.compiled.entities.map(e => [e.id, e.name]));
  const tlabels = new Map(cfg.compiled.topics.map(t => [t.id, t.label]));
  const freq = (arr, key) => { const c = new Map(); for (const s of arr) for (const x of J(s[key]) || []) c.set(x, (c.get(x) || 0) + 1); return c; };
  const ent = freq(pool, 'entities'), top = freq(pool, 'topics'), ptop = freq(prevPool, 'topics');
  const ranked = (c, lab, n = 10) => [...c.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([id, count]) => ({ id, label: lab.get(id) || id, count }));
  const trendFor = sec => {
    const ss = pool.filter(s => (J(s.sections) || []).includes(sec));
    const tc = freq(ss, 'topics');
    return { stories: ss.length, top: ss.slice(0, 3).map(s => snapshot(db, cfg, s, { full: false })), topics: ranked(tc, tlabels, 5).map(t => ({ ...t, previousMonth: ptop.get(t.id) || 0 })) };
  };
  const weeks = [];
  for (let d = startDate; d < endDate; d = addDays(d, 7)) {
    const wf = zonedToUtc(d, '00:00', tz).toISOString(), wt = zonedToUtc(addDays(d, 7) < endDate ? addDays(d, 7) : endDate, '00:00', tz).toISOString();
    const ws = pool.filter(s => s.first_seen >= wf && s.first_seen < wt);
    weeks.push({ from: d, total: ws.length, ...Object.fromEntries(['pakistan', 'geopolitics', 'economy', 'technology'].map(sec => [sec, ws.filter(s => (J(s.sections) || []).includes(sec)).length])) });
  }
  return {
    kind: 'monthly', title: `📊 Monthly Report — ${new Date(Date.UTC(y, m - 1, 15)).toLocaleString('en-GB', { month: 'long', year: 'numeric' })}`,
    period: { from, to },
    stats: { ...counts(pool), major: pool.filter(s => rank(s.level) >= rank('important')).length, previousMonthTotal: prevPool.length },
    topStories: pool.slice(0, 10).map(s => snapshot(db, cfg, s, { full: false })),
    topEntities: ranked(ent, names, 12),
    topTopics: ranked(top, tlabels, 12).map(t => ({ ...t, previousMonth: ptop.get(t.id) || 0 })),
    trends: { pakistan: trendFor('pakistan'), economy: trendFor('economy'), geopolitics: trendFor('geopolitics'), technology: trendFor('technology'), business: trendFor('hospitality'), flameon: trendFor('flameon') },
    weeks,
    note: 'All figures are counts of stories that reached Notable or above. Trends compare topic counts with the previous month; no conclusions are inferred.'
  };
}

const BUILDERS = { daily: buildDaily, evening: buildEvening, weekly: buildWeekly, monthly: buildMonthly };

export function generateDue(db, cfg, now, appUrl = '') {
  const prefs = cfg.preferences;
  const made = [];
  for (const due of dueBriefings(db, prefs, now)) {
    const b = BUILDERS[due.kind](db, cfg, now, due);
    b.id = due.id; b.createdAt = now; b.scheduledAt = due.scheduledAt;
    db.prepare('INSERT INTO briefings(id,kind,period_start,period_end,created_at,json) VALUES(?,?,?,?,?,?)').run(due.id, due.kind, b.period.from, b.period.to, now, S(b));
    made.push(b);
    if (prefs[due.kind]?.push !== false) {
      const { title, body } = briefingPush(b);
      db.prepare("INSERT INTO notifications(briefing_id,kind,level,title,body,url,reason,created_at,deliver_after,status) VALUES(?,?,?,?,?,?,?,?,?,'pending')")
        .run(due.id, 'briefing', 'notable', title, body, `${appUrl}#/briefing/${due.id}`, S({ tag: due.kind }), now, now);
    }
  }
  return made;
}

export function briefingPush(b) {
  const heads = (arr, n) => (arr || []).filter(Boolean).slice(0, n).map(s => '• ' + s.headline);
  if (b.kind === 'daily') return { title: '☀️ Your daily intelligence is ready', body: b.empty ? 'A quiet 24 hours — nothing crossed your threshold.' : heads(b.top, 3).join('\n') };
  if (b.kind === 'evening') return { title: '🌙 Evening recap', body: b.empty ? b.emptyText : heads([...b.escalated, ...b.fresh], 3).join('\n') };
  if (b.kind === 'weekly') return { title: '🗓️ Your weekly report', body: b.biggest ? 'Biggest story: ' + b.biggest.headline : 'A quiet week.' };
  return { title: b.title, body: `${b.stats.total} notable stories · ${b.stats.major} major` };
}
