// Current Affairs — personal rule-based intelligence PWA. Vanilla JS, no build step, no trackers.
(function () {
  'use strict';
  const $ = s => document.querySelector(s);
  const view = $('#view');
  const LS = {
    get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* private mode */ } }
  };
  const S = { feed: null, cfg: {}, archive: null, briefIdx: null, briefCache: new Map(), health: null, prevVisit: null, deferredInstall: null, tz: 'Asia/Karachi' };
  const LEVELS = ['background', 'notable', 'important', 'critical'];
  const LV = { critical: { i: '🔴', t: 'Critical' }, important: { i: '🟠', t: 'Important' }, notable: { i: '🟡', t: 'Notable' }, background: { i: '⚪', t: 'Background' } };
  const KIND = { new: 'First reported', update: 'Development', escalation: 'Escalation', official: 'Official source', coverage: 'Coverage' };
  const SECTIONS_DEFAULT = [
    { id: 'pakistan', label: 'Pakistan', icon: '🇵🇰' }, { id: 'world', label: 'World', icon: '🌎' }, { id: 'geopolitics', label: 'Geopolitics', icon: '🧭' },
    { id: 'economy', label: 'Economy', icon: '💰' }, { id: 'technology', label: 'Technology', icon: '🤖' }, { id: 'hospitality', label: 'Tourism & Hospitality', icon: '🏨' }, { id: 'flameon', label: 'Flame On', icon: '🍔' }
  ];

  // ---------- utils ----------
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const safeUrl = u => (/^https?:\/\//i.test(u || '') ? esc(u) : '#');
  const rankOf = l => LEVELS.indexOf(l);
  const hoursSince = iso => (Date.now() - Date.parse(iso)) / 36e5;
  function ago(iso) {
    if (!iso) return '';
    const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 6e4));
    if (m < 1) return 'just now'; if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60); if (h < 24) return `${h} h ago`;
    const d = Math.round(h / 24); return d === 1 ? 'yesterday' : `${d} days ago`;
  }
  const fmt = (iso, o) => new Intl.DateTimeFormat('en-GB', { timeZone: S.tz, ...o }).format(new Date(iso));
  const fmtWhen = iso => fmt(iso, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
  const sections = () => S.cfg.categories?.sections || SECTIONS_DEFAULT;
  const secLabel = id => { const s = sections().find(x => x.id === id); return s ? s.label : id; };
  const secIcon = id => (sections().find(x => x.id === id) || {}).icon || '';
  const halfLife = () => S.cfg.scoring?.recencyHalfLifeHours || 18;
  const rank = s => s.score * Math.pow(0.5, Math.max(0, hoursSince(s.lastDevAt || s.updatedAt)) / halfLife());
  const byRank = (a, b) => rankOf(b.level) - rankOf(a.level) || rank(b) - rank(a);
  let toastT;
  function toast(msg, ms = 3500) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), ms); }

  async function getJson(path) {
    const r = await fetch(path, { cache: 'no-store' });
    const j = await r.json();
    if (j && j.offline) throw new Error('offline');
    return j;
  }

  // ---------- data ----------
  async function loadFeed() {
    try {
      S.feed = await getJson('data/feed.json');
      $('#offline').hidden = navigator.onLine !== false;
    } catch (e) {
      $('#offline').hidden = false;
      if (!S.feed) S.feed = { stories: [], background: [], generatedAt: null };
    }
    for (const st of S.feed.stories) S.briefCache.set(st.id, st);
    updateBadge();
  }
  async function loadCfg(name) {
    if (S.cfg[name]) return S.cfg[name];
    try { S.cfg[name] = await getJson(`data/config/${name}.json`); } catch (_) { S.cfg[name] = null; }
    return S.cfg[name];
  }
  async function loadArchive() { if (!S.archive) { try { S.archive = (await getJson('data/archive.json')).stories || []; } catch (_) { S.archive = []; } } return S.archive; }
  async function loadBriefIdx() { if (!S.briefIdx) { try { S.briefIdx = await getJson('data/briefings/index.json'); } catch (_) { S.briefIdx = []; } } return S.briefIdx; }
  async function loadBrief(id) {
    if (S.briefCache.has('b:' + id)) return S.briefCache.get('b:' + id);
    const b = await getJson(`data/briefings/${encodeURIComponent(id)}.json`);
    S.briefCache.set('b:' + id, b);
    const take = s => { if (s && s.id && !S.briefCache.has(s.id)) S.briefCache.set(s.id, s); };
    for (const v of Object.values(b)) { if (Array.isArray(v)) v.forEach(take); else if (v && typeof v === 'object') { take(v); if (v.story) take(v.story); for (const a of Object.values(v)) if (Array.isArray(a)) a.forEach(take); } }
    return b;
  }
  async function loadHealth(force) { if (!S.health || force) { try { S.health = await getJson('data/health.json'); } catch (_) { S.health = null; } } return S.health; }
  const allStories = () => [...(S.feed?.stories || [])];

  // ---------- "what changed" ----------
  function changesSince(T) {
    const out = { escalations: [], fresh: [], updates: [] };
    for (const s of allStories()) {
      if (rankOf(s.level) < 1) continue;
      const ups = (s.updates || []).filter(u => u.at > T);
      if (s.firstSeen > T) { out.fresh.push({ s, ups }); continue; }
      if (!ups.length) continue;
      const devs = ups.filter(u => u.kind !== 'new');
      if (devs.some(u => u.kind === 'escalation' || u.kind === 'official')) out.escalations.push({ s, ups: devs });
      else if (devs.length) out.updates.push({ s, ups: devs });
    }
    for (const k of Object.keys(out)) out[k].sort((a, b) => rankOf(b.s.level) - rankOf(a.s.level) || b.s.score - a.s.score);
    return out;
  }
  function updateBadge() {
    const b = $('#chgBadge');
    if (!S.feed || !S.prevVisit) { b.hidden = true; return; }
    const c = changesSince(S.prevVisit);
    const n = c.escalations.length + c.fresh.filter(x => rankOf(x.s.level) >= 2).length + c.updates.filter(x => rankOf(x.s.level) >= 2).length;
    b.textContent = n > 99 ? '99+' : n; b.hidden = !n;
  }

  // ---------- components ----------
  const pill = l => `<span class="pill ${l}">${LV[l].i} ${LV[l].t}</span>`;
  function whyShort(s) {
    const lines = (s.breakdown || []).filter(l => l.points > 0 && !['source', 'urgency', 'geography'].includes(l.kind)).sort((a, b) => b.points - a.points).slice(0, 2).map(l => l.label.replace(/\s*\(.*?\)\s*$/, ''));
    return lines.length ? 'Why: ' + lines.join(' · ') : '';
  }
  function pubLine(s) {
    const p = s.publishers || [];
    if (!p.length) return '';
    return esc(p[0].name) + (s.sourceCount > 1 ? ` +${s.sourceCount - 1} more` : '');
  }
  function card(s, o = {}) {
    const secs = (s.sections || []).filter(x => x !== 'flameon').slice(0, 2).map(secLabel).join(' · ');
    const latest = s.latest && s.latest !== s.headline ? `<div class="latest"><b>Latest:</b> ${esc(s.latest)}</div>` : '';
    const fo = s.flameOn?.length && (s.sections || []).includes('flameon') ? `<div class="fo-line">🔥 ${esc(s.flameOn[0].text)}</div>` : '';
    const extra = o.extra || '';
    return `<a class="card lvl-${s.level}${o.big ? ' big' : ''}" href="#/story/${s.id}">
      <div class="top">${pill(s.level)}${s.unverified ? '<span class="pill unv">Unverified</span>' : ''}${s.watch?.length ? '<span class="pill watch">👁 Watching</span>' : ''}${(s.sections || []).includes('flameon') ? '<span class="pill fo">🔥 Flame On</span>' : ''}</div>
      <div class="hl">${esc(s.headline)}</div>${latest}${extra}${fo}
      ${o.noWhy ? '' : `<div class="why">${esc(whyShort(s))}</div>`}
      <div class="meta"><span>${pubLine(s)}</span><span>${ago(s.lastDevAt || s.updatedAt)}</span>${secs ? `<span>${esc(secs)}</span>` : ''}<span class="score" title="Importance score (sum of rule points)">${s.score} pts</span></div>
    </a>`;
  }
  const secHead = (title, link) => `<div class="sec-h"><h2>${title}</h2>${link ? `<a href="${link}">See all →</a>` : ''}</div>`;

  // ---------- views ----------
  function greeting() {
    const h = Number(fmt(new Date().toISOString(), { hour: '2-digit', hour12: false }));
    return h < 5 ? 'Good Night' : h < 12 ? 'Good Morning' : h < 17 ? 'Good Afternoon' : h < 22 ? 'Good Evening' : 'Good Night';
  }
  function freshness() {
    const g = S.feed?.generatedAt;
    if (!g) return '<span class="updated"><i class="dot stale"></i>No data yet — the first run has not been published</span>';
    const stale = hoursSince(g) > 1.5;
    return `<span class="updated"><i class="dot${stale ? ' stale' : ''}"></i>Updated ${ago(g)}${stale ? ' — scheduler may be delayed' : ''}</span>`;
  }

  function renderHome() {
    const st = allStories().filter(s => !s.muted);
    const shown = new Set();
    const take = (arr, n) => { const r = []; for (const s of arr) { if (r.length >= n) break; if (shown.has(s.id)) continue; r.push(s); shown.add(s.id); } return r; };
    const crit = take(st.filter(s => s.level === 'critical' && hoursSince(s.lastDevAt) < 36).sort(byRank), 4);
    const top = take(st.filter(s => rankOf(s.level) >= 1).sort(byRank), 5);
    const c = S.prevVisit ? changesSince(S.prevVisit) : { escalations: [], fresh: [], updates: [] };
    const nChg = c.escalations.length + c.fresh.length + c.updates.length;
    let h = `<div class="hello">${greeting()}</div><h1>Your Current Affairs</h1>
      <div class="date">${fmt(new Date().toISOString(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</div>${freshness()}
      <button class="cta" onclick="location.hash='#/changed'"><span>WHAT CHANGED?<small>${S.prevVisit ? 'Since your last visit ' + ago(S.prevVisit) : 'New developments and escalations'}</small></span><span class="n">${nChg}</span></button>`;
    h += `<section class="sec">${secHead('🔴 Breaking')}${crit.length ? crit.map(s => card(s, { big: true })).join('') : '<div class="empty">No critical developments right now.</div>'}</section>`;
    h += `<section class="sec">${secHead('🔥 Top stories')}${top.length ? top.map(s => card(s)).join('') : '<div class="empty">Nothing has crossed the Notable threshold yet.</div>'}</section>`;
    for (const sec of ['pakistan', 'world', 'geopolitics', 'economy', 'technology']) {
      const list = take(st.filter(s => (s.sections || []).includes(sec) && rankOf(s.level) >= 1).sort(byRank), 3);
      h += `<section class="sec">${secHead(`${secIcon(sec)} ${esc(secLabel(sec))}`, '#/section/' + sec)}${list.length ? list.map(s => card(s)).join('') : `<div class="empty">Nothing notable beyond the stories above.</div>`}</section>`;
    }
    const fo = st.filter(s => (s.sections || []).includes('flameon') && rankOf(s.level) >= 1).sort(byRank);
    if (fo.length) h += `<section class="sec">${secHead('🍔 Flame On', '#/section/flameon')}${fo.slice(0, 4).map(s => card(s)).join('')}</section>`;
    const w = take(st.filter(s => s.watch?.length && rankOf(s.level) >= 1).sort(byRank), 3);
    h += `<section class="sec">${secHead('👁 Watchlist', '#/watch')}${w.length ? w.map(s => card(s)).join('') : '<div class="empty">Watched topics are already shown above, or quiet.</div>'}</section>`;
    h += `<p class="honest">Rule-based monitoring: stories are ranked by transparent rules (geography, topic, source reliability, urgency, corroboration, your watchlist and Flame On relevance). Nothing here is AI-written analysis. Open any story to see exactly why it was prioritised.</p>`;
    view.innerHTML = h;
  }

  async function renderStory(id) {
    let s = allStories().find(x => x.id === id) || S.briefCache.get(id);
    if (!s || !s.breakdown) { const a = (await loadArchive()).find(x => x.id === id); if (a) s = { ...a, ...(s || {}) }; }
    if (!s) { view.innerHTML = `<a class="back" href="#/">← Back</a><div class="empty">This story is no longer in the 30-day window.</div>`; return; }
    const secs = (s.sections || []).filter(x => x !== 'flameon');
    const pubs = s.publishers || [];
    let h = `<a class="back" href="javascript:history.length>1?history.back():location.assign('#/')">← Back</a><div class="detail">
      <div class="row">${pill(s.level)}<span class="chip">${s.score} points</span>${s.unverified ? '<span class="pill unv">Unverified</span>' : ''}${(s.sections || []).includes('flameon') ? '<span class="pill fo">🔥 Flame On</span>' : ''}</div>
      <h1>${esc(s.headline)}</h1>
      <div class="meta"><span>First seen ${fmtWhen(s.firstSeen)}</span><span>Last development ${ago(s.lastDevAt)}</span></div>
      <div style="margin-top:8px">${secs.map(x => `<span class="chip">${secIcon(x)} ${esc(secLabel(x))}</span>`).join('')}${(s.topics || []).slice(0, 6).map(t => `<span class="chip">${esc(t)}</span>`).join('')}</div>`;
    const top = (s.sources || [])[0];
    h += `<div class="box"><h3>Reported <span class="tag">fact — attributed</span></h3>
      <div>${pubs.length ? `Reported by <b>${pubs.length}</b> publisher${pubs.length > 1 ? 's' : ''}: ${pubs.slice(0, 8).map(p => `${esc(p.name)} <span class="tier t${p.tier}">T${p.tier}</span>`).join(' · ')}${pubs.length > 8 ? ' …' : ''}` : ''}</div>
      ${s.latest && s.latest !== s.headline ? `<div class="note"><b>Latest development:</b> ${esc(s.latest)}</div>` : ''}
      ${top ? `<div class="row" style="margin-top:12px"><a class="btn primary" href="${safeUrl(top.url)}" target="_blank" rel="noopener noreferrer">Read original (${esc(top.publisher)}) →</a></div>` : ''}
      ${s.unverified ? '<div class="note bad-t">Only low-confidence (tier 4) sources so far. Treat as unverified until a reliable outlet or official source reports it.</div>' : ''}
    </div>`;
    if (s.breakdown?.length) {
      const total = s.breakdown.reduce((a, l) => a + l.points, 0);
      h += `<div class="box"><h3>Why it was prioritised <span class="tag">rule-based scoring</span></h3><table class="bd">
        ${s.breakdown.map(l => `<tr><td>${esc(l.label)}</td><td class="p${l.points < 0 ? ' neg' : ''}">${l.points > 0 ? '+' : ''}${l.points || '·'}</td></tr>`).join('')}
        <tr class="total"><td>Total</td><td class="p">${total}</td></tr></table>
        ${(s.caps || []).map(c => `<div class="note warn-t">⚠ ${esc(c)}</div>`).join('')}
        <div class="note">Level thresholds and every weight are editable in More → Rules.</div></div>`;
    }
    if (s.flameOn?.length && (s.sections || []).includes('flameon')) {
      h += `<div class="box fo"><h3>🔥 Flame On impact <span class="tag">rule-based inference</span></h3>${s.flameOn.map(f => `<div style="margin-bottom:6px">${esc(f.text)}</div>`).join('')}
        <div class="note">Triggered by: ${s.flameOn.map(f => esc(f.id)).join(', ')}. A possible implication from a predefined rule, not a forecast.</div></div>`;
    }
    if (s.why?.length) {
      h += `<div class="box"><h3>Context <span class="tag">template — general, not analysis of this story</span></h3>${s.why.map(w => `<p style="margin:0 0 8px">${esc(w.text)}</p>`).join('')}
        <div class="note">Predefined context matched by rules (${s.why.map(w => esc(w.id)).join(', ')}).</div></div>`;
    }
    h += `<div class="box"><h3>Not known from these sources <span class="tag">unknown</span></h3><div class="note" style="margin-top:0">This app reads headlines and short excerpts only. Motives, numbers and details that are not in the headlines are not known here, so open the original reports above.</div></div>`;
    if (s.updates?.length) {
      h += `<div class="box"><h3>Timeline</h3><ul class="tl">${s.updates.slice().reverse().map(u => `<li class="${u.kind}"><div class="when">${fmtWhen(u.at)} · ${KIND[u.kind] || u.kind}${u.publisher ? ' · ' + esc(u.publisher) : ''}</div>
        <div class="what">${u.url ? `<a href="${safeUrl(u.url)}" target="_blank" rel="noopener noreferrer" style="color:inherit">${esc(u.headline)}</a>` : esc(u.headline)}</div></li>`).join('')}</ul></div>`;
    }
    if (s.sources?.length) {
      h += `<div class="box"><h3>Sources (${s.articleCount || s.sources.length} reports)</h3>${s.sources.map(a => `<a class="src" href="${safeUrl(a.url)}" target="_blank" rel="noopener noreferrer">
        <div class="pub"><span class="tier t${a.tier}">Tier ${a.tier}</span>${esc(a.publisher)} · ${ago(a.at)}</div><div class="t">${esc(a.title)}</div>${a.excerpt ? `<div class="x">${esc(a.excerpt)}</div>` : ''}</a>`).join('')}
        <div class="note">Tier 1 official/primary · Tier 2 high-quality · Tier 3 specialist · Tier 4 unverified.</div></div>`;
    }
    if (s.entities?.length) h += `<div class="box"><h3>Entities matched</h3>${s.entities.map(e => `<span class="chip">${esc(e)}</span>`).join('')}</div>`;
    view.innerHTML = h + '</div>';
  }

  function renderChanged(mode) {
    mode = mode || LS.get('ca_chg_mode', 'visit');
    LS.set('ca_chg_mode', mode);
    let T, label;
    if (mode === 'brief') {
      const ids = S.feed?.latestBriefings || {};
      const last = (S.briefIdx || []).find(b => b.kind === 'daily' || b.kind === 'evening');
      T = last ? last.createdAt : new Date(Date.now() - 24 * 36e5).toISOString();
      label = last ? `since the ${last.kind} briefing (${fmtWhen(T)})` : 'in the last 24 hours (no briefing yet)';
      void ids;
    } else if (mode === 'day') { T = new Date(Date.now() - 24 * 36e5).toISOString(); label = 'in the last 24 hours'; }
    else { T = S.prevVisit || new Date(Date.now() - 24 * 36e5).toISOString(); label = `since your last visit (${ago(T)})`; }
    const c = changesSince(T);
    const what = x => { const u = x.ups[x.ups.length - 1]; return u && u.headline !== x.s.headline ? `<div class="latest"><b>${KIND[u.kind] || 'Update'}:</b> ${esc(u.headline)} <span class="note">— ${esc(u.publisher || '')}, ${ago(u.at)}</span></div>` : ''; };
    const group = (title, arr, empty) => `<section class="sec">${secHead(title)}${arr.length ? arr.slice(0, 25).map(x => card(x.s, { extra: what(x), noWhy: true })).join('') : `<div class="empty">${empty}</div>`}</section>`;
    view.innerHTML = `<h1>What changed?</h1><div class="date">${esc(label)}</div>
      <div class="seg"><button data-m="visit" class="${mode === 'visit' ? 'on' : ''}">Last visit</button><button data-m="brief" class="${mode === 'brief' ? 'on' : ''}">Last briefing</button><button data-m="day" class="${mode === 'day' ? 'on' : ''}">24 hours</button></div>
      ${group('🔺 Escalations & official announcements', c.escalations, 'No escalations.')}
      ${group('🆕 New stories', c.fresh, 'No new stories above Notable.')}
      ${group('↻ Updates to ongoing stories', c.updates, 'No significant updates.')}
      <div class="row" style="margin-top:16px"><button class="btn" id="markSeen">Mark all as seen</button></div>
      <p class="honest">Only new stories, timeline developments, escalations and official confirmations are listed. More coverage of the same thing is not repeated.</p>`;
    view.querySelectorAll('.seg button').forEach(b => (b.onclick = async () => { if (b.dataset.m === 'brief') await loadBriefIdx(); renderChanged(b.dataset.m); }));
    $('#markSeen').onclick = () => { S.prevVisit = new Date().toISOString(); LS.set('ca_lastVisit', S.prevVisit); updateBadge(); renderChanged('visit'); toast('Marked as seen'); };
  }

  function renderSection(id) {
    const st = allStories().filter(s => (s.sections || []).includes(id)).sort(byRank);
    const bg = (S.feed?.background || []).filter(s => (s.sections || []).includes(id)).sort(byRank);
    const showBg = LS.get('ca_showbg') === '1';
    view.innerHTML = `<a class="back" href="#/">← Today</a><h1>${secIcon(id)} ${esc(secLabel(id))}</h1><div class="date">${st.length} stories in the last 72 hours</div>
      <section class="sec">${st.length ? st.map(s => card(s)).join('') : '<div class="empty">Nothing here right now.</div>'}</section>
      <section class="sec">${secHead('⚪ Background')}<button class="btn sm" id="bgT">${showBg ? 'Hide' : 'Show'} ${bg.length} background items</button>
      <div style="margin-top:10px">${showBg ? bg.map(s => card(s, { noWhy: true })).join('') : ''}</div></section>`;
    $('#bgT').onclick = () => { LS.set('ca_showbg', showBg ? '0' : '1'); renderSection(id); };
  }

  // ---------- briefings ----------
  const BK = { daily: '☀️ Daily', evening: '🌙 Evening', weekly: '🗓️ Weekly', monthly: '📊 Monthly' };
  async function renderBriefings(kind) {
    kind = kind || 'all';
    const idx = await loadBriefIdx();
    const list = idx.filter(b => kind === 'all' || b.kind === kind);
    view.innerHTML = `<h1>Briefings</h1><div class="date">Generated automatically from the scored story database</div>
      <div class="seg">${['all', 'daily', 'evening', 'weekly', 'monthly'].map(k => `<button data-k="${k}" class="${k === kind ? 'on' : ''}">${k === 'all' ? 'All' : k[0].toUpperCase() + k.slice(1)}</button>`).join('')}</div>
      <div class="list">${list.length ? list.map(b => `<a class="li" href="#/briefing/${encodeURIComponent(b.id)}"><div><div><b>${BK[b.kind] || b.kind}</b> · ${fmt(b.createdAt, { weekday: 'short', day: 'numeric', month: 'short' })}</div>
        ${b.lead ? `<div class="sub">${esc(b.lead)}</div>` : ''}</div><span class="chev">›</span></a>`).join('') : '<div class="li"><span class="sub">No briefings yet. The first daily briefing is generated at your briefing time.</span></div>'}</div>`;
    view.querySelectorAll('.seg button').forEach(b => (b.onclick = () => renderBriefings(b.dataset.k)));
  }
  const mini = (arr, n = 99) => (arr || []).filter(Boolean).slice(0, n).map(s => card(s, { noWhy: false })).join('');
  async function renderBriefing(id) {
    let b;
    try { b = await loadBrief(id); } catch (_) { view.innerHTML = `<a class="back" href="#/briefings">← Briefings</a><div class="empty">Briefing not found.</div>`; return; }
    let h = `<a class="back" href="#/briefings">← Briefings</a><h1>${esc(b.title)}</h1><div class="date">${fmtWhen(b.createdAt)}${b.period ? ` · covers ${fmtWhen(b.period.from)} → ${fmtWhen(b.period.to)}` : ''}</div>`;
    if (b.kind === 'daily') {
      if (b.empty) h += '<div class="empty" style="margin-top:14px">A quiet period — nothing crossed your Notable threshold.</div>';
      h += `<section class="sec">${secHead('🔥 Top 5 stories')}${(b.top || []).map((s, i) => card(s, { extra: '', big: i === 0 })).join('')}</section>`;
      for (const [k, arr] of Object.entries(b.sections || {})) if (arr.length) h += `<section class="sec">${secHead(`${secIcon(k)} ${esc(secLabel(k))}`)}${mini(arr)}</section>`;
      if (b.flameon?.length) h += `<section class="sec">${secHead('🍔 Flame On')}${mini(b.flameon)}</section>`;
      if (b.oneThing) h += `<section class="sec">${secHead('🧠 One thing to remember')}<div class="box" style="margin-top:0"><div class="hl">${esc(b.oneThing.fact)}</div>
        <div class="note">${esc(b.oneThing.reason)}</div>${b.oneThing.context ? `<div class="honest">Context (template): ${esc(b.oneThing.context)}</div>` : ''}
        <div class="row" style="margin-top:10px"><a class="btn sm" href="#/story/${b.oneThing.story.id}">Open story</a></div></div></section>`;
      if (b.stats) h += `<p class="note">${b.stats.total} notable+ stories in this period: ${b.stats.critical} critical, ${b.stats.important} important, ${b.stats.notable} notable.</p>`;
    } else if (b.kind === 'evening') {
      if (b.empty) h += `<div class="empty" style="margin-top:14px">${esc(b.emptyText)}</div>`;
      if (b.escalated?.length) h += `<section class="sec">${secHead('🔺 Escalated or major updates')}${b.escalated.map(s => card(s, { extra: (s.newUpdates || []).slice(-1).map(u => `<div class="latest"><b>${KIND[u.kind]}:</b> ${esc(u.headline)}</div>`).join('') })).join('')}</section>`;
      if (b.fresh?.length) h += `<section class="sec">${secHead('🆕 New since this morning')}${mini(b.fresh)}</section>`;
    } else if (b.kind === 'weekly') {
      const one = (t, s) => `<section class="sec">${secHead(t)}${s ? card(s) : '<div class="empty">Nothing qualified.</div>'}</section>`;
      h += one('🏆 Biggest story', b.biggest) + one('🇵🇰 Biggest Pakistan development', b.pakistan) + one('🧭 Biggest geopolitical development', b.geopolitics) + one('💰 Biggest economic development', b.economy) + one('🤖 Biggest technology development', b.technology) + one('🔎 Important story you may have missed', b.missed);
      h += `<section class="sec">${secHead('↻ What changed this week')}${(b.changed || []).map(s => card(s, { extra: `<div class="note">${s.developments} development${s.developments === 1 ? '' : 's'}${s.escalations ? `, ${s.escalations} escalation${s.escalations === 1 ? '' : 's'}` : ''} this week</div>` })).join('') || '<div class="empty">No multi-step stories.</div>'}</section>`;
      h += `<section class="sec">${secHead('👀 What to watch next week')}${mini(b.watchNext) || '<div class="empty">No active ongoing stories.</div>'}<p class="honest">${esc(b.watchNextNote)}</p></section>`;
      if (b.stats) h += `<p class="note">${b.stats.total} notable+ stories this week · ${b.stats.critical} critical · ${b.stats.important} important.</p>`;
    } else if (b.kind === 'monthly') {
      const s = b.stats;
      h += `<div class="stat" style="margin-top:14px"><div><b>${s.total}</b><span>notable+ stories</span></div><div><b>${s.major}</b><span>major (important+)</span></div><div><b>${s.critical}</b><span>critical</span></div>
        <div><b>${s.bySection.pakistan || 0}</b><span>Pakistan stories</span></div><div><b>${s.bySection.geopolitics || 0}</b><span>geopolitical</span></div><div><b>${s.previousMonthTotal}</b><span>previous month total</span></div></div>`;
      h += `<section class="sec">${secHead('📰 Most important stories')}${mini(b.topStories)}</section>`;
      const max = Math.max(1, ...(b.topEntities || []).map(e => e.count));
      h += `<section class="sec">${secHead('🏷️ Most frequent entities')}<div class="box" style="margin-top:0">${(b.topEntities || []).map(e => `<div style="margin-bottom:8px"><div class="row" style="justify-content:space-between"><span>${esc(e.label)}</span><b>${e.count}</b></div><div class="bar"><i style="width:${Math.round(100 * e.count / max)}%"></i></div></div>`).join('')}</div></section>`;
      h += `<section class="sec">${secHead('🔁 Recurring topics')}<div class="box" style="margin-top:0"><table class="bd">${(b.topTopics || []).map(t => `<tr><td>${esc(t.label)}</td><td class="p">${t.count}</td><td class="p" style="color:var(--muted)">prev ${t.previousMonth}</td></tr>`).join('')}</table></div></section>`;
      for (const [k, tr] of Object.entries(b.trends || {})) {
        if (!tr.stories) continue;
        h += `<section class="sec">${secHead(`${secIcon(k === 'business' ? 'hospitality' : k)} ${k[0].toUpperCase() + k.slice(1)} — ${tr.stories} stories`)}${mini(tr.top, 3)}
          <div class="note">${tr.topics.map(t => `${esc(t.label)} ${t.count} (prev ${t.previousMonth})`).join(' · ')}</div></section>`;
      }
      h += `<section class="sec">${secHead('📅 Week by week')}<div class="box" style="margin-top:0;overflow-x:auto"><table class="bd"><tr><td><b>Week of</b></td><td class="p">All</td><td class="p">PK</td><td class="p">Geo</td><td class="p">Econ</td><td class="p">Tech</td></tr>
        ${(b.weeks || []).map(w => `<tr><td>${esc(w.from)}</td><td class="p">${w.total}</td><td class="p">${w.pakistan}</td><td class="p">${w.geopolitics}</td><td class="p">${w.economy}</td><td class="p">${w.technology}</td></tr>`).join('')}</table></div></section>`;
      h += `<p class="honest">${esc(b.note)}</p>`;
    }
    view.innerHTML = h;
  }

  // ---------- watchlist + search ----------
  async function renderWatch() {
    const prefs = await loadCfg('preferences');
    const arch = await loadArchive();
    const pool = [...allStories(), ...arch.filter(a => !allStories().some(s => s.id === a.id))];
    const items = prefs?.watchlist || [];
    const q = (S.q || '').trim().toLowerCase();
    let h = `<h1>Watchlist</h1><div class="date">Followed topics get +${S.cfg.scoring?.personal?.watchlist?.points ?? 5} importance and appear in your briefings.</div>
      <input class="search" type="text" id="q" placeholder="Search the last 30 days…" value="${esc(S.q || '')}" enterkeyhint="search">`;
    if (q) {
      const res = pool.filter(s => (s.headline + ' ' + (s.latest || '') + ' ' + (s.entities || []).join(' ')).toLowerCase().includes(q)).sort((a, b) => b.lastDevAt.localeCompare(a.lastDevAt)).slice(0, 40);
      h += `<section class="sec">${secHead(`🔎 ${res.length} result${res.length === 1 ? '' : 's'}`)}${res.map(s => card(s, { noWhy: true })).join('') || '<div class="empty">No matches.</div>'}</section>`;
    }
    for (const w of items) {
      const hits = pool.filter(s => (s.watch || []).includes(w.label)).sort((a, b) => b.lastDevAt.localeCompare(a.lastDevAt));
      const open = S.openWatch === w.id;
      h += `<section class="sec"><div class="sec-h"><h2>👁 ${esc(w.label)}</h2><span class="note" style="margin:0">${hits.length} stor${hits.length === 1 ? 'y' : 'ies'} · 30 days</span></div>
        ${hits.slice(0, open ? 30 : 2).map(s => card(s, { noWhy: true })).join('') || '<div class="empty">Nothing recently.</div>'}
        <div class="row">${hits.length > 2 ? `<button class="btn sm" data-open="${esc(w.id)}">${open ? 'Show less' : `Show all ${hits.length}`}</button>` : ''}${Admin.hasToken() ? `<button class="btn sm danger" data-del="${esc(w.id)}">Unfollow</button>` : ''}</div></section>`;
    }
    h += `<section class="sec">${secHead('➕ Follow something new')}<div class="box" style="margin-top:0">
      <label class="f" for="wl">Name</label><input type="text" id="wl" placeholder="e.g. Rupee, Gwadar, foodpanda">
      <label class="f" for="wt">Match by</label><select id="wt"><option value="keyword">Keyword or phrase in headline</option><option value="entity">Entity (organisation, person, place)</option><option value="topic">Topic</option><option value="country">Country</option></select>
      <div id="wvBox"><label class="f" for="wv">Keyword</label><input type="text" id="wv" placeholder="e.g. rupee"></div>
      <div class="row" style="margin-top:12px"><button class="btn primary" id="wAdd">Follow</button></div>
      <div class="note">${Admin.hasToken() ? 'Saved to your repo; it takes effect on the next run (within ~15 min).' : 'Needs admin access (More → Admin access) because the watchlist lives in your repo.'}</div></div></section>`;
    view.innerHTML = h;
    const qi = $('#q');
    qi.oninput = () => { S.q = qi.value; clearTimeout(S.qT); S.qT = setTimeout(() => { renderWatch().then(() => { const n = $('#q'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }); }, 350); };
    view.querySelectorAll('[data-open]').forEach(b => (b.onclick = () => { S.openWatch = S.openWatch === b.dataset.open ? null : b.dataset.open; renderWatch(); }));
    view.querySelectorAll('[data-del]').forEach(b => (b.onclick = () => saveWatch(d => { d.watchlist = d.watchlist.filter(x => x.id !== b.dataset.del); return d; }, 'Unfollow ' + b.dataset.del)));
    const ents = await loadCfg('entities'), cats = await loadCfg('categories');
    const wt = $('#wt'), box = $('#wvBox');
    wt.onchange = () => {
      const t = wt.value;
      if (t === 'keyword') box.innerHTML = '<label class="f" for="wv">Keyword</label><input type="text" id="wv" placeholder="e.g. rupee">';
      else {
        const opts = t === 'entity' ? (ents?.entities || []).filter(e => e.type !== 'country').map(e => [e.id, e.name])
          : t === 'topic' ? (cats?.topics || []).filter(x => !x.noise).map(x => [x.id, x.label])
          : (ents?.entities || []).filter(e => e.type === 'country' || e.type === 'region').map(e => [e.country, e.name]);
        box.innerHTML = `<label class="f" for="wv">${t[0].toUpperCase() + t.slice(1)}</label><select id="wv">${opts.sort((a, b) => a[1].localeCompare(b[1])).map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('')}</select>`;
      }
    };
    $('#wAdd').onclick = () => {
      const label = $('#wl').value.trim(), t = wt.value, v = $('#wv').value.trim();
      if (!label || !v) { toast('Enter a name and a value'); return; }
      const field = { keyword: 'text', entity: 'entities', topic: 'topics', country: 'countries' }[t];
      const match = t === 'keyword' ? { field, op: 'matches', value: '\\b' + v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b' } : { field, op: 'has', value: v };
      const id = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'item-' + Date.now();
      saveWatch(d => { d.watchlist = (d.watchlist || []).filter(x => x.id !== id); d.watchlist.push({ id, label, match }); return d; }, 'Follow ' + label);
    };
  }
  async function saveWatch(fn, msg) {
    if (!Admin.hasToken()) { location.hash = '#/admin'; toast('Set up admin access first'); return; }
    try { await Admin.update('config/preferences.json', fn, msg); S.cfg.preferences = (await Admin.readJson('config/preferences.json')).data; toast('Saved. It takes effect on the next run.'); renderWatch(); }
    catch (e) { toast(e.message, 6000); }
  }

  // ---------- more / settings ----------
  function renderMore() {
    const theme = LS.get('ca_theme', 'auto');
    const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    view.innerHTML = `<h1>More</h1>
      <section class="sec"><div class="list">
        <a class="li" href="#/settings"><div><b>Notifications & briefings</b><div class="sub">Severity, topics, quiet hours, schedule, this device</div></div><span class="chev">›</span></a>
        <a class="li" href="#/sources"><div><b>News sources</b><div class="sub">Add, disable, re-tier, test feeds</div></div><span class="chev">›</span></a>
        <a class="li" href="#/rules"><div><b>Rules, scoring & templates</b><div class="sub">Every weight and rule, viewable and editable</div></div><span class="chev">›</span></a>
        <a class="li" href="#/health"><div><b>System health</b><div class="sub">Feeds, runs, notifications, failures</div></div><span class="chev">›</span></a>
        <a class="li" href="#/admin"><div><b>Admin access</b><div class="sub">${Admin.hasToken() ? 'Token saved on this device' : 'Not set: needed to change settings from the phone'}</div></div><span class="chev">›</span></a>
        <a class="li" href="#/about"><div><b>How this works</b><div class="sub">What the system does, and what it does not do</div></div><span class="chev">›</span></a>
      </div></section>
      <section class="sec">${secHead('Appearance')}<div class="seg">${['auto', 'light', 'dark'].map(t => `<button data-t="${t}" class="${t === theme ? 'on' : ''}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div></section>
      <section class="sec">${secHead('Install')}<div class="box" style="margin-top:0">${standalone ? '✅ Installed: you are using the app.' :
        S.deferredInstall ? '<button class="btn primary" id="inst">Install app</button>' :
        /iPhone|iPad/.test(navigator.userAgent) ? 'On iPhone: tap <b>Share</b> → <b>Add to Home Screen</b>, then open it from the icon. Notifications only work from the installed app (iOS 16.4+).' :
        'Use your browser menu → <b>Install app</b> / <b>Add to Home screen</b>.'}</div></section>`;
    view.querySelectorAll('.seg button').forEach(b => (b.onclick = () => { applyTheme(b.dataset.t); renderMore(); }));
    const i = $('#inst'); if (i) i.onclick = async () => { S.deferredInstall.prompt(); await S.deferredInstall.userChoice; S.deferredInstall = null; renderMore(); };
  }
  function applyTheme(t) {
    LS.set('ca_theme', t);
    if (t === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t);
    const dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.querySelector('meta[name=theme-color]').content = dark ? '#0b1220' : '#f4f6fa';
  }

  async function prefsForEdit() {
    if (Admin.hasToken()) { try { const r = await Admin.readJson('config/preferences.json'); return { data: r.data, live: true }; } catch (e) { toast(e.message, 5000); } }
    return { data: structuredClone(await loadCfg('preferences')), live: false };
  }
  async function renderSettings() {
    view.innerHTML = '<div class="loading">Loading settings…</div>';
    const { data: p, live } = await prefsForEdit();
    const push = await loadCfg('push');
    if (!p) { view.innerHTML = '<div class="empty">Settings are not published yet.</div>'; return; }
    const sw = (id, label, on, sub = '') => `<label class="sw"><span>${label}${sub ? `<div class="note" style="margin:0">${sub}</div>` : ''}</span><input type="checkbox" id="${id}" ${on ? 'checked' : ''}></label>`;
    const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    const perm = 'Notification' in window ? Notification.permission : 'unsupported';
    let subbed = false;
    try { const reg = await navigator.serviceWorker?.getRegistration(); subbed = !!(await reg?.pushManager?.getSubscription()); } catch (_) { /* ignore */ }
    view.innerHTML = `<a class="back" href="#/more">← More</a><h1>Notifications & briefings</h1>
      ${live ? '' : '<div class="note warn-t">Read-only: add admin access to change settings from this device.</div>'}
      <section class="sec">${secHead('This device')}<div class="box" style="margin-top:0">
        <div class="kv"><span class="k">Permission</span><b>${perm}</b><span class="k">Subscribed for push</span><b>${subbed ? 'yes' : 'no'}</b><span class="k">Server push key</span><b>${push?.vapidPublicKey ? 'configured' : 'not configured'}</b></div>
        <div class="row" style="margin-top:12px"><button class="btn primary" id="pSub">${subbed ? 'Re-register this device' : 'Enable notifications here'}</button><button class="btn" id="pLocal">Local test</button><button class="btn" id="pServer">Server test</button>${subbed ? '<button class="btn danger" id="pUnsub">Turn off</button>' : ''}</div>
        <div class="note">"Local test" checks your phone shows notifications. "Server test" asks the real pipeline to send one (arrives in 1–3 minutes).</div>
        ${/iPhone|iPad/.test(navigator.userAgent) && !navigator.standalone ? '<div class="note warn-t">iPhone: push only works after Add to Home Screen, opened from the icon (iOS 16.4+).</div>' : ''}
      </div></section>
      <section class="sec">${secHead('Severity: what may interrupt you')}<div class="seg" id="sev">${[['critical', 'Critical only'], ['critical+important', 'Critical + Important'], ['all', 'All meaningful']].map(([v, l]) => `<button data-v="${v}" class="${p.severity === v ? 'on' : ''}">${l}</button>`).join('')}</div></section>
      <section class="sec">${secHead('Topics')}<div class="list">${sections().map(s => sw('t_' + s.id, `${s.icon} ${esc(s.label)}`, p.topics?.[s.id] !== false)).join('')}</div></section>
      <section class="sec">${secHead('Quiet hours')}<div class="list">${sw('qOn', 'Quiet hours', p.quietHours?.enabled, 'Alerts are held and delivered as one summary afterwards')}${sw('qCrit', 'Let Critical through', p.quietHours?.criticalBypass)}</div>
        <div class="row" style="margin-top:8px"><div style="flex:1"><label class="f" for="qS">From</label><input type="time" id="qS" value="${esc(p.quietHours?.start || '23:30')}"></div><div style="flex:1"><label class="f" for="qE">To</label><input type="time" id="qE" value="${esc(p.quietHours?.end || '07:30')}"></div></div></section>
      <section class="sec">${secHead('Limits')}<div class="row"><div style="flex:1"><label class="f" for="lH">Max per hour</label><input type="number" min="1" max="20" id="lH" value="${p.limits?.maxPerHour ?? 3}"></div><div style="flex:1"><label class="f" for="lD">Max per day</label><input type="number" min="1" max="60" id="lD" value="${p.limits?.maxPerDay ?? 12}"></div></div><div class="note">Critical alerts are never rate-limited. Anything held back appears in the next briefing.</div></section>
      <section class="sec">${secHead('Briefings')}<div class="list">
        ${sw('dOn', '☀️ Daily briefing', p.daily?.enabled)}<div class="sw"><span>Time</span><input type="time" id="dT" value="${esc(p.daily?.time || '08:00')}" style="width:130px"></div>
        ${sw('eOn', '🌙 Evening recap', p.evening?.enabled)}<div class="sw"><span>Time</span><input type="time" id="eT" value="${esc(p.evening?.time || '20:00')}" style="width:130px"></div>
        ${sw('wOn', '🗓️ Weekly report', p.weekly?.enabled)}<div class="sw"><span>Day & time</span><span class="row"><select id="wD" style="width:90px">${days.map(d => `<option ${p.weekly?.day === d ? 'selected' : ''}>${d}</option>`).join('')}</select><input type="time" id="wT" value="${esc(p.weekly?.time || '09:00')}" style="width:120px"></span></div>
        ${sw('mOn', '📊 Monthly report', p.monthly?.enabled)}<div class="sw"><span>Day of month & time</span><span class="row"><input type="number" min="1" max="28" id="mD" value="${p.monthly?.day ?? 1}" style="width:70px"><input type="time" id="mT" value="${esc(p.monthly?.time || '09:00')}" style="width:120px"></span></div>
      </div><div class="note">Times are ${esc(p.timezone)}. Scheduled runs can lag by up to ~20 minutes on GitHub's free scheduler.</div></section>
      <section class="sec">${secHead('Channels')}<div class="list">${sw('cWp', 'Web Push (this app)', p.channels?.webpush !== false)}${sw('cTg', 'Telegram (optional)', p.channels?.telegram !== false, 'Needs TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID secrets')}</div></section>
      <div class="row" style="margin:20px 0"><button class="btn primary" id="save" ${live ? '' : 'disabled'}>Save settings</button></div>`;
    let sev = p.severity;
    view.querySelectorAll('#sev button').forEach(b => (b.onclick = () => { sev = b.dataset.v; view.querySelectorAll('#sev button').forEach(x => x.classList.toggle('on', x === b)); }));
    const v = id => $('#' + id);
    $('#save').onclick = async () => {
      const btn = $('#save'); btn.disabled = true; btn.textContent = 'Saving…';
      try {
        await Admin.update('config/preferences.json', d => {
          d.severity = sev;
          d.topics = Object.fromEntries(sections().map(s => [s.id, v('t_' + s.id).checked]));
          d.quietHours = { enabled: v('qOn').checked, start: v('qS').value, end: v('qE').value, criticalBypass: v('qCrit').checked };
          d.limits = { ...(d.limits || {}), maxPerHour: +v('lH').value || 3, maxPerDay: +v('lD').value || 12 };
          d.daily = { ...(d.daily || {}), enabled: v('dOn').checked, time: v('dT').value };
          d.evening = { ...(d.evening || {}), enabled: v('eOn').checked, time: v('eT').value };
          d.weekly = { ...(d.weekly || {}), enabled: v('wOn').checked, day: v('wD').value, time: v('wT').value };
          d.monthly = { ...(d.monthly || {}), enabled: v('mOn').checked, day: Math.min(28, Math.max(1, +v('mD').value || 1)), time: v('mT').value };
          d.channels = { webpush: v('cWp').checked, telegram: v('cTg').checked };
          return d;
        }, 'Update notification settings from the app');
        toast('Saved. The next run uses the new settings.');
      } catch (e) { toast(e.message, 7000); }
      btn.disabled = false; btn.textContent = 'Save settings';
    };
    $('#pSub').onclick = async () => {
      try {
        const sub = await Admin.subscribe(push?.vapidPublicKey);
        if (Admin.hasToken()) { await Admin.registerSubscription(sub); toast('This device will receive alerts.'); }
        else { await navigator.clipboard?.writeText(JSON.stringify(sub)).catch(() => {}); toast('Subscribed locally. Add admin access so the server knows this device (subscription copied).', 8000); }
        renderSettings();
      } catch (e) { toast(e.message, 8000); }
    };
    $('#pLocal').onclick = async () => {
      try {
        if (Notification.permission !== 'granted' && (await Notification.requestPermission()) !== 'granted') throw new Error('Permission not granted');
        const reg = await navigator.serviceWorker.ready;
        await reg.showNotification('🟠 IMPORTANT · Test', { body: 'Local test: this is how alerts will look.', icon: 'icons/icon-192.png', badge: 'icons/badge-96.png', tag: 'local-test' });
      } catch (e) { toast(e.message, 6000); }
    };
    $('#pServer').onclick = async () => { try { await Admin.runNow({ test_push: 'true' }); toast('Requested. A test alert should arrive in 1–3 minutes.', 6000); } catch (e) { toast(e.message, 6000); } };
    const un = $('#pUnsub'); if (un) un.onclick = async () => { try { await Admin.unregisterSubscription(); toast('Notifications turned off for this device'); renderSettings(); } catch (e) { toast(e.message, 6000); } };
  }

  // ---------- sources ----------
  async function renderSources() {
    view.innerHTML = '<div class="loading">Loading sources…</div>';
    let src = await loadCfg('sources'), live = false, health = await loadHealth(true);
    if (Admin.hasToken()) { try { src = (await Admin.readJson('config/sources.json')).data; live = true; } catch (e) { toast(e.message, 5000); } }
    const fh = new Map((health?.feeds || []).map(f => [f.id, f]));
    const cats = sections().map(s => s.id);
    let h = `<a class="back" href="#/more">← More</a><h1>News sources</h1><div class="date">${src.sources.length} sources · ${src.sources.reduce((a, s) => a + (s.feeds || []).length, 0)} feeds</div>
      ${live ? '' : '<div class="note warn-t">Read-only: add admin access to edit.</div>'}`;
    h += `<section class="sec">${secHead('➕ Add a source')}<div class="box" style="margin-top:0">
      <label class="f" for="nN">Name</label><input type="text" id="nN" placeholder="e.g. ProPakistani">
      <label class="f" for="nK">Type</label><select id="nK"><option value="rss">RSS / Atom feed URL</option><option value="gnews">Google News search</option></select>
      <label class="f" for="nU" id="nUl">Feed URL</label><input type="url" id="nU" placeholder="https://…/feed">
      <div class="row"><div style="flex:1"><label class="f" for="nT">Reliability tier</label><select id="nT"><option value="1">1 · Official / primary</option><option value="2">2 · High quality</option><option value="3" selected>3 · Specialist</option><option value="4">4 · Unverified</option></select></div>
      <div style="flex:1"><label class="f" for="nC">Category</label><select id="nC">${cats.map(c => `<option value="${c}">${esc(secLabel(c))}</option>`).join('')}</select></div></div>
      <label class="f" for="nCo">Country code (optional fallback, e.g. PK)</label><input type="text" id="nCo" maxlength="4" placeholder="PK">
      <div class="row" style="margin-top:12px"><button class="btn primary" id="nAdd" ${live ? '' : 'disabled'}>Add source</button><button class="btn" id="nTest" ${Admin.hasToken() ? '' : 'disabled'}>Test URL</button></div>
      <div class="note" id="testRes">${health?.testFeed ? `Last test (${ago(health.testFeed.at)}): ${esc(health.testFeed.url)} → ${health.testFeed.ok ? `<span class="ok-t">OK, ${health.testFeed.items} items</span>` : `<span class="bad-t">${esc(health.testFeed.error)}</span>`}` : 'Testing runs the real fetcher on the server and takes 1–2 minutes.'}</div>
    </div></section>`;
    h += `<section class="sec">${secHead('Sources')}<div class="list">${src.sources.map(s => {
      const feeds = (s.feeds || []).map(f => {
        const st = fh.get(f.id);
        const status = !st ? '<span class="note">not fetched yet</span>' : st.fails ? `<span class="bad-t">failing ×${st.fails}</span>` : `<span class="ok-t">ok</span>`;
        return `<div class="feedrow"><div class="row" style="justify-content:space-between"><span>${esc(f.id)} · ${esc(secLabel(f.category))}</span>${status}</div>
          <div class="note" style="margin:2px 0 0;word-break:break-all">${f.kind === 'gnews' ? 'Google News: ' + esc(f.query) : esc(f.url)}</div>
          ${st ? `<div class="note" style="margin:2px 0 0">Last success ${st.last_success_at ? ago(st.last_success_at) : 'never'} · ${st.items_last ?? 0} items · ${st.total_new ?? 0} new total · every ${f.everyMin || 30} min</div>` : ''}
          ${st?.last_error && st.fails ? `<div class="err">${esc(st.last_error)}</div>` : ''}
          ${live ? `<div class="row" style="margin-top:6px"><select data-cat="${esc(s.id)}|${esc(f.id)}" style="width:auto;min-height:36px;padding:4px 8px">${cats.map(c => `<option ${c === f.category ? 'selected' : ''} value="${c}">${esc(secLabel(c))}</option>`).join('')}</select>${f.kind !== 'gnews' ? `<button class="btn sm" data-test="${esc(f.url)}">Test</button>` : ''}</div>` : ''}</div>`;
      }).join('');
      return `<div style="border-bottom:1px solid var(--line)"><div class="li" style="border:0"><div><b>${esc(s.name)}</b> <span class="tier t${s.tier}">${s.tier === 'publisher' ? 'per publisher' : 'Tier ' + s.tier}</span>${s.active === false ? ' <span class="pill unv">disabled</span>' : ''}
        <div class="sub">${esc(s.type || '')} · ${esc(s.country || '')}</div></div></div>
        ${feeds}
        ${live ? `<div class="row" style="padding:0 14px 12px"><button class="btn sm" data-tog="${esc(s.id)}">${s.active === false ? 'Enable' : 'Disable'}</button>
          ${s.tier !== 'publisher' ? `<select data-tier="${esc(s.id)}" style="width:auto;min-height:36px;padding:4px 8px">${[1, 2, 3, 4].map(t => `<option ${t === s.tier ? 'selected' : ''} value="${t}">Tier ${t}</option>`).join('')}</select>` : ''}
          <button class="btn sm danger" data-rm="${esc(s.id)}">Remove</button></div>` : ''}</div>`;
    }).join('')}</div></section>`;
    view.innerHTML = h;
    const save = (fn, msg) => Admin.update('config/sources.json', fn, msg).then(() => { S.cfg.sources = null; toast('Saved. Takes effect on the next run.'); renderSources(); }).catch(e => toast(e.message, 7000));
    const kSel = $('#nK');
    kSel.onchange = () => { $('#nUl').textContent = kSel.value === 'gnews' ? 'Search query' : 'Feed URL'; $('#nU').type = kSel.value === 'gnews' ? 'text' : 'url'; $('#nU').placeholder = kSel.value === 'gnews' ? 'e.g. Pakistan textile exports when:2d' : 'https://…/feed'; };
    $('#nAdd').onclick = () => {
      const name = $('#nN').value.trim(), url = $('#nU').value.trim(), kind = kSel.value;
      if (!name || !url) { toast('Name and URL/query are required'); return; }
      const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'src-' + Date.now();
      const feed = kind === 'gnews' ? { id: id + '-gn', kind: 'gnews', query: url, category: $('#nC').value, defaultCountry: $('#nCo').value.trim().toUpperCase() || null, everyMin: 60 }
        : { id: id + '-feed', url, category: $('#nC').value, defaultCountry: $('#nCo').value.trim().toUpperCase() || null, everyMin: 30 };
      save(d => {
        if (d.sources.some(s => s.id === id)) throw new Error('A source with this name already exists');
        d.sources.push({ id, name, homepage: kind === 'gnews' ? 'https://news.google.com' : new URL(url).origin, country: feed.defaultCountry || 'INTL', type: kind === 'gnews' ? 'aggregator' : 'user-added', tier: kind === 'gnews' ? 'publisher' : +$('#nT').value, active: true, feeds: [feed] });
        return d;
      }, 'Add source ' + name);
    };
    const test = async url => {
      try { await Admin.runNow({ test_url: url }); $('#testRes').textContent = 'Testing on the server… the result appears here in 1–2 minutes.'; pollTest(url); }
      catch (e) { toast(e.message, 6000); }
    };
    $('#nTest').onclick = () => { const u = $('#nU').value.trim(); if (!/^https?:\/\//.test(u)) { toast('Enter a feed URL first'); return; } test(u); };
    view.querySelectorAll('[data-test]').forEach(b => (b.onclick = () => test(b.dataset.test)));
    view.querySelectorAll('[data-tog]').forEach(b => (b.onclick = () => save(d => { const s = d.sources.find(x => x.id === b.dataset.tog); s.active = s.active === false; return d; }, 'Toggle source ' + b.dataset.tog)));
    view.querySelectorAll('[data-rm]').forEach(b => (b.onclick = () => { if (confirmInline(b)) save(d => { d.sources = d.sources.filter(x => x.id !== b.dataset.rm); return d; }, 'Remove source ' + b.dataset.rm); }));
    view.querySelectorAll('[data-tier]').forEach(sel => (sel.onchange = () => save(d => { d.sources.find(x => x.id === sel.dataset.tier).tier = +sel.value; return d; }, `Set ${sel.dataset.tier} to tier ${sel.value}`)));
    view.querySelectorAll('[data-cat]').forEach(sel => (sel.onchange = () => { const [sid, fid] = sel.dataset.cat.split('|'); save(d => { d.sources.find(x => x.id === sid).feeds.find(f => f.id === fid).category = sel.value; return d; }, `Recategorise ${fid}`); }));
  }
  // Two-tap confirmation without a blocking dialog.
  function confirmInline(btn) {
    if (btn.dataset.armed) return true;
    btn.dataset.armed = '1'; const t = btn.textContent; btn.textContent = 'Tap again to confirm';
    setTimeout(() => { delete btn.dataset.armed; btn.textContent = t; }, 4000);
    return false;
  }
  function pollTest(url, n = 0) {
    if (n > 15) return;
    setTimeout(async () => {
      const h = await loadHealth(true);
      const t = h?.testFeed;
      const el = $('#testRes');
      if (t && t.url === url && Date.now() - Date.parse(t.at) < 15 * 6e4) {
        if (el) el.innerHTML = t.ok ? `<span class="ok-t">✓ ${t.items} items.</span> ${t.sample.map(esc).join(' · ')}` : `<span class="bad-t">✗ ${esc(t.error)}</span>`;
      } else pollTest(url, n + 1);
    }, 20000);
  }

  // ---------- rules ----------
  const FILES = [['rules', 'IF/THEN rules'], ['scoring', 'Scoring weights & levels'], ['templates', '"Why it matters" templates'], ['flameon', 'Flame On impact rules'], ['entities', 'Entities'], ['categories', 'Topics & sections'], ['publishers', 'Publisher tiers']];
  function condText(c) {
    if (!c) return '';
    if (c.all) return c.all.map(condText).join(' AND ');
    if (c.any) return '(' + c.any.map(condText).join(' OR ') + ')';
    if (c.not) return 'NOT ' + condText(c.not);
    const v = Array.isArray(c.value) ? '[' + c.value.join(', ') + ']' : c.value;
    return `${c.field} ${c.op} ${v}`;
  }
  async function renderRules(file) {
    file = file || 'rules';
    const d = await loadCfg(file);
    let body = '';
    if (!d) body = '<div class="empty">Not published yet.</div>';
    else if (file === 'rules') body = d.rules.map(r => `<div class="box"><h3 style="text-transform:none;letter-spacing:0;color:var(--text)">${esc(r.id)}${r.enabled === false ? ' <span class="pill unv">off</span>' : ''}</h3><div class="note" style="margin-top:0">${esc(r.description || '')}</div>
      <div style="font-size:13.5px;margin-top:6px"><b>IF</b> ${esc(condText(r.if))}<br><b>THEN</b> ${esc(JSON.stringify(r.then))}</div></div>`).join('');
    else if (file === 'templates') body = d.templates.map(t => `<div class="box"><h3 style="text-transform:none;letter-spacing:0;color:var(--text)">${esc(t.id)}</h3><div style="font-size:14px">${esc(t.text)}</div><div class="note"><b>When</b> ${esc(condText(t.when))}</div></div>`).join('');
    else if (file === 'flameon') body = d.rules.map(r => `<div class="box fo"><h3>${esc(r.id)} · ${esc(r.kind)}${r.direct ? ' · direct' : ''}</h3><div style="font-size:14px">${esc(r.text)}</div><div class="note"><b>When</b> ${esc(condText(r.when))}</div></div>`).join('');
    else if (file === 'scoring') {
      body = `<div class="box"><h3>Levels</h3><div class="kv"><span class="k">🔴 Critical</span><b>≥ ${d.levels.critical}</b><span class="k">🟠 Important</span><b>≥ ${d.levels.important}</b><span class="k">🟡 Notable</span><b>≥ ${d.levels.notable}</b><span class="k">⚪ Background</span><b>below</b></div><div class="note">${esc(d.criticalRequires?.label || '')}. ${esc(d.criticalRequires?.personalLabel || '')}.</div></div>
      <div class="box"><h3>Geography</h3><div class="kv"><span class="k">${esc(d.geography.pakistan.label)}</span><b>+${d.geography.pakistan.points}</b><span class="k">${esc(d.geography.majorInternational.label)}</span><b>+${d.geography.majorInternational.points}</b><span class="k">${esc(d.geography.minorInternational.label)}</span><b>+${d.geography.minorInternational.points}</b></div></div>
      <div class="box"><h3>Topic factors (best match counts)</h3><div class="kv">${d.topicFactors.map(f => `<span class="k">${esc(f.label)}</span><b>+${f.points}</b>`).join('')}</div></div>
      <div class="box"><h3>Source tier</h3><div class="kv">${Object.entries(d.tier).map(([k, t]) => `<span class="k">${esc(t.label)}</span><b>+${t.points}</b>`).join('')}</div></div>
      <div class="box"><h3>Urgency</h3><div class="kv"><span class="k">Breaking</span><b>+${d.urgency.breaking.points}</b><span class="k">Major update</span><b>+${d.urgency.major.points}</b><span class="k">Routine</span><b>+${d.urgency.normal.points}</b></div></div>
      <div class="box"><h3>Personal & corroboration</h3><div class="kv"><span class="k">${esc(d.personal.flameOnDirect.label)}</span><b>+${d.personal.flameOnDirect.points}</b><span class="k">${esc(d.personal.flameOnIndirect.label)}</span><b>+${d.personal.flameOnIndirect.points}</b><span class="k">${esc(d.personal.watchlist.label)}</span><b>+${d.personal.watchlist.points}</b>
        <span class="k">Per extra reliable publisher</span><b>+${d.corroboration.perExtraPublisher} (max ${d.corroboration.max})</b><span class="k">${esc(d.corroboration.widelyReported.label)}</span><b>+${d.corroboration.widelyReported.points}</b><span class="k">${esc(d.corroboration.tier1Confirmed.label)}</span><b>+${d.corroboration.tier1Confirmed.points}</b></div></div>
      <div class="box"><h3>Penalties</h3><div class="kv">${Object.values(d.penalties).map(p => `<span class="k">${esc(p.label)}</span><b>${p.points}</b>`).join('')}</div></div>`;
    } else if (file === 'entities') body = `<div class="box">${d.entities.map(e => `<span class="chip" title="${esc([...(e.aliases || []), ...(e.cs || [])].join(', '))}">${esc(e.name)}</span>`).join('')}</div>`;
    else if (file === 'categories') body = d.topics.map(t => `<div class="box"><h3 style="text-transform:none;letter-spacing:0;color:var(--text)">${esc(t.label)} <span class="tag">${esc(t.section)}</span>${t.noise ? ' <span class="tag">noise</span>' : ''}</h3><div class="note" style="margin-top:0">${esc((t.keywords || []).join(', '))}</div></div>`).join('');
    else if (file === 'publishers') body = `<div class="box"><div class="kv">${d.publishers.map(p => `<span class="k">${esc(p.name)}</span><b>Tier ${p.tier}</b>`).join('')}</div><div class="note">Unlisted publishers: tier ${d.defaultTier} (unverified).</div></div>`;
    view.innerHTML = `<a class="back" href="#/more">← More</a><h1>Rules & scoring</h1><div class="date">Everything the system decides comes from these files.</div>
      <select id="rf" style="margin-top:12px">${FILES.map(([k, l]) => `<option value="${k}" ${k === file ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <div class="row" style="margin-top:10px"><button class="btn sm" id="edit" ${Admin.hasToken() ? '' : 'disabled'}>Edit JSON</button>${Admin.hasToken() ? '' : '<span class="note" style="margin:0">Admin access needed to edit</span>'}</div>
      <div id="ed"></div>${body}`;
    $('#rf').onchange = e => renderRules(e.target.value);
    $('#edit').onclick = async () => {
      const path = `config/${file}.json`;
      try {
        const { data } = await Admin.readJson(path);
        $('#ed').innerHTML = `<div class="box"><textarea id="ta" spellcheck="false">${esc(JSON.stringify(data, null, 2))}</textarea>
          <div class="row" style="margin-top:10px"><button class="btn" id="val">Validate</button><button class="btn primary" id="sv">Save</button></div><div class="note" id="vr">Validated again before saving; the pipeline also refuses invalid config.</div></div>`;
        const parse = () => { try { return JSON.parse($('#ta').value); } catch (e) { $('#vr').innerHTML = `<span class="bad-t">JSON error: ${esc(e.message)}</span>`; return null; } };
        $('#val').onclick = () => { const j = parse(); if (!j) return; const errs = Admin.validate(path, j); $('#vr').innerHTML = errs.length ? `<span class="bad-t">${errs.map(esc).join('<br>')}</span>` : '<span class="ok-t">✓ Valid</span>'; };
        $('#sv').onclick = async () => { const j = parse(); if (!j) return; try { await Admin.update(path, () => j, `Edit ${file}.json from the app`); S.cfg[file] = j; toast('Saved. Applies from the next run.'); renderRules(file); } catch (e) { $('#vr').innerHTML = `<span class="bad-t">${esc(e.message)}</span>`; } };
      } catch (e) { toast(e.message, 6000); }
    };
  }

  // ---------- health ----------
  async function renderHealth() {
    const h = await loadHealth(true);
    if (!h) { view.innerHTML = '<a class="back" href="#/more">← More</a><div class="empty">No health data published yet.</div>'; return; }
    const t = h.totals, last = h.runs?.[0];
    let x = `<a class="back" href="#/more">← More</a><h1>System health</h1><div class="date">Snapshot from ${fmtWhen(h.generatedAt)} (${ago(h.generatedAt)}) · analysis provider: <b>${esc(h.provider)}</b></div>
      <div class="row" style="margin-top:10px"><button class="btn sm" id="run" ${Admin.hasToken() ? '' : 'disabled'}>Run pipeline now</button></div>
      <section class="sec"><div class="stat">
        <div><b>${t.feedsActive - t.feedsFailing}/${t.feedsActive}</b><span>feeds healthy</span></div><div><b>${t.articles24h}</b><span>articles, 24 h</span></div>
        <div><b>${t.stories24h}</b><span>new stories, 24 h</span></div><div><b>${t.byLevel24h.critical}/${t.byLevel24h.important}/${t.byLevel24h.notable}</b><span>crit/imp/notable, 24 h</span></div>
        <div><b>${t.notificationsSent24h}</b><span>alerts sent, 24 h</span></div><div><b class="${t.notificationsFailed7d ? 'bad-t' : ''}">${t.notificationsFailed7d}</b><span>failed alerts, 7 d</span></div>
        <div><b>${t.held}</b><span>held (quiet hours)</span></div><div><b>${t.suppressed7d}</b><span>rate-limited, 7 d</span></div></div></section>
      <section class="sec">${secHead('Channels')}<div class="list">${(h.channels || []).map(c => `<div class="li"><div><b>${esc(c.name)}</b><div class="sub">${c.ok ? `${c.targets} device(s)` : esc(c.why || 'off')}</div></div><span class="${c.ok ? 'ok-t' : 'warn-t'}">${c.ok ? '● ready' : '○ not ready'}</span></div>`).join('')}</div></section>
      <section class="sec">${secHead('Scheduled jobs')}<div class="box" style="margin-top:0"><div class="kv">
        <span class="k">Last run</span><b>${last ? ago(last.at) : '—'}</b><span class="k">Duration</span><b>${last?.ms ? (last.ms / 1000).toFixed(1) + ' s' : '—'}</b>
        ${Object.entries(h.lastBriefings || {}).map(([k, b]) => `<span class="k">Last ${k} briefing</span><b>${b ? fmtWhen(b.created_at) : '—'}</b>`).join('')}</div></div>
        <div class="list" style="margin-top:10px">${(h.runs || []).slice(0, 10).map(r => `<div class="feedrow"><span class="${r.level === 'ok' ? 'ok-t' : 'warn-t'}">●</span> ${fmtWhen(r.at)} · ${r.newArticles ?? 0} new articles · ${r.newStories ?? 0} new stories · ${r.alertsCreated ?? 0} alerts${r.feedsFailed ? ` · <span class="bad-t">${r.feedsFailed} feeds failed</span>` : ''}${r.errors ? ` · <span class="bad-t">${r.errors} stage errors</span>` : ''}</div>`).join('')}</div></section>
      <section class="sec">${secHead('Feeds')}<div class="list">${(h.feeds || []).filter(f => f.active).map(f => `<div class="feedrow"><div class="row" style="justify-content:space-between"><span><b>${esc(f.source)}</b> · ${esc(f.id)}</span><span class="${f.fails ? 'bad-t' : 'ok-t'}">${f.fails ? 'failing ×' + f.fails : 'ok'}</span></div>
        <div class="note" style="margin:2px 0 0">last success ${f.last_success_at ? ago(f.last_success_at) : 'never'} · ${f.items_last ?? 0} items · ${f.total_new ?? 0} new total</div>${f.fails ? `<div class="err">${esc(f.last_error || '')}</div>` : ''}</div>`).join('')}</div></section>
      <section class="sec">${secHead('Recent notifications')}<div class="list">${(h.notifications || []).map(n => `<div class="feedrow"><div><b>${esc(n.title)}</b></div><div class="note" style="margin:2px 0">${esc((n.body || '').split('\n')[0])}</div>
        <div class="note" style="margin:0">${fmtWhen(n.created_at)} · <b>${esc(n.status)}</b>${n.status_reason ? ' — ' + esc(n.status_reason) : ''}${n.deliveries ? ' · ' + esc(n.deliveries) : ''}</div></div>`).join('') || '<div class="feedrow">None yet.</div>'}</div></section>`;
    view.innerHTML = x;
    $('#run').onclick = async () => { try { await Admin.runNow({}); toast('Run requested. Fresh data in ~2 minutes.', 5000); } catch (e) { toast(e.message, 6000); } };
  }

  // ---------- admin + about ----------
  function renderAdmin() {
    view.innerHTML = `<a class="back" href="#/more">← More</a><h1>Admin access</h1>
      <div class="box"><p style="margin-top:0">Changing settings, sources, rules or the watchlist from your phone writes to your GitHub repo <b>${esc(Admin.repo)}</b>. That needs a <b>fine-grained personal access token</b>, stored only on this device.</p>
      <ol style="padding-left:18px;font-size:14px;line-height:1.6">
        <li>Open <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">github.com → Settings → Fine-grained tokens → Generate</a>.</li>
        <li>Repository access: <b>Only select repositories</b> → <b>${esc(Admin.repo.split('/')[1])}</b>.</li>
        <li>Permissions → Repository: <b>Contents: Read and write</b>, <b>Actions: Read and write</b>. Nothing else.</li>
        <li>Expiration: your choice (e.g. 1 year). Paste the token below.</li></ol>
      <label class="f" for="tok">Token</label><input type="password" id="tok" placeholder="${Admin.hasToken() ? '•••••••• (saved)' : 'github_pat_…'}" autocomplete="off">
      <div class="row" style="margin-top:12px"><button class="btn primary" id="tSave">Save & verify</button>${Admin.hasToken() ? '<button class="btn danger" id="tClr">Remove from this device</button>' : ''}</div>
      <div class="note" id="tRes">The token never leaves this device except in requests to api.github.com.</div></div>`;
    $('#tSave').onclick = async () => {
      const v = $('#tok').value.trim();
      if (v) Admin.setToken(v);
      try { const w = await Admin.whoami(); $('#tRes').innerHTML = w.push ? `<span class="ok-t">✓ Connected to ${esc(w.full)} with write access.</span>` : `<span class="bad-t">Token works but has no write access to ${esc(w.full)}.</span>`; }
      catch (e) { $('#tRes').innerHTML = `<span class="bad-t">${esc(e.message)}</span>`; }
    };
    const c = $('#tClr'); if (c) c.onclick = () => { Admin.setToken(null); toast('Token removed'); renderAdmin(); };
  }
  async function renderAbout() {
    const sc = await loadCfg('scoring');
    view.innerHTML = `<a class="back" href="#/more">← More</a><h1>How this works</h1>
      <div class="box"><h3>What it does</h3><p style="margin:0">Every ~15 minutes a free scheduled job reads ${S.health?.totals?.feedsActive || 'about 50'} public RSS feeds, removes duplicates, groups reports about the same event into one story, matches entities and topics, and scores each story with transparent rules. It then decides whether the story deserves to interrupt you. This page is static, and the phone simply reads the result.</p></div>
      <div class="box"><h3>Levels</h3><div class="kv"><span class="k">🔴 Critical: immediate alert</span><b>≥ ${sc?.levels?.critical ?? '—'}</b><span class="k">🟠 Important: alert, depending on your settings</span><b>≥ ${sc?.levels?.important ?? '—'}</b><span class="k">🟡 Notable: briefings</span><b>≥ ${sc?.levels?.notable ?? '—'}</b><span class="k">⚪ Background: stored, never pushed</span><b>below</b></div></div>
      <div class="box"><h3>Honesty rules</h3><ul style="padding-left:18px;margin:0;font-size:14px;line-height:1.55">
        <li><b>Fact</b> = what named publishers reported (headline and short excerpt), always attributed and linked.</li>
        <li><b>Rule-based inference</b> = "why it matters" templates and Flame On impacts, clearly labelled. These are general statements triggered by keyword rules, not analysis of the specific story.</li>
        <li><b>Unknown</b> = everything not in the headlines. The app never reads or summarises full articles.</li>
        <li>Unverified (tier-4) sources cannot trigger alerts, and a Critical alert needs 2+ reliable publishers or an official source.</li>
        <li>No AI service is used. The analysis provider is <b>rules</b>; a local or cloud AI module can be added later without changing the rest.</li></ul></div>
      <div class="box"><h3>Limitations</h3><ul style="padding-left:18px;margin:0;font-size:14px;line-height:1.55">
        <li>GitHub's free scheduler runs every 15 minutes but can be delayed. Expect alerts 15–45 minutes after publication, not seconds.</li>
        <li>RSS feeds themselves lag the news by minutes to hours. Some outlets (Reuters, AP) have no public feed and are reached via Google News search.</li>
        <li>iPhone: push requires iOS 16.4+ and the app added to the Home Screen.</li>
        <li>Keyword rules can misfire. Every decision is visible in the story's score breakdown, so wrong ones are easy to spot and fix in Rules.</li></ul></div>`;
  }

  // ---------- router ----------
  async function route() {
    const h = location.hash.replace(/^#\/?/, '');
    const [p, a] = h.split('/');
    const tab = { '': 'home', changed: 'changed', briefings: 'briefings', briefing: 'briefings', watch: 'watch' }[p] || (['story', 'section'].includes(p) ? 'home' : 'more');
    document.querySelectorAll('.tabbar a').forEach(x => x.classList.toggle('on', x.dataset.tab === tab));
    try {
      if (!S.feed) await loadFeed();
      if (p === '' || p === undefined) renderHome();
      else if (p === 'story') await renderStory(Number(a));
      else if (p === 'changed') { await loadBriefIdx(); renderChanged(); }
      else if (p === 'section') renderSection(a);
      else if (p === 'briefings') await renderBriefings();
      else if (p === 'briefing') await renderBriefing(decodeURIComponent(a));
      else if (p === 'watch') await renderWatch();
      else if (p === 'more') renderMore();
      else if (p === 'settings') await renderSettings();
      else if (p === 'sources') await renderSources();
      else if (p === 'rules') await renderRules(a);
      else if (p === 'health') await renderHealth();
      else if (p === 'admin') renderAdmin();
      else if (p === 'about') { await loadHealth(); await renderAbout(); }
      else renderHome();
    } catch (e) {
      view.innerHTML = `<div class="empty">Something went wrong: ${esc(e.message)}</div>`;
    }
    if (!['watch'].includes(p)) window.scrollTo(0, 0);
  }

  // ---------- boot ----------
  async function boot() {
    applyTheme(LS.get('ca_theme', 'auto'));
    S.prevVisit = LS.get('ca_lastVisit') || null;
    const markVisit = () => LS.set('ca_lastVisit', new Date().toISOString());
    document.addEventListener('visibilitychange', async () => {
      if (document.visibilityState === 'hidden') markVisit();
      else if (S.feed && (!S.feed.generatedAt || hoursSince(S.feed.loadedAt || 0) > 0.08)) { await loadFeed(); S.feed.loadedAt = new Date().toISOString(); if (!location.hash || location.hash === '#/') renderHome(); }
    });
    window.addEventListener('pagehide', markVisit);
    window.addEventListener('hashchange', route);
    window.addEventListener('online', () => ($('#offline').hidden = true));
    window.addEventListener('offline', () => ($('#offline').hidden = false));
    window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); S.deferredInstall = e; });
    navigator.serviceWorker?.addEventListener('message', e => { if (e.data?.nav) location.href = e.data.nav; });
    const [prefs, push] = await Promise.all([loadCfg('preferences'), loadCfg('push'), loadCfg('categories'), loadCfg('scoring')]);
    if (prefs?.timezone) S.tz = prefs.timezone;
    Admin.configure(push);
    await loadFeed(); S.feed.loadedAt = new Date().toISOString();
    route();
    setInterval(async () => { if (document.visibilityState === 'visible') { await loadFeed(); S.feed.loadedAt = new Date().toISOString(); } }, 10 * 6e4);
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  }
  boot();
})();
