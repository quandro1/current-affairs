// Transparent scoring: every point added or removed becomes a line in the breakdown,
// and every number comes from config/scoring.json or config/rules.json.
import { evaluate } from './conditions.js';

export const LEVELS = ['background', 'notable', 'important', 'critical'];
export const rank = l => LEVELS.indexOf(l);
export const maxLevel = (a, b) => (rank(a) >= rank(b) ? a : b);
export const minLevel = (a, b) => (rank(a) <= rank(b) ? a : b);

export function baseScore(cfg, facts) {
  const sc = cfg.scoring;
  const lines = [];
  const add = (kind, label, points) => { if (points) lines.push({ kind, label, points }); };

  // Geography
  if (facts.countries.includes('PK')) add('geography', sc.geography.pakistan.label, sc.geography.pakistan.points);
  else if (facts.majorCountry) add('geography', sc.geography.majorInternational.label, sc.geography.majorInternational.points);
  else add('geography', sc.geography.minorInternational.label, sc.geography.minorInternational.points);

  // Topic relevance: best matching factor, plus a small bonus when several distinct factors match
  const matched = sc.topicFactors.filter(f => evaluate(f.when, facts)).sort((a, b) => b.points - a.points);
  if (matched.length) {
    add('topic', matched[0].label, matched[0].points);
    if (matched.length > 1 && sc.secondaryTopicBonus) add('topic', `${sc.secondaryTopicBonus.label} (${matched.slice(1, 3).map(m => m.label).join(', ')})`, sc.secondaryTopicBonus.points);
  } else if (sc.penalties.noTopic) add('penalty', sc.penalties.noTopic.label, sc.penalties.noTopic.points);

  // Source reliability (best tier among the story's sources)
  const t = sc.tier[String(facts.tier)] || sc.tier['4'];
  add('source', t.label, t.points);

  // Urgency
  const u = sc.urgency[facts.urgency] || sc.urgency.normal;
  add('urgency', u.label, u.points);

  // Magnitude
  if (facts.casualties) { const m = sc.magnitude.casualties.find(x => facts.casualties >= x.gte); if (m) add('magnitude', `${m.label} — ${facts.casualties} reported`, m.points); }
  if (facts.pct != null && (facts.direction || facts.topics.some(x => ['inflation', 'interest-rates', 'currency', 'oil', 'markets', 'gold'].includes(x)))) {
    const m = sc.magnitude.percent.find(x => facts.pct >= x.gte);
    if (m) add('magnitude', `${m.label} — ${facts.pct}%`, m.points);
  }

  // Personal relevance (only the larger Flame On factor applies)
  if (facts.flameOnDirect) add('personal', sc.personal.flameOnDirect.label, sc.personal.flameOnDirect.points);
  else if (facts.flameOn) add('personal', sc.personal.flameOnIndirect.label, sc.personal.flameOnIndirect.points);
  if (facts.watch?.length) add('personal', `${sc.personal.watchlist.label}: ${facts.watchLabels.join(', ')}`, sc.personal.watchlist.points);

  // Corroboration: independent reliable (tier 1-3) publishers only
  const rel = facts.reliableCount ?? (facts.tier <= 3 ? 1 : 0);
  const co = sc.corroboration;
  if (rel > 1) add('corroboration', `${co.label} (${rel})`, Math.min(co.max, (rel - 1) * co.perExtraPublisher));
  if (co.widelyReported && rel >= co.widelyReported.minPublishers) add('corroboration', co.widelyReported.label, co.widelyReported.points);
  if (facts.tier1 && rel > 1) add('corroboration', co.tier1Confirmed.label, co.tier1Confirmed.points);

  // Penalties
  if (facts.opinion) add('penalty', sc.penalties.opinion.label, sc.penalties.opinion.points);
  if (facts.noise) add('penalty', sc.penalties.noise.label, sc.penalties.noise.points);
  if (facts.live) add('penalty', sc.penalties.liveBlog.label, sc.penalties.liveBlog.points);

  return lines;
}

export function levelFor(cfg, score) {
  const L = cfg.scoring.levels;
  return score >= L.critical ? 'critical' : score >= L.important ? 'important' : score >= L.notable ? 'notable' : 'background';
}

// Full evaluation: base score -> rules -> level -> safety caps.
export function scoreStory(cfg, facts) {
  const lines = baseScore(cfg, facts);
  let score = lines.reduce((s, l) => s + l.points, 0);
  const personal = lines.filter(l => l.kind === 'personal').reduce((s, l) => s + l.points, 0);
  const fired = [];
  let floor = 'background', ceil = 'critical', mute = false;
  const flags = {};
  for (const r of cfg.rules.rules) {
    if (r.enabled === false) continue;
    if (!evaluate(r.if, { ...facts, score, baseScore: score - personal })) continue;
    const t = r.then || {};
    fired.push(r.id);
    if (t.addScore) { score += t.addScore; lines.push({ kind: 'rule', label: t.label || `Rule ${r.id}`, points: t.addScore, rule: r.id }); }
    else lines.push({ kind: 'rule', label: t.label || `Rule ${r.id}`, points: 0, rule: r.id });
    if (t.minLevel) floor = maxLevel(floor, t.minLevel);
    if (t.maxLevel) ceil = minLevel(ceil, t.maxLevel);
    if (t.mute) mute = true;
    if (t.flag) Object.assign(flags, t.flag);
  }
  score = Math.max(0, Math.round(score));
  let level = maxLevel(levelFor(cfg, score), floor);
  level = minLevel(level, ceil);
  const caps = [];
  const req = cfg.scoring.criticalRequires;
  // A rule floor (e.g. mass-casualty) may force critical; otherwise personal points cannot be what makes it critical.
  if (level === 'critical' && floor !== 'critical' && req.minScoreExcludingPersonal && score - personal < req.minScoreExcludingPersonal) {
    level = 'important'; caps.push(req.personalLabel);
  }
  if (level === 'critical' && !((facts.reliableCount ?? 1) >= req.minPublishers || facts.tier <= req.orTier)) {
    level = 'important'; caps.push(req.label + ' — held at Important until corroborated');
  }
  const t4 = cfg.scoring.tier4MaxLevel;
  if (facts.tier >= 4 && rank(level) > rank(t4)) { level = t4; caps.push('Only unverified (tier 4) sources so far — capped at ' + t4); }
  const display = Math.min(cfg.scoring.maxScore || 100, score);
  return { score, display, level, lines, fired, mute, flags, caps };
}
