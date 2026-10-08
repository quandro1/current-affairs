import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cfgWith, memDb, rss, run, iso, FakeChannel } from './helpers.js';
import { scoreStory } from '../src/engine/score.js';
import { evaluate, validateCondition } from '../src/engine/conditions.js';
import { inQuietHours, zonedToUtc, quietEnds } from '../src/time.js';

process.env.QUIET = '1';
const T0 = '2026-10-08T06:00:00.000Z'; // 11:00 PKT

// Eight reliable publishers reporting the same event in different words.
function imfFeeds(at) {
  return {
    'dawn-pakistan': rss([{ title: 'Pakistan, IMF reach staff-level agreement for $1.2bn tranche', link: 'https://dawn.com/imf1', date: at, desc: 'The IMF and Pakistan reached a staff-level agreement on the review.' }]),
    'tribune-business': rss([{ title: 'Pakistan, IMF reach staff-level agreement on $1.2b loan', link: 'https://tribune.com.pk/imf', date: at }]),
    'geo-latest': rss([{ title: 'IMF reaches staff-level agreement with Pakistan, paving way for $1.21bn', link: 'https://geo.tv/imf', date: at }]),
    'brecorder-latest': rss([{ title: 'IMF, Pakistan reach staff-level agreement on EFF, RSF reviews', link: 'https://brecorder.com/imf', date: at }]),
    'thenews-latest': rss([{ title: 'Pakistan moves closer to $1.21bn IMF funding after staff-level agreement', link: 'https://thenews.com.pk/imf', date: at }]),
    'app-latest': rss([{ title: 'IMF, Pakistan reach staff-level agreement on $1.2bn disbursement', link: 'https://app.com.pk/imf', date: at }]),
    'gn-pk-reuters': rss([{ title: 'IMF reaches staff deal with Pakistan, potentially unlocking $1.2 billion - Reuters', link: 'https://news.google.com/r1', date: at, source: 'Reuters', sourceUrl: 'https://www.reuters.com' }]),
    'gn-pk-imf': rss([
      { title: 'Pakistan Reaches IMF Deal to Unlock $1.2 Billion in New Funds - Bloomberg', link: 'https://news.google.com/b1', date: at, source: 'Bloomberg', sourceUrl: 'https://www.bloomberg.com' },
      // Same Dawn article seen again through Google News: must not count twice.
      { title: 'Pakistan, IMF reach staff-level agreement for $1.2bn tranche - Dawn', link: 'https://news.google.com/d1', date: at, source: 'Dawn', sourceUrl: 'https://www.dawn.com' }
    ]),
    'bbc-tech': rss([{ title: 'Gadget maker unveils new smartwatch colours', link: 'https://bbc.co.uk/watch', date: at }]),
    'bbc-world': rss([{ title: 'Museum in Peru reopens after renovation', link: 'https://bbc.co.uk/peru', date: at }])
  };
}

async function bootstrapped(cfg) {
  const db = memDb();
  await run(cfg, db, {}, iso(T0, -60)); // first run: nothing is pushed
  return db;
}

test('20 reports of one event become ONE story with multiple sources', async () => {
  const cfg = cfgWith();
  const db = await bootstrapped(cfg);
  await run(cfg, db, imfFeeds(iso(T0, -20)), T0);
  const imf = db.prepare("SELECT * FROM stories WHERE headline LIKE '%IMF%'").all();
  assert.equal(imf.length, 1, 'all IMF agreement reports cluster into one story: ' + imf.map(s => s.headline).join(' / '));
  assert.equal(imf[0].source_count, 8, 'Dawn via Google News is not a second publisher');
  const arts = db.prepare('SELECT COUNT(*) n FROM articles WHERE story_id=?').get(imf[0].id).n;
  assert.equal(arts, 8, 'exact duplicate (same publisher + same headline) is not stored twice');
  const other = db.prepare("SELECT COUNT(*) n FROM stories WHERE headline NOT LIKE '%IMF%'").get().n;
  assert.equal(other, 2, 'unrelated stories stay separate');
});

test('high-priority story scores higher than minor news, and a critical one triggers ONE alert', async () => {
  const cfg = cfgWith();
  const db = await bootstrapped(cfg);
  const ch = new FakeChannel();
  await run(cfg, db, imfFeeds(iso(T0, -20)), T0, ch);
  const imf = db.prepare("SELECT * FROM stories WHERE headline LIKE '%IMF%'").get();
  const minor = db.prepare("SELECT * FROM stories WHERE headline LIKE '%smartwatch%'").get();
  assert.ok(imf.score > minor.score + 50, `${imf.score} vs ${minor.score}`);
  assert.equal(imf.level, 'critical');
  assert.equal(minor.level, 'background');
  const alerts = ch.sent.filter(m => m.tag === `story-${imf.id}`);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].title, /CRITICAL/);
  assert.match(alerts[0].body, /Sources: /);
  assert.ok(!ch.sent.some(m => /smartwatch|Peru/.test(m.body)), 'low-priority stories never notify');

  // More coverage of the same event later: no repeat notification.
  const more = { 'dawn-home': rss([{ title: 'IMF and Pakistan reach staff-level agreement, says finance ministry', link: 'https://dawn.com/imf-more', date: iso(T0, 10) }]) };
  await run(cfg, db, more, iso(T0, 20), ch);
  assert.equal(ch.sent.filter(m => m.tag === `story-${imf.id}`).length, 1, 'already reported at this level');
});

test('a later development is added to the story timeline, not a new story', async () => {
  const cfg = cfgWith();
  const db = await bootstrapped(cfg);
  await run(cfg, db, imfFeeds(iso(T0, -20)), T0);
  const before = db.prepare('SELECT COUNT(*) n FROM stories').get().n;
  const later = { 'dawn-pakistan': rss([{ title: 'IMF board approves $1.2bn tranche for Pakistan after staff-level agreement', link: 'https://dawn.com/imf-board', date: iso(T0, 240) }]) };
  await run(cfg, db, later, iso(T0, 250));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM stories').get().n, before, 'no new story');
  const s = db.prepare("SELECT * FROM stories WHERE headline LIKE '%IMF%'").get();
  const tl = db.prepare('SELECT kind, headline FROM story_updates WHERE story_id=? ORDER BY at').all(s.id);
  assert.ok(tl.some(u => /board approves/.test(u.headline) && u.kind !== 'new'), JSON.stringify(tl));
});

test('scoring rules: unverified capped, opinion penalised, critical needs corroboration', () => {
  const cfg = cfgWith();
  const base = { countries: ['PK'], topics: ['imf', 'pk-economy'], entities: ['imf'], sections: ['pakistan', 'economy'], tier: 2, tier1: false, sourceCount: 1, reliableCount: 1, urgency: 'breaking', majorCountry: false, text: 'x', title: 'x', watch: [], watchLabels: [] };
  const single = scoreStory(cfg, base);
  assert.notEqual(single.level, 'critical');
  const wide = scoreStory(cfg, { ...base, sourceCount: 9, reliableCount: 9 });
  assert.equal(wide.level, 'critical');
  const t4 = scoreStory(cfg, { ...base, tier: 4, sourceCount: 9, reliableCount: 0, casualties: 60, topics: ['imf', 'pk-economy', 'security'] });
  assert.ok(['notable', 'background'].includes(t4.level));
  assert.ok(t4.caps.some(c => /unverified/i.test(c)));
  const op = scoreStory(cfg, { ...base, opinion: true });
  assert.ok(op.score < single.score);
  assert.ok(op.mute, 'opinion is never pushed');
  // breakdown is fully itemised
  assert.equal(wide.lines.reduce((a, l) => a + l.points, 0), wide.score);
});

test('quiet hours hold an alert and release it afterwards', async () => {
  const cfg = cfgWith({ quietHours: { enabled: true, start: '23:30', end: '07:30', criticalBypass: false } });
  const night = '2026-10-08T20:00:00.000Z'; // 01:00 PKT
  const db = memDb();
  await run(cfg, db, {}, iso(night, -60));
  const ch = new FakeChannel();
  await run(cfg, db, imfFeeds(iso(night, -15)), night, ch);
  assert.equal(ch.sent.filter(m => /CRITICAL/.test(m.title)).length, 0, 'nothing pushed during quiet hours');
  const held = db.prepare("SELECT * FROM notifications WHERE status='held'").all();
  assert.equal(held.length, 1);
  assert.equal(held[0].deliver_after, '2026-10-09T02:30:00.000Z'); // 07:30 PKT
  await run(cfg, db, {}, '2026-10-09T02:35:00.000Z', ch);
  assert.equal(ch.sent.filter(m => /CRITICAL/.test(m.title)).length, 1, 'delivered when quiet hours end');
});

test('critical bypass and severity settings are respected', async () => {
  const cfg = cfgWith({ quietHours: { enabled: true, start: '23:30', end: '07:30', criticalBypass: true } });
  const night = '2026-10-08T20:00:00.000Z';
  const db = memDb();
  await run(cfg, db, {}, iso(night, -60));
  const ch = new FakeChannel();
  await run(cfg, db, imfFeeds(iso(night, -15)), night, ch);
  assert.equal(ch.sent.filter(m => /CRITICAL/.test(m.title)).length, 1);

  const off = cfgWith({ topics: { ...cfgWith().preferences.topics, pakistan: false, economy: false } });
  const db2 = memDb();
  await run(off, db2, {}, iso(T0, -60));
  const ch2 = new FakeChannel();
  await run(off, db2, imfFeeds(iso(T0, -20)), T0, ch2);
  assert.equal(ch2.sent.filter(m => m.tag?.startsWith('story-')).length, 0, 'topics switched off do not notify');
});

test('daily briefing at 08:00 PKT contains the right stories, once; evening recap only has new things', async () => {
  const cfg = cfgWith();
  const db = memDb();
  await run(cfg, db, {}, '2026-10-07T22:00:00.000Z');
  await run(cfg, db, imfFeeds('2026-10-08T01:00:00.000Z'), '2026-10-08T02:50:00.000Z'); // 07:50 PKT: not due yet
  assert.equal(db.prepare('SELECT COUNT(*) n FROM briefings').get().n, 0);
  const ch = new FakeChannel();
  await run(cfg, db, {}, '2026-10-08T03:05:00.000Z', ch); // 08:05 PKT
  const b = db.prepare("SELECT * FROM briefings WHERE id='daily-2026-10-08'").get();
  assert.ok(b, 'daily briefing generated');
  const j = JSON.parse(b.json);
  assert.match(j.top[0].headline, /IMF/);
  assert.ok(!j.top.some(s => /smartwatch|Peru/.test(s.headline)), 'background stories excluded');
  assert.ok(j.oneThing && j.oneThing.reason.startsWith('Prioritised because'));
  assert.ok(ch.sent.some(m => /daily intelligence/i.test(m.title)));
  await run(cfg, db, {}, '2026-10-08T03:25:00.000Z');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM briefings WHERE kind='daily'").get().n, 1, 'not generated twice');

  const afternoon = { 'geo-latest': rss([{ title: 'Seven killed as blast hits market in Quetta, police say', link: 'https://geo.tv/quetta', date: '2026-10-08T10:00:00.000Z' }]),
    'dawn-home': rss([{ title: 'Explosion in Quetta market kills seven, injures dozens', link: 'https://dawn.com/quetta', date: '2026-10-08T10:10:00.000Z' }]) };
  await run(cfg, db, afternoon, '2026-10-08T10:30:00.000Z');
  await run(cfg, db, {}, '2026-10-08T15:05:00.000Z'); // 20:05 PKT
  const e = JSON.parse(db.prepare("SELECT json FROM briefings WHERE id='evening-2026-10-08'").get().json);
  assert.ok(e.fresh.some(s => /Quetta/.test(s.headline)), 'afternoon story included');
  assert.ok(!e.fresh.some(s => /IMF/.test(s.headline)), 'morning story not repeated');
});

test('rule language, validation and time helpers', () => {
  const f = { countries: ['PK', 'IN'], topics: ['conflict'], score: 90, text: 'Petrol price raised', urgency: 'major' };
  assert.ok(evaluate({ all: [{ field: 'countries', op: 'hasAll', value: ['PK', 'IN'] }, { field: 'score', op: 'gte', value: 80 }] }, f));
  assert.ok(evaluate({ any: [{ field: 'topics', op: 'has', value: 'imf' }, { field: 'text', op: 'matches', value: '\\bpetrol\\b' }] }, f));
  assert.ok(!evaluate({ not: { field: 'urgency', op: 'in', value: ['major'] } }, f));
  assert.ok(validateCondition({ field: 'nope', op: 'has', value: 1 }).length);
  assert.ok(validateCondition({ field: 'text', op: 'matches', value: '(' }).length);
  const q = { enabled: true, start: '23:30', end: '07:30' };
  assert.ok(inQuietHours('2026-10-08T20:00:00Z', q, 'Asia/Karachi'));
  assert.ok(!inQuietHours('2026-10-08T06:00:00Z', q, 'Asia/Karachi'));
  assert.equal(zonedToUtc('2026-10-08', '08:00', 'Asia/Karachi').toISOString(), '2026-10-08T03:00:00.000Z');
  assert.equal(quietEnds('2026-10-08T19:00:00Z', q, 'Asia/Karachi').toISOString(), '2026-10-09T02:30:00.000Z');
});

test('Flame On impact fires only on a meaningful connection', async () => {
  const cfg = cfgWith();
  const db = await bootstrapped(cfg);
  const feeds = {
    'dawn-business': rss([
      { title: 'Cooking oil and ghee prices raised by Rs40 per kg in Pakistan', link: 'https://dawn.com/ghee', date: iso(T0, -30) },
      { title: 'Pakistan cricket team arrives in Lahore for series', link: 'https://dawn.com/cricket', date: iso(T0, -30) }
    ])
  };
  await run(cfg, db, feeds, T0);
  const ghee = db.prepare("SELECT * FROM stories WHERE headline LIKE '%ghee%'").get();
  const cricket = db.prepare("SELECT * FROM stories WHERE headline LIKE '%cricket%'").get();
  assert.ok(JSON.parse(ghee.flameon).some(f => f.id === 'fo-oil-up'));
  assert.ok(JSON.parse(ghee.sections).includes('flameon'));
  assert.deepEqual(JSON.parse(cricket.flameon), []);
  assert.equal(cricket.level, 'background');
});
