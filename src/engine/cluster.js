// Deterministic story clustering.
// An article joins an existing story when (any of):
//   1. the same normalized headline was already seen (exact duplicate across publishers),
//   2. TF-IDF cosine similarity with the story >= SAME (same event, different wording),
//   3. headline token overlap (Jaccard) with any of the story's headlines >= TITLE_SAME,
//   4. moderate similarity >= RELATED AND >= 2 shared distinctive entities (an ongoing story's next development).
// Joining articles are classified as coverage (more sources) or a development (timeline entry).
import { tokenize, jaccard } from '../text.js';

export const THRESHOLDS = { SAME: 0.42, TITLE_SAME: 0.5, RELATED: 0.26, DEV_NOVELTY: 0.42, WINDOW_H: 72, ONGOING_WINDOW_H: 168 };

export function buildIdf(docs) {
  const df = new Map();
  for (const terms of docs) for (const t of new Set(terms)) df.set(t, (df.get(t) || 0) + 1);
  const N = docs.length || 1;
  return t => Math.log((N + 1) / ((df.get(t) || 0) + 1)) + 1;
}

export function termsOf(article, distinctive) {
  const terms = [];
  for (const t of article.titleTokens || []) terms.push(t, t); // title counts double
  for (const t of article.tokens || []) terms.push(t);
  for (const e of article.entities || []) { const w = distinctive.has(e) ? 3 : 1; for (let i = 0; i < w; i++) terms.push('@' + e); }
  return terms;
}

export function vectorize(terms, idf) {
  const v = new Map();
  for (const t of terms) v.set(t, (v.get(t) || 0) + 1);
  for (const [t, tf] of v) v.set(t, (1 + Math.log(tf)) * idf(t));
  return normalize(v);
}

function normalize(v) {
  let n = 0;
  for (const x of v.values()) n += x * x;
  n = Math.sqrt(n) || 1;
  for (const [k, x] of v) v.set(k, x / n);
  return v;
}

export function cosine(a, b) {
  const [s, l] = a.size < b.size ? [a, b] : [b, a];
  let d = 0;
  for (const [k, x] of s) { const y = l.get(k); if (y) d += x * y; }
  return d;
}

export function mergeVectors(storyVec, n, artVec, keep = 80) {
  const w = Math.min(n, 6);
  const out = new Map();
  for (const [k, x] of storyVec) out.set(k, x * w);
  for (const [k, x] of artVec) out.set(k, (out.get(k) || 0) + x);
  const top = [...out.entries()].sort((a, b) => b[1] - a[1]).slice(0, keep);
  return normalize(new Map(top));
}

export const vecToJson = v => Object.fromEntries([...v.entries()].map(([k, x]) => [k, Math.round(x * 1e4) / 1e4]));
export const vecFromJson = o => new Map(Object.entries(o || {}));

// In-memory index of recent stories used during one run.
export class StoryIndex {
  constructor(distinctive) { this.stories = new Map(); this.inv = new Map(); this.distinctive = distinctive; }
  add(s) {
    this.stories.set(s.id, s);
    for (const k of s.vec.keys()) { let set = this.inv.get(k); if (!set) this.inv.set(k, (set = new Set())); set.add(s.id); }
  }
  reindex(s, oldKeys) {
    for (const k of oldKeys) this.inv.get(k)?.delete(s.id);
    this.add(s);
  }
  candidates(vec, atMs) {
    const seen = new Set();
    for (const k of vec.keys()) for (const id of this.inv.get(k) || []) seen.add(id);
    const out = [];
    for (const id of seen) {
      const s = this.stories.get(id);
      const ageH = (atMs - s.updatedMs) / 3600e3;
      const window = s.developing ? THRESHOLDS.ONGOING_WINDOW_H : THRESHOLDS.WINDOW_H;
      if (ageH <= window && ageH >= -48) out.push(s);
    }
    return out;
  }
}

export function bestMatch(index, article, vec, atMs) {
  let best = null;
  const artEnts = new Set((article.entities || []).filter(e => index.distinctive.has(e)));
  const tt = new Set(article.titleTokens);
  for (const s of index.candidates(vec, atMs)) {
    if (s.titleHashes.has(article.title_hash)) return { story: s, sim: 1, titleSim: 1, reason: 'identical headline' };
    const sim = cosine(vec, s.vec);
    let titleSim = 0;
    for (const h of s.headlineTokens) titleSim = Math.max(titleSim, jaccard(tt, h));
    let sharedEnt = 0;
    for (const e of artEnts) if (s.distinctEntities.has(e)) sharedEnt++;
    let ok = null;
    if (sim >= THRESHOLDS.SAME) ok = 'same event (text similarity)';
    else if (titleSim >= THRESHOLDS.TITLE_SAME) ok = 'same event (headline overlap)';
    else if (sim >= THRESHOLDS.RELATED && sharedEnt >= 2) ok = 'ongoing story (shared entities)';
    if (!ok) continue;
    const strength = sim + titleSim * 0.5 + sharedEnt * 0.03;
    if (!best || strength > best.strength) best = { story: s, sim, titleSim, sharedEnt, reason: ok, strength };
  }
  return best;
}

// Decide whether a joining article is a new development of the story (timeline entry) or just more coverage.
export function classifyJoin(story, article, analysis) {
  const tt = new Set(article.titleTokens);
  let maxSim = 0;
  for (const h of story.headlineTokens) maxSim = Math.max(maxSim, jaccard(tt, h));
  const prevTokens = new Set();
  for (const h of story.headlineTokens) for (const t of h) prevTokens.add(t);
  const newTerms = article.titleTokens.filter(t => !prevTokens.has(t)).length;
  // A later, reliable headline with clearly new terms is a development even with moderate overlap
  // ("IMF talks expected this week" -> "IMF reaches staff-level agreement").
  const gapH = (Date.parse(article.published_at) - (story.lastDevMs || 0)) / 3600e3;
  const sig = analysis.signals;
  let novel = maxSim < THRESHOLDS.DEV_NOVELTY
    || (maxSim < 0.6 && newTerms >= 3 && article.tier <= 2 && gapH >= 2)
    // "IMF board approves tranche after staff-level agreement": restates context, but a later decision with new terms.
    || (maxSim < 0.85 && newTerms >= 2 && sig.urgency !== 'normal' && article.tier <= 2 && gapH >= 2);
  const escalating = sig.urgency === 'breaking' || (sig.casualties || 0) > (story.maxCasualties || 0);
  // Unverified outlets don't write the timeline of a story reliable sources are covering,
  // and rewrites arriving minutes after the last development are coverage, not news.
  if (article.tier >= 4 && story.tierBest <= 3) novel = false;
  if (novel && gapH < 1.5 && !escalating && maxSim >= 0.25) novel = false;
  const official = article.tier === 1 && !(story.tierBest <= 1);
  if (official && novel) return 'official';
  if (!novel) return 'coverage';
  if (sig.urgency === 'breaking' && story.maxUrgency !== 'breaking') return 'escalation';
  if ((sig.casualties || 0) > (story.maxCasualties || 0) * 1.5 && sig.casualties >= 5) return 'escalation';
  if (sig.urgency !== 'normal' || newTerms >= 2) return 'update';
  return 'coverage';
}

export { tokenize };
