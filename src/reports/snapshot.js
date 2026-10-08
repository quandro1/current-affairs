// Compact, self-contained JSON view of a story (used by the app feed and embedded in briefings
// so a briefing stays readable after old rows are pruned).
import { J } from '../db.js';

export function entityNames(cfg) {
  const m = new Map(cfg.compiled.entities.map(e => [e.id, e.name]));
  return ids => (ids || []).map(id => m.get(id) || id);
}

export function snapshot(db, cfg, st, { full = true } = {}) {
  const names = entityNames(cfg);
  const flags = J(st.flags) || {};
  const watchIds = J(st.watch) || [];
  const wl = new Map((cfg.preferences.watchlist || []).map(w => [w.id, w.label]));
  const o = {
    id: st.id,
    headline: st.headline,
    latest: st.latest_headline !== st.headline ? st.latest_headline : null,
    level: st.level,
    peak: st.peak_level,
    score: st.score,
    sections: J(st.sections) || [],
    topics: J(st.topics) || [],
    countries: J(st.countries) || [],
    entities: names(J(st.entities) || []).slice(0, 12),
    firstSeen: st.first_seen,
    updatedAt: st.updated_at,
    lastDevAt: st.last_dev_at,
    sourceCount: st.source_count,
    articleCount: st.article_count,
    tier: st.tier_best,
    unverified: !!flags.unverified,
    caps: flags.caps || [],
    publishers: (flags.publishers || []).sort((a, b) => a.tier - b.tier),
    why: J(st.why) || [],
    flameOn: J(st.flameon) || [],
    watch: watchIds.map(id => wl.get(id) || id),
    notified: st.notified_level || null
  };
  if (full) {
    o.breakdown = J(st.breakdown) || [];
    o.updates = db.prepare("SELECT at, kind, headline, publisher, url, tier FROM story_updates WHERE story_id=? ORDER BY at, id").all(st.id).slice(-25);
    o.sources = db.prepare('SELECT publisher, tier, title, url, published_at AS at, excerpt FROM articles WHERE story_id=? ORDER BY tier, published_at').all(st.id).slice(0, 15);
  }
  return o;
}
