// Turns a parsed feed item into a normalized article record (metadata + short excerpt only;
// full article text is never stored).
import { stripHtml, clip, normalizeTitle, canonicalUrl, sha1, tokenize } from '../text.js';
import { resolvePublisherTier } from '../config.js';

const MAX_AGE_DAYS = 4;

export function normalizeItem(item, feed, cfg, now) {
  const nowMs = Date.parse(now);
  let title = stripHtml(item.title);
  let publisher = feed.sourceName, tier = feed.sourceTier, publisherUrl = item.link;
  let fallbackCountry = feed.defaultCountry || (feed.sourceCountry === 'PK' ? 'PK' : null);

  if (feed.kind === 'gnews' || feed.sourceTier === 'publisher') {
    const pubName = item.source?.name || (title.match(/\s[-–—]\s([^-–—]{2,60})$/) || [])[1] || '';
    const r = resolvePublisherTier(cfg, pubName, item.source?.url || '');
    publisher = r.name; tier = r.tier;
    // Search results also return foreign stories; only a known Pakistani publisher implies Pakistan.
    fallbackCountry = r.country === 'PK' ? feed.defaultCountry : null;
    if (pubName) title = title.replace(new RegExp('\\s[-–—]\\s' + pubName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'), '');
    publisherUrl = item.source?.url || item.link;
  }
  title = title.replace(/\s+\|\s+[^|]{2,40}$/, '').replace(/\s+/g, ' ').trim(); // "Headline | Outlet Name"
  if (title.length < 12) return null; // "Photos", "Live", etc.
  if (title.includes('|') || /\bHEADLINES\b|\bBULLETIN\b/.test(title)) return null; // TV bulletin roll-ups, not news items

  let published = item.published ? item.published.getTime() : NaN, estimated = 0;
  if (!Number.isFinite(published)) { published = nowMs; estimated = 1; }
  if (published > nowMs + 10 * 60e3) { published = nowMs; estimated = 1; } // future-dated items
  if (nowMs - published > MAX_AGE_DAYS * 864e5) return null; // stale back-catalogue

  let excerpt = feed.kind === 'gnews' ? '' : clip(stripHtml(item.description), 280);
  if (excerpt && normalizeTitle(excerpt).startsWith(normalizeTitle(title).slice(0, 60))) excerpt = clip(excerpt.slice(title.length).trim(), 280);

  const titleNorm = normalizeTitle(title);
  const url = item.link;
  return {
    feed_id: feed.id,
    source_id: feed.sourceId,
    publisher,
    tier: Number(tier) || 4,
    url,
    url_canon: canonicalUrl(url),
    publisher_url: publisherUrl,
    title,
    title_norm: titleNorm,
    title_hash: sha1(titleNorm),
    author: item.author || null,
    excerpt: excerpt || null,
    published_at: new Date(published).toISOString(),
    published_estimated: estimated,
    retrieved_at: now,
    category: feed.category || null,
    defaultCountry: fallbackCountry, // used only when no country is detected
    tokens: tokenize(title + ' ' + (excerpt || '')),
    titleTokens: tokenize(title)
  };
}
