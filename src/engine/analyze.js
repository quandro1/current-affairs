// Deterministic enrichment: entities, countries, topics, sections and signals
// (urgency, price direction, % change, casualties, opinion/noise flags).
import { wordNum } from '../text.js';

function countMatches(re, text) {
  if (!re || !text) return 0;
  re.lastIndex = 0;
  let n = 0;
  while (re.exec(text)) { n++; if (n > 9) break; }
  return n;
}
const hits = (e, text) => countMatches(e.re, text) + countMatches(e.reCs, text);

export function matchEntities(cfg, title, excerpt) {
  const out = [];
  for (const e of cfg.compiled.entities) {
    const t = hits(e, title), x = excerpt ? hits(e, excerpt) : 0;
    if (t || x) out.push({ id: e.id, inTitle: t > 0, n: t + x });
  }
  return out;
}

export function matchTopics(cfg, title, excerpt, entityIds) {
  const out = [];
  for (const t of cfg.compiled.topics) {
    const inTitle = hits(t, title);
    const inEx = excerpt ? hits(t, excerpt) : 0;
    const viaEntity = (t.entities || []).some(id => entityIds.includes(id));
    if (inTitle || inEx >= 2 || viaEntity) out.push(t.id);
  }
  return out;
}

const UP = /\b(increase[sd]?|increasing|hikes?|hiked|raises?|raised|rises?|rising|rose|surges?|surged|soars?|soared|jumps?|jumped|climbs?|climbed|spikes?|spiked|higher|record high|costlier|up by|goes up|went up|to rise|inflat(es|ed))\b/i;
const DOWN = /\b(cuts?|slashe?s?d?|decrease[sd]?|decreasing|reduces?|reduced|reduction|falls?|fell|falling|drops?|dropped|declines?|declined|plunges?|plunged|tumbles?|tumbled|lowers?|lowered|cheaper|down by|goes down|went down|eases?|eased|slides?|slid)\b/i;

export function priceDirection(text) {
  const u = text.search(UP), d = text.search(DOWN);
  if (u < 0 && d < 0) return null;
  if (u >= 0 && d < 0) return 'up';
  if (d >= 0 && u < 0) return 'down';
  return u < d ? 'up' : 'down';
}

export function maxPercent(text) {
  let m, best = null;
  const re = /(\d{1,3}(?:\.\d+)?)\s?(?:%|percent|per cent)/gi;
  while ((m = re.exec(text))) { const v = Number(m[1]); if (v <= 100 && (best == null || v > best)) best = v; }
  return best;
}

const N = '(\\d[\\d,]*|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|dozens|dozen|scores|hundreds)';
const CAS = [
  new RegExp(`\\b${N}\\s+(?:people\\s+|persons\\s+|civilians\\s+|soldiers\\s+|policemen\\s+|personnel\\s+|passengers\\s+|children\\s+)?(?:were\\s+|are\\s+|have been\\s+)?(?:killed|dead|died|martyred|slain|perish(?:ed)?)`, 'gi'),
  // Victims only: "security forces kill 20 terrorists" is not a casualty count.
  new RegExp(`\\b(?:kills?|killing|killed|martyrs?|claims?)\\s+(?:at least\\s+|nearly\\s+|over\\s+|more than\\s+)?${N}\\b(?!\\s+(?:more\\s+)?(?:[\\w-]+\\s+)?(?:terrorists?|militants?|khawarij|insurgents?|attackers|gunmen|suspects?|dacoits|bandits))`, 'gi'),
  new RegExp(`\\bdeath toll\\s+(?:rises\\s+|climbs\\s+|reaches\\s+|hits\\s+)?(?:to\\s+)?${N}`, 'gi')
];
export function casualties(text) {
  let best = 0;
  for (const re of CAS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) { const v = wordNum(m[1]); if (Number.isFinite(v) && v < 100000 && v > best) best = v; }
  }
  return best || null;
}

const OPINION_URL = /\/(opinion|opinions|editorial|editorials|blogs?|columns?|comment|commentisfree|op-ed|letters)\//i;
const OPINION_TITLE = /^(opinion|editorial|comment|analysis|column|letter|op-ed)\s*[:|-]/i;
const LIVE = /\b(live updates?|as it happened|live:|LIVE\b|live blog)/;

export function analyzeArticle(cfg, a) {
  const title = a.title, excerpt = a.excerpt || '';
  const text = title + ' . ' + excerpt;
  const ents = matchEntities(cfg, title, excerpt);
  const entityIds = ents.map(e => e.id);
  const byId = new Map(cfg.compiled.entities.map(e => [e.id, e]));
  const countries = new Set();
  for (const e of ents) { const c = byId.get(e.id)?.country; if (c) countries.add(c); }
  if (!countries.size && a.defaultCountry) countries.add(a.defaultCountry);
  const topics = matchTopics(cfg, title, excerpt, entityIds);

  const sc = cfg.scoring;
  let urgency = 'normal';
  if (cfg.compiled.urgency.breaking.some(r => r.test(title))) urgency = 'breaking';
  else if (cfg.compiled.urgency.major.some(r => r.test(title))) urgency = 'major';

  const noiseTopics = new Set(cfg.compiled.topics.filter(t => t.noise).map(t => t.id));
  const signals = {
    urgency,
    direction: priceDirection(title) || priceDirection(excerpt),
    pct: maxPercent(text),
    casualties: casualties(text),
    opinion: OPINION_URL.test(a.url) || OPINION_TITLE.test(title),
    live: LIVE.test(title),
    noise: topics.some(t => noiseTopics.has(t))
  };
  const cl = [...countries];
  const majorCountry = cl.some(c => sc.geography.majorCountries.includes(c));
  return { entities: entityIds, entityHits: ents, countries: cl, topics, signals, majorCountry, sections: sectionsFor(cfg, cl, topics, majorCountry) };
}

const GEO_TOPICS = ['conflict', 'diplomacy', 'sanctions', 'nuclear'];
const WORLD_TOPICS = ['elections', 'intl-orgs', 'conflict', 'diplomacy', 'sanctions', 'security', 'politics', 'law', 'society', 'nuclear', 'foreign-policy'];
export function sectionsFor(cfg, countries, topics, majorCountry) {
  const s = new Set();
  const topicSec = new Map(cfg.compiled.topics.map(t => [t.id, t.section]));
  const isPK = countries.includes('PK');
  if (isPK) s.add('pakistan');
  const nonPK = countries.filter(c => c !== 'PK');
  if (topics.some(t => GEO_TOPICS.includes(t)) && (majorCountry || nonPK.length) && (nonPK.length || !isPK)) s.add('geopolitics');
  if (isPK && nonPK.length && topics.some(t => ['foreign-policy', 'diplomacy', 'security', 'trade'].includes(t)) && nonPK.some(c => cfg.scoring.geography.majorCountries.includes(c))) s.add('geopolitics');
  for (const t of topics) {
    const sec = topicSec.get(t);
    if (['economy', 'technology', 'hospitality'].includes(sec)) s.add(sec);
  }
  if (!isPK && (topics.some(t => WORLD_TOPICS.includes(t)) || (!s.size && countries.length))) s.add('world');
  return [...s];
}
