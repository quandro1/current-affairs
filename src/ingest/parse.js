// RSS 2.0 / RSS 1.0 (RDF) / Atom parser. Tolerant of the usual feed sloppiness;
// throws a clear error when the document is not a feed at all.
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { stripHtml } from '../text.js';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  removeNSPrefix: false,
  processEntities: true,
  htmlEntities: true,
  trimValues: true,
  parseTagValue: false,
  isArray: name => ['item', 'entry', 'link', 'category'].includes(name)
});

const txt = v => {
  if (v == null) return '';
  if (Array.isArray(v)) return txt(v[0]);
  if (typeof v === 'object') return String(v['#text'] ?? v['@_href'] ?? '');
  return String(v);
};

function pickLink(item) {
  const links = item.link;
  if (!links) return txt(item.guid?.['@_isPermaLink'] !== 'false' ? item.guid : '') || '';
  for (const l of links) {
    if (typeof l === 'string') return l.trim();
    if (l && typeof l === 'object') {
      if (l['@_href'] && (!l['@_rel'] || l['@_rel'] === 'alternate')) return l['@_href'];
      if (l['#text']) return String(l['#text']).trim();
    }
  }
  const any = links.find(l => l?.['@_href']);
  return any ? any['@_href'] : '';
}

export function parseDate(s) {
  if (!s) return null;
  let str = String(s).trim();
  let t = Date.parse(str);
  if (Number.isNaN(t)) {
    // Common broken forms: "Wed, 8 Oct 2026 10:22:00 PKT", missing zone, "+0500" without colon handled by Date already.
    str = str.replace(/\b(PKT)\b/, '+0500').replace(/\b(IST)\b/, '+0530').replace(/\b(EDT)\b/, '-0400').replace(/\b(EST)\b/, '-0500');
    t = Date.parse(str);
  }
  return Number.isNaN(t) ? null : new Date(t);
}

export function parseFeed(xml) {
  if (typeof xml !== 'string' || !xml.trim()) throw new Error('Empty response');
  const head = xml.slice(0, 600).toLowerCase();
  if (head.includes('<html') && !head.includes('<rss') && !head.includes('<feed') && !head.includes('<rdf')) throw new Error('Got an HTML page, not a feed');
  let doc;
  try { doc = parser.parse(xml); }
  catch (e) { throw new Error('Malformed XML: ' + e.message.split('\n')[0]); }
  let items = [], kind = '';
  if (doc.rss?.channel) { kind = 'rss'; const ch = Array.isArray(doc.rss.channel) ? doc.rss.channel[0] : doc.rss.channel; items = ch.item || []; }
  else if (doc['rdf:RDF']) { kind = 'rdf'; items = doc['rdf:RDF'].item || []; }
  else if (doc.feed) { kind = 'atom'; items = doc.feed.entry || []; }
  else throw new Error('Not an RSS/Atom document');

  const out = items.map(it => {
    const title = stripHtml(txt(it.title));
    const link = pickLink(it).trim();
    const desc = txt(it.description) || txt(it.summary) || txt(it['content:encoded']) || txt(it.content) || '';
    const dateRaw = txt(it.pubDate) || txt(it.published) || txt(it.updated) || txt(it['dc:date']) || txt(it.date);
    const author = stripHtml(txt(it['dc:creator']) || txt(it.author?.name) || txt(it.author) || '');
    const src = it.source ? { name: stripHtml(txt(it.source)), url: it.source['@_url'] || '' } : null;
    return { title, link, description: desc, published: parseDate(dateRaw), author: author.slice(0, 120) || null, source: src, kind };
  }).filter(x => x.title && x.link);
  // Be lenient with sloppy-but-usable feeds; a document that is invalid AND yields nothing is reported as broken.
  if (!out.length) { const v = XMLValidator.validate(xml); if (v !== true) throw new Error('Malformed XML: ' + (v.err?.msg || 'invalid')); }
  return out;
}
