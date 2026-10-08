// Notification decision: protects attention. A story interrupts only when it is important enough,
// passes your settings, has not already been reported at this level, and limits allow it.
import { J, S } from '../db.js';
import { rank } from '../engine/score.js';
import { inQuietHours, quietEnds } from '../time.js';

const H = 3600e3;
const SEV_MIN = { critical: 'critical', 'critical+important': 'important', all: 'notable' };
const ICON = { critical: '🔴', important: '🟠', notable: '🟡', background: '⚪' };
const LABEL = { critical: 'CRITICAL', important: 'IMPORTANT', notable: 'NOTABLE', background: 'BACKGROUND' };

export function sectionLabel(cfg, sections) {
  const map = new Map(cfg.categories.sections.map(s => [s.id, s.label]));
  return (sections || []).filter(s => s !== 'flameon').slice(0, 2).map(s => map.get(s) || s).join(' · ') || 'World';
}

export function composeAlert(cfg, story, kind, appUrl) {
  const sections = J(story.sections) || [];
  const flags = J(story.flags) || {};
  const why = J(story.why) || [];
  const fo = J(story.flameon) || [];
  const lines = (J(story.breakdown) || []).filter(l => l.points > 0 && l.kind !== 'source').sort((a, b) => b.points - a.points).slice(0, 3).map(l => l.label);
  const pubs = (flags.publishers || []).sort((a, b) => a.tier - b.tier).slice(0, 4).map(p => p.name);
  const prefix = kind === 'update' ? 'UPDATE · ' : '';
  const title = `${ICON[story.level]} ${prefix}${LABEL[story.level]} · ${sectionLabel(cfg, sections)}`;
  const headline = kind === 'update' && story.latest_headline ? story.latest_headline : story.headline;
  const parts = [headline];
  if (fo.length && sections.includes('flameon')) parts.push('🔥 Flame On: ' + fo[0].text);
  else if (why.length) parts.push('Context (template): ' + why[0].text);
  parts.push('Matched: ' + lines.join(' · '));
  parts.push('Sources: ' + pubs.join(' • ') + (flags.unverified ? ' (unverified)' : ''));
  return { title, body: parts.join('\n'), url: `${appUrl || ''}#/story/${story.id}`, tag: `story-${story.id}` };
}

export function decideAlerts(db, cfg, results, now, { bootstrap = false, appUrl = '' } = {}) {
  const prefs = cfg.preferences;
  const tz = prefs.timezone;
  const nowMs = Date.parse(now);
  const minLvl = SEV_MIN[prefs.severity] || 'important';
  const limits = prefs.limits || {};
  const created = [], skipped = [];
  const getStory = db.prepare('SELECT * FROM stories WHERE id=?');
  const markStory = db.prepare('UPDATE stories SET notified_level=?, notified_at=? WHERE id=?');
  const ins = db.prepare('INSERT INTO notifications(story_id,kind,level,title,body,url,reason,created_at,deliver_after,status,status_reason) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
  const markArticles = db.prepare("UPDATE articles SET notification_status=? WHERE story_id=? AND notification_status='none'");
  const countSince = db.prepare("SELECT COUNT(*) n FROM notifications WHERE kind IN ('alert','update') AND status IN ('sent','pending','held') AND level!='critical' AND created_at>=?");

  // Highest level first so limits are spent on the most important stories.
  const ordered = [...results].sort((a, b) => rank(b.level) - rank(a.level) || b.score - a.score);
  for (const r of ordered) {
    const st = getStory.get(r.id);
    const skip = reason => { skipped.push({ id: r.id, reason }); };
    if (bootstrap) { if (rank(st.level) >= rank('notable')) markStory.run(st.level, now, st.id); skip('bootstrap: first run, existing news is not pushed'); continue; }
    if (st.muted) { skip('muted by rule'); continue; }
    if (rank(st.level) < rank(minLvl)) { skip(`below your severity setting (${prefs.severity})`); continue; }
    const sections = J(st.sections) || [];
    const watch = J(st.watch) || [];
    const enabled = sections.filter(s => prefs.topics?.[s] !== false);
    if (sections.length ? !enabled.length : !watch.length) { skip('all its sections are switched off'); continue; }
    if ((st.tier_best ?? 4) >= 4) { skip('unverified sources only'); continue; }

    const prev = st.notified_level;
    let kind = null, reason = '';
    if (!prev) {
      const ageH = (nowMs - Date.parse(st.first_seen)) / H;
      if (ageH > (limits.maxAgeHours ?? 12)) { skip('story is older than maxAgeHours'); markStory.run(st.level, now, st.id); continue; }
      kind = 'alert'; reason = 'new story reached ' + st.level;
    } else if (rank(st.level) > rank(prev)) {
      kind = 'alert'; reason = `escalated from ${prev} to ${st.level}`;
    } else {
      const dev = r.devIds?.length ? db.prepare(`SELECT kind FROM story_updates WHERE id IN (${r.devIds.map(Number).join(',')}) AND kind IN ('escalation','official')`).get() : null;
      const since = st.notified_at ? (nowMs - Date.parse(st.notified_at)) / H : 99;
      if (dev && rank(st.level) >= rank('important') && since >= (limits.updateCooldownHours ?? 4)) { kind = 'update'; reason = `significant ${dev.kind} on a story already reported`; }
      else { skip(prev === st.level ? 'already reported at this level' : 'lower than previously reported'); continue; }
    }

    let status = 'pending', statusReason = null, deliverAfter = now;
    if (st.level !== 'critical') {
      const hour = countSince.get(new Date(nowMs - H).toISOString()).n;
      const day = countSince.get(new Date(nowMs - 24 * H).toISOString()).n;
      if (hour >= (limits.maxPerHour ?? 3) || day >= (limits.maxPerDay ?? 12)) { status = 'suppressed'; statusReason = 'rate limit reached — will appear in the next briefing'; }
    }
    if (status === 'pending' && inQuietHours(now, prefs.quietHours, tz) && !(st.level === 'critical' && prefs.quietHours.criticalBypass)) {
      status = 'held'; deliverAfter = quietEnds(now, prefs.quietHours, tz).toISOString(); statusReason = 'quiet hours';
    }
    const msg = composeAlert(cfg, st, kind, appUrl);
    const res = ins.run(st.id, kind, st.level, msg.title, msg.body, msg.url, S({ reason, tag: msg.tag }), now, deliverAfter, status, statusReason);
    markStory.run(st.level, now, st.id);
    markArticles.run(status === 'suppressed' ? 'suppressed' : 'notified', st.id);
    created.push({ id: Number(res.lastInsertRowid), storyId: st.id, kind, level: st.level, status, reason });
  }
  return { created, skipped };
}

// Held (quiet-hours) notifications whose time has come: one becomes pending; several are merged
// into a single digest so you are not woken by a burst.
export function releaseHeld(db, cfg, now, appUrl = '') {
  const due = db.prepare("SELECT * FROM notifications WHERE status='held' AND deliver_after<=? ORDER BY created_at").all(now);
  if (!due.length) return 0;
  if (due.length === 1) { db.prepare("UPDATE notifications SET status='pending', status_reason='released after quiet hours' WHERE id=?").run(due[0].id); return 1; }
  const heads = due.map(n => '• ' + n.body.split('\n')[0]).slice(0, 6);
  const top = due.reduce((a, n) => (rank(n.level) > rank(a.level) ? n : a), due[0]);
  const r = db.prepare("INSERT INTO notifications(kind,level,title,body,url,reason,created_at,deliver_after,status) VALUES('digest',?,?,?,?,?,?,?,'pending')")
    .run(top.level, `${ICON[top.level]} ${due.length} alerts during quiet hours`, heads.join('\n'), `${appUrl}#/changed`, S({ merged: due.map(n => n.id), tag: 'quiet-digest' }), now, now);
  db.prepare(`UPDATE notifications SET status='merged', status_reason=? WHERE id IN (${due.map(n => n.id).join(',')})`).run('merged into digest #' + r.lastInsertRowid);
  return due.length;
}

export { ICON, LABEL };
