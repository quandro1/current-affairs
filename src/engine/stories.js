// Article intake -> dedupe -> enrich -> cluster into stories -> (re)score stories.
import { J, S, tx } from '../db.js';
import { analyzeArticle, sectionsFor } from './analyze.js';
import { scoreStory, rank, maxLevel } from './score.js';
import { evaluate } from './conditions.js';
import { buildIdf, termsOf, vectorize, bestMatch, classifyJoin, mergeVectors, vecToJson, vecFromJson, StoryIndex, THRESHOLDS, cosine } from './cluster.js';
import { tokenize, jaccard } from '../text.js';

const H = 3600e3;
const URG = ['normal', 'major', 'breaking'];
const pubKey = p => (p || '').toLowerCase().replace(/^the\s+/, '').replace(/[^a-z0-9]/g, '').slice(0, 24);

function articleFacts(cfg, a, an) {
  return {
    countries: an.countries, topics: an.topics, entities: an.entities, sections: an.sections,
    tier: a.tier, tier1: a.tier === 1, sourceCount: 1, reliableCount: a.tier <= 3 ? 1 : 0, ...an.signals, majorCountry: an.majorCountry,
    text: a.title + ' . ' + (a.excerpt || ''), title: a.title, flameOn: false, watch: [], watchLabels: [], ageHours: 0
  };
}

export function ingestArticles(db, cfg, provider, articles, now) {
  const nowMs = Date.parse(now);
  const existsUrl = db.prepare('SELECT 1 FROM articles WHERE url_canon=?');
  const existsTitle = db.prepare('SELECT 1 FROM articles WHERE title_hash=? AND lower(publisher)=lower(?) AND published_at>=?');
  const ins = db.prepare(`INSERT INTO articles(feed_id,source_id,publisher,tier,url,url_canon,title,title_norm,title_hash,author,excerpt,published_at,published_estimated,retrieved_at,category,tokens,countries,topics,entities,signals,score,breakdown)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const fresh = [];
  const seenBatch = new Set();
  let dupUrl = 0, dupTitle = 0;
  tx(db, () => {
    for (const a of articles) {
      if (seenBatch.has(a.url_canon) || existsUrl.get(a.url_canon)) { dupUrl++; continue; }
      const k = a.title_hash + '|' + pubKey(a.publisher);
      if (seenBatch.has(k) || existsTitle.get(a.title_hash, a.publisher, new Date(nowMs - 96 * H).toISOString())) { dupTitle++; continue; }
      seenBatch.add(a.url_canon); seenBatch.add(k);
      const an = analyzeArticle(cfg, a);
      const sc = scoreStory(cfg, articleFacts(cfg, a, an));
      const r = ins.run(a.feed_id, a.source_id, a.publisher, a.tier, a.url, a.url_canon, a.title, a.title_norm, a.title_hash, a.author, a.excerpt,
        a.published_at, a.published_estimated, a.retrieved_at, a.category, S({ t: a.titleTokens, x: a.tokens }),
        S(an.countries), S(an.topics), S(an.entities), S(an.signals), sc.score, S(sc.lines));
      fresh.push({ ...a, id: Number(r.lastInsertRowid), analysis: an, entities: an.entities });
    }
  });
  const res = clusterArticles(db, cfg, fresh, now);
  const results = [];
  tx(db, () => {
    for (const id of res.touched) results.push(recomputeStory(db, cfg, provider, id, now, res.devsByStory.get(id) || []));
  });
  return { inserted: fresh.length, dupUrl, dupTitle, stories: results, created: res.created };
}

function loadIndex(db, cfg, distinctive, now) {
  const index = new StoryIndex(distinctive);
  const since = new Date(Date.parse(now) - THRESHOLDS.ONGOING_WINDOW_H * H).toISOString();
  const rows = db.prepare('SELECT id, headline, updated_at, last_dev_at, vector, entities, tier_best, flags, article_count FROM stories WHERE updated_at>=? AND vector IS NOT NULL').all(since);
  const upd = db.prepare('SELECT headline FROM story_updates WHERE story_id=?');
  const hashes = db.prepare('SELECT title_hash FROM articles WHERE story_id=?');
  for (const r of rows) {
    const flags = J(r.flags) || {};
    const heads = upd.all(r.id).map(x => new Set(tokenize(x.headline)));
    heads.push(new Set(tokenize(r.headline)));
    index.add({
      id: r.id, vec: vecFromJson(J(r.vector)), updatedMs: Date.parse(r.updated_at), lastDevMs: Date.parse(r.last_dev_at), n: r.article_count,
      titleHashes: new Set(hashes.all(r.id).map(x => x.title_hash)), headlineTokens: heads,
      distinctEntities: new Set((J(r.entities) || []).filter(e => distinctive.has(e))),
      tierBest: r.tier_best ?? 4, maxUrgency: flags.maxUrgency || 'normal', maxCasualties: flags.maxCasualties || 0,
      developing: heads.length >= 3
    });
  }
  return index;
}

export function clusterArticles(db, cfg, fresh, now) {
  const nowMs = Date.parse(now);
  const distinctive = new Set(cfg.compiled.entities.filter(e => e.distinctive).map(e => e.id));
  const since = new Date(nowMs - THRESHOLDS.WINDOW_H * H).toISOString();
  const recentDocs = db.prepare('SELECT tokens, entities FROM articles WHERE retrieved_at>=? AND story_id IS NOT NULL').all(since)
    .map(r => { const t = J(r.tokens) || {}; return termsOf({ titleTokens: t.t || [], tokens: t.x || [], entities: J(r.entities) || [] }, distinctive); });
  const idf = buildIdf([...recentDocs, ...fresh.map(a => termsOf(a, distinctive))]);
  const index = loadIndex(db, cfg, distinctive, now);

  const touched = new Set(), created = [];
  const devsByStory = new Map();
  const setStory = db.prepare('UPDATE articles SET story_id=? WHERE id=?');
  const link = db.prepare('INSERT OR IGNORE INTO story_articles(story_id,article_id,relation,similarity) VALUES(?,?,?,?)');
  const addUpd = db.prepare('INSERT INTO story_updates(story_id,article_id,at,kind,headline,publisher,url,tier) VALUES(?,?,?,?,?,?,?,?)');
  const newStory = db.prepare(`INSERT INTO stories(headline,latest_headline,first_seen,updated_at,last_dev_at,entities,tier_best,flags,vector,source_count,article_count) VALUES(?,?,?,?,?,?,?,?,?,1,1)`);
  const saveVec = db.prepare('UPDATE stories SET vector=?, updated_at=?, entities=? WHERE id=?');

  fresh.sort((a, b) => a.published_at.localeCompare(b.published_at));
  tx(db, () => {
    for (const a of fresh) {
      const vec = vectorize(termsOf(a, distinctive), idf);
      const at = a.published_at < a.retrieved_at ? a.published_at : a.retrieved_at;
      const atMs = Date.parse(at);
      const m = bestMatch(index, a, vec, atMs);
      const sig = a.analysis.signals;
      if (m) {
        const s = m.story;
        const rel = classifyJoin(s, a, a.analysis);
        setStory.run(s.id, a.id);
        link.run(s.id, a.id, rel === 'coverage' ? 'coverage' : 'update', Math.round(m.sim * 1000) / 1000);
        if (rel !== 'coverage') {
          const r = addUpd.run(s.id, a.id, at, rel, a.title, a.publisher, a.url, a.tier);
          s.headlineTokens.push(new Set(a.titleTokens));
          s.lastDevMs = Math.max(s.lastDevMs || 0, atMs);
          (devsByStory.get(s.id) || devsByStory.set(s.id, []).get(s.id)).push(Number(r.lastInsertRowid));
        }
        const oldKeys = [...s.vec.keys()];
        s.vec = mergeVectors(s.vec, s.n, vec); s.n++;
        s.titleHashes.add(a.title_hash);
        for (const e of a.entities) if (distinctive.has(e)) s.distinctEntities.add(e);
        s.tierBest = Math.min(s.tierBest, a.tier);
        if (URG.indexOf(sig.urgency) > URG.indexOf(s.maxUrgency)) s.maxUrgency = sig.urgency;
        s.maxCasualties = Math.max(s.maxCasualties, sig.casualties || 0);
        s.updatedMs = Math.max(s.updatedMs, atMs);
        s.developing = s.headlineTokens.length >= 3;
        index.reindex(s, oldKeys);
        touched.add(s.id);
      } else {
        const r = newStory.run(a.title, a.title, at, at, at, S(a.entities), a.tier, S({ maxUrgency: sig.urgency, maxCasualties: sig.casualties || 0 }), S(vecToJson(vec)));
        const id = Number(r.lastInsertRowid);
        setStory.run(id, a.id);
        link.run(id, a.id, 'origin', 1);
        const u = addUpd.run(id, a.id, at, 'new', a.title, a.publisher, a.url, a.tier);
        devsByStory.set(id, [Number(u.lastInsertRowid)]);
        index.add({ id, vec, updatedMs: atMs, lastDevMs: atMs, n: 1, titleHashes: new Set([a.title_hash]), headlineTokens: [new Set(a.titleTokens)],
          distinctEntities: new Set(a.entities.filter(e => distinctive.has(e))), tierBest: a.tier, maxUrgency: sig.urgency, maxCasualties: sig.casualties || 0, developing: false });
        touched.add(id); created.push(id);
      }
    }
    mergePass(db, index, touched, devsByStory, created);
    for (const id of touched) {
      const s = index.stories.get(id);
      saveVec.run(S(vecToJson(s.vec)), new Date(s.updatedMs).toISOString(), S([...new Set([...(s.distinctEntities || [])])]), id);
    }
  });
  return { touched, created, devsByStory };
}

// Two clusters that formed around the same event (e.g. early and late wording of one announcement)
// are merged into the older story; its timeline keeps only genuinely different headlines.
export const MERGE = { SIM: 0.5, TITLE: 0.6 };
function mergePass(db, index, touched, devsByStory, created) {
  const gone = new Set();
  for (const id of [...touched]) {
    if (gone.has(id)) continue;
    let s = index.stories.get(id);
    if (!s) continue;
    for (const o of index.candidates(s.vec, s.updatedMs)) {
      if (o.id === s.id || gone.has(o.id)) continue;
      const sim = cosine(s.vec, o.vec);
      let tsim = 0;
      for (const a of s.headlineTokens) for (const b of o.headlineTokens) tsim = Math.max(tsim, jaccard(a, b));
      if (sim < MERGE.SIM && tsim < MERGE.TITLE) continue;
      const [keep, drop] = o.id < s.id ? [o, s] : [s, o];
      const kept = mergeInto(db, keep, drop);
      const oldKeys = [...keep.vec.keys()];
      keep.vec = mergeVectors(keep.vec, keep.n, drop.vec); keep.n += drop.n;
      for (const h of drop.titleHashes) keep.titleHashes.add(h);
      keep.headlineTokens.push(...kept.tokens);
      for (const e of drop.distinctEntities) keep.distinctEntities.add(e);
      keep.tierBest = Math.min(keep.tierBest, drop.tierBest);
      if (URG.indexOf(drop.maxUrgency) > URG.indexOf(keep.maxUrgency)) keep.maxUrgency = drop.maxUrgency;
      keep.maxCasualties = Math.max(keep.maxCasualties, drop.maxCasualties);
      keep.updatedMs = Math.max(keep.updatedMs, drop.updatedMs);
      keep.developing = keep.headlineTokens.length >= 3;
      for (const k of drop.vec.keys()) index.inv.get(k)?.delete(drop.id);
      index.stories.delete(drop.id);
      index.reindex(keep, oldKeys);
      const dv = (devsByStory.get(drop.id) || []).filter(x => kept.ids.has(x));
      devsByStory.set(keep.id, [...(devsByStory.get(keep.id) || []), ...dv]);
      devsByStory.delete(drop.id);
      gone.add(drop.id); touched.delete(drop.id); touched.add(keep.id);
      const ci = created.indexOf(drop.id); if (ci >= 0) created.splice(ci, 1);
      if (drop === s) break;
      s = keep;
    }
  }
  return gone;
}

function mergeInto(db, keep, drop) {
  db.prepare('UPDATE articles SET story_id=? WHERE story_id=?').run(keep.id, drop.id);
  db.prepare(`INSERT OR IGNORE INTO story_articles(story_id,article_id,relation,similarity)
    SELECT ?, article_id, CASE relation WHEN 'origin' THEN 'coverage' ELSE relation END, similarity FROM story_articles WHERE story_id=?`).run(keep.id, drop.id);
  db.prepare('DELETE FROM story_articles WHERE story_id=?').run(drop.id);
  const ids = new Set(), tokens = [];
  for (const u of db.prepare('SELECT id, headline FROM story_updates WHERE story_id=? ORDER BY at').all(drop.id)) {
    const t = new Set(tokenize(u.headline));
    let dup = false;
    for (const h of [...keep.headlineTokens, ...tokens]) if (jaccard(t, h) >= THRESHOLDS.DEV_NOVELTY) { dup = true; break; }
    if (dup) db.prepare('DELETE FROM story_updates WHERE id=?').run(u.id);
    else {
      db.prepare("UPDATE story_updates SET story_id=?, kind=CASE kind WHEN 'new' THEN 'update' ELSE kind END WHERE id=?").run(keep.id, u.id);
      ids.add(u.id); tokens.push(t);
    }
  }
  db.prepare('UPDATE notifications SET story_id=? WHERE story_id=?').run(keep.id, drop.id);
  const k = db.prepare('SELECT first_seen, notified_level, notified_at FROM stories WHERE id=?').get(keep.id);
  const d = db.prepare('SELECT first_seen, notified_level, notified_at FROM stories WHERE id=?').get(drop.id);
  const nl = !k.notified_level ? d.notified_level : !d.notified_level ? k.notified_level : (rank(k.notified_level) >= rank(d.notified_level) ? k.notified_level : d.notified_level);
  db.prepare('UPDATE stories SET first_seen=?, notified_level=?, notified_at=? WHERE id=?').run(
    k.first_seen < d.first_seen ? k.first_seen : d.first_seen, nl, [k.notified_at, d.notified_at].filter(Boolean).sort().pop() || null, keep.id);
  db.prepare('DELETE FROM stories WHERE id=?').run(drop.id);
  return { ids, tokens };
}

export function storyFacts(cfg, db, storyId, now) {
  const st = db.prepare('SELECT * FROM stories WHERE id=?').get(storyId);
  const arts = db.prepare('SELECT id,publisher,tier,title,excerpt,url,published_at,retrieved_at,countries,topics,entities,signals FROM articles WHERE story_id=? ORDER BY published_at').all(storyId);
  const cCount = new Map(), tCount = new Map(), eCount = new Map(), pubs = new Map();
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  let tier = 4, urgency = 'normal', pct = null, casualties = null, direction = null;
  let allOpinion = true, allNoise = true, allLive = true;
  for (const a of arts) {
    for (const c of J(a.countries) || []) bump(cCount, c);
    for (const t of J(a.topics) || []) bump(tCount, t);
    for (const e of J(a.entities) || []) bump(eCount, e);
    const sig = J(a.signals) || {};
    tier = Math.min(tier, a.tier);
    if (URG.indexOf(sig.urgency) > URG.indexOf(urgency)) urgency = sig.urgency;
    if (sig.pct != null) pct = Math.max(pct ?? 0, sig.pct);
    if (sig.casualties) casualties = Math.max(casualties ?? 0, sig.casualties);
    if (sig.direction) direction = sig.direction; // latest wins
    if (!sig.opinion) allOpinion = false;
    if (!sig.noise) allNoise = false;
    if (!sig.live) allLive = false;
    const k = pubKey(a.publisher);
    if (!pubs.has(k) || pubs.get(k).tier > a.tier) pubs.set(k, { name: a.publisher, tier: a.tier });
  }
  // Big clusters accumulate stray matches; keep what at least a quarter of the coverage supports.
  const need = Math.max(1, Math.ceil(arts.length * 0.25));
  const keep = m => [...m.entries()].filter(([, n]) => n >= need).map(([k]) => k);
  const cl = keep(cCount), tl = keep(tCount);
  const entities = keep(eCount);
  const majorCountry = cl.some(c => cfg.scoring.geography.majorCountries.includes(c));
  const titles = arts.slice(-12).map(a => a.title);
  const facts = {
    countries: cl, topics: tl, entities, sections: sectionsFor(cfg, cl, tl, majorCountry),
    tier, tier1: tier === 1, sourceCount: pubs.size, reliableCount: [...pubs.values()].filter(p => p.tier <= 3).length, urgency, direction, pct, casualties,
    opinion: arts.length > 0 && allOpinion, noise: arts.length > 0 && allNoise, live: arts.length > 0 && allLive, majorCountry,
    title: st.headline, text: [st.headline, ...titles, ...arts.slice(-4).map(a => a.excerpt || '')].join(' . '),
    ageHours: (Date.parse(now) - Date.parse(st.first_seen)) / H, watch: [], watchLabels: [], flameOn: false
  };
  return { st, arts, facts, publishers: [...pubs.values()] };
}

export function recomputeStory(db, cfg, provider, storyId, now, devIds = []) {
  const { st, arts, facts, publishers } = storyFacts(cfg, db, storyId, now);
  for (const w of cfg.preferences.watchlist || []) if (w.match && evaluate(w.match, facts)) { facts.watch.push(w.id); facts.watchLabels.push(w.label); }
  const an1 = provider.analyze(facts);
  facts.flameOn = an1.flameOn.length > 0;
  facts.flameOnDirect = an1.flameOn.some(f => f.direct);
  if (facts.flameOn && !facts.sections.includes('flameon')) facts.sections.push('flameon');
  const sc = scoreStory(cfg, facts);
  const why = provider.analyze({ ...facts, score: sc.score, level: sc.level }).why;

  // Headline: the best-tier article among those in the first 3 hours; latest = newest development.
  const firstMs = Date.parse(st.first_seen);
  const early = arts.filter(a => Date.parse(a.published_at) - firstMs <= 3 * H);
  const head = (early.length ? early : arts).slice().sort((a, b) => a.tier - b.tier || a.published_at.localeCompare(b.published_at))[0];
  const devs = db.prepare('SELECT * FROM story_updates WHERE story_id=? ORDER BY at DESC, id DESC').all(storyId);
  const lastUpd = devs[0];
  // Ongoing stories are titled by their newest development from a reliable source; single-event stories by their best early report.
  const headline = devs.length > 1 ? (devs.find(d => (d.tier ?? 4) <= 3) || devs[0]).headline : head?.title || st.headline;
  const prevLevel = st.level, prevPeak = st.peak_level;
  const level = sc.level;
  const peak = maxLevel(prevPeak || 'background', level);

  // A level rise that came with a development this run is recorded as an escalation on the timeline.
  if (devIds.length && rank(level) > rank(prevPeak || 'background') && st.article_count > 1) {
    db.prepare("UPDATE story_updates SET kind='escalation' WHERE id=? AND kind='update'").run(devIds[devIds.length - 1]);
  }
  for (const id of devIds) db.prepare('UPDATE story_updates SET score_after=?, level_after=? WHERE id=?').run(sc.score, level, id);
  const lastDev = devIds.length ? lastUpd?.at || st.last_dev_at : st.last_dev_at;
  const flags = { ...(J(st.flags) || {}), ...sc.flags, maxUrgency: facts.urgency, maxCasualties: facts.casualties || 0, unverified: facts.tier >= 4, caps: sc.caps, fired: sc.fired, publishers };
  db.prepare(`UPDATE stories SET headline=?, latest_headline=?, last_dev_at=?, score=?, level=?, peak_level=?, breakdown=?, sections=?, topics=?, countries=?, entities=?,
      source_count=?, article_count=?, tier_best=?, flags=?, why=?, flameon=?, watch=?, muted=? WHERE id=?`).run(
    headline, lastUpd?.headline || st.latest_headline, lastDev, sc.score, level, peak, S(sc.lines), S(facts.sections), S(facts.topics), S(facts.countries), S(facts.entities),
    facts.sourceCount, arts.length, facts.tier, S(flags), S(why), S(an1.flameOn), S(facts.watch), sc.mute ? 1 : 0, storyId);
  return { id: storyId, prevLevel, level, score: sc.score, isNew: st.article_count <= 1 && !st.score, devIds, facts, mute: sc.mute };
}
