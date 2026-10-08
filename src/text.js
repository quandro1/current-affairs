// Deterministic text utilities: cleaning, tokenising, light stemming, hashing.
import { createHash } from 'node:crypto';

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…', laquo: '«', raquo: '»', middot: '·', bull: '•', pound: '£', euro: '€', copy: '©', reg: '®', trade: '™' };

export function decodeEntities(s) {
  if (!s) return '';
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : '';
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

export function stripHtml(s) {
  if (!s) return '';
  let t = String(s).replace(/<!\[CDATA\[|\]\]>/g, '');
  t = decodeEntities(t); // entity-encoded markup (&lt;p&gt;) is common in feeds
  t = t.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ');
  return decodeEntities(t).replace(/\s+/g, ' ').trim();
}

export function clip(s, n) {
  if (!s || s.length <= n) return s || '';
  const cut = s.slice(0, n);
  const sp = cut.lastIndexOf(' ');
  return (sp > n * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.-]+$/, '') + '…';
}

export const STOP = new Set(('a an the and or but if of to in on at by for with from into onto over under about after before as is are was were be been being has have had do does did will would shall should can could may might must not no nor so than that this these those it its it\'s he she they them his her their we our you your i me my who whom whose which what when where why how all any both each few more most other some such only own same too very s t just now new says said say amid also via up down out off again further then once here there per vs v how\'s what\'s amid among against during until while within without upon across along around behind beyond near since toward towards under via yet one two three first last year years day days week weeks month months today yesterday tomorrow monday tuesday wednesday thursday friday saturday sunday report reports reported news update updates latest live watch video photos pictures explainer analysis opinion editorial comment').split(/\s+/));

export function normalizeTitle(title) {
  return stripHtml(title).toLowerCase()
    .replace(/[‘’`´]/g, "'").replace(/[“”]/g, '"')
    .replace(/\s+[-–—|]\s+[^-–—|]{2,40}$/, '') // trailing " - Publisher"
    .replace(/[^\p{L}\p{N}%$.' ]+/gu, ' ')
    .replace(/\s+/g, ' ').trim();
}

// Very light suffix stripping, enough to merge plurals/tenses for similarity.
export function stem(w) {
  if (w.length <= 3 || /\d/.test(w)) return w;
  if (w.endsWith("'s")) w = w.slice(0, -2);
  if (w.endsWith('ies') && w.length > 4) return w.slice(0, -3) + 'y';
  if (w.endsWith('sses')) return w.slice(0, -2);
  if (w.endsWith('es') && /(sh|ch|x|z|ss)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) w = w.slice(0, -1);
  if (w.endsWith('ing') && w.length > 5) w = w.slice(0, -3);
  else if (w.endsWith('ed') && w.length > 4) w = w.slice(0, -2);
  return w;
}

const SYN = new Map(Object.entries({
  hike: 'up', hik: 'up', raise: 'up', rais: 'up', increase: 'up', increas: 'up', rise: 'up', ris: 'up', rose: 'up', surge: 'up', surg: 'up', jump: 'up', soar: 'up', climb: 'up', costlier: 'up', higher: 'up',
  cut: 'down', slash: 'down', reduce: 'down', reduc: 'down', decrease: 'down', decreas: 'down', fall: 'down', fell: 'down', drop: 'down', dropp: 'down', decline: 'down', declin: 'down', plunge: 'down', plung: 'down', cheaper: 'down', lower: 'down', tumble: 'down', tumbl: 'down',
  agreement: 'deal', agre: 'deal', accord: 'deal', pact: 'deal', hsd: 'diesel', govt: 'government', percent: '%', pc: '%', billion: 'bn', million: 'mn', trillion: 'tn',
  litre: 'liter', liter: 'liter', per: 'per', kg: 'kg', rupee: 'rs', rupees: 'rs', paisa: 'paisa', paise: 'paisa', paisas: 'paisa'
}));

export function tokenize(text) {
  const t = stripHtml(text).toLowerCase().replace(/[‘’`´]/g, "'")
    .replace(/(\d)\s?(pc|per cent|percent)\b/g, '$1 %')
    .replace(/\b(rs|re|usd|pkr|\$)\.?\s?(?=\d)/g, 'rs ')
    .replace(/(\d)(bn|mn|tn|m|b|kg|mw|km)\b/g, '$1 $2');
  const out = [];
  for (const raw of t.split(/[^\p{L}\p{N}%$'.-]+/u)) {
    const w = raw.replace(/^['.-]+|['.-]+$/g, '');
    if (!w || w.length < 2 || STOP.has(w)) continue;
    if (/^\d+$/.test(w) && w.length < 3) continue; // tiny bare numbers are noise
    const s = stem(w);
    out.push(SYN.get(s) || SYN.get(w) || s);
  }
  return out;
}

export function sha1(s) { return createHash('sha1').update(s).digest('hex'); }

export function canonicalUrl(u) {
  try {
    const url = new URL(u);
    url.hash = '';
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
    for (const k of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|mc_|ref$|ref_|cmpid|ito|at_|smid|partner|taid|ocid|output|amp$)/i.test(k)) url.searchParams.delete(k);
    }
    let s = url.toString().replace(/^http:/, 'https:').replace(/\/amp\/?$/, '/').replace(/\/$/, '');
    s = s.replace('://www.', '://').replace('://m.', '://');
    return s.toLowerCase();
  } catch { return String(u || '').trim().toLowerCase(); }
}

export function domainOf(u) {
  try { return new URL(u).hostname.replace(/^(www|m|amp)\./, '').toLowerCase(); } catch { return ''; }
}

export function jaccard(a, b) {
  const A = a instanceof Set ? a : new Set(a), B = b instanceof Set ? b : new Set(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

const NUMWORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, dozens: 24, dozen: 12, scores: 40, hundreds: 200 };
export function wordNum(s) {
  if (s == null) return NaN;
  const k = String(s).toLowerCase().replace(/,/g, '');
  if (NUMWORDS[k] != null) return NUMWORDS[k];
  return Number(k);
}

// Compile a keyword list into one regex. Keyword syntax: phrase, trailing * = prefix,
// otherwise optional plural (s|es). caseSensitive for acronyms.
export function compileKeywords(list, caseSensitive = false) {
  if (!list || !list.length) return null;
  const parts = list.map(k => {
    const prefix = k.endsWith('*');
    const base = (prefix ? k.slice(0, -1) : k).trim();
    let esc = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '[\\s-]+');
    const lastIsWord = /[\p{L}\p{N}]$/u.test(base);
    if (prefix) esc += '[\\p{L}\\p{N}-]*';
    else if (lastIsWord && /\p{L}$/u.test(base)) esc += "(?:s|es|'s)?";
    const startWord = /^[\p{L}\p{N}]/u.test(base);
    return (startWord ? '(?<![\\p{L}\\p{N}])' : '') + esc + (lastIsWord || prefix ? '(?![\\p{L}\\p{N}])' : '');
  });
  return new RegExp(parts.join('|'), caseSensitive ? 'gu' : 'giu');
}
