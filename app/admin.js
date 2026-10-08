// Admin layer: saves settings/sources/rules back to the GitHub repo with YOUR fine-grained token.
// The token stays in this browser's localStorage only; it is never published or sent anywhere except api.github.com.
(function () {
  const TOKEN_KEY = 'ca_gh_token';
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (_) { /* private mode */ } }
  };

  let repo = 'quandro1/current-affairs', branch = 'main';
  function configure(push) { if (push?.repo) repo = push.repo; if (push?.branch) branch = push.branch; }
  const token = () => store.get(TOKEN_KEY);
  const hasToken = () => !!token();
  function setToken(t) { store.set(TOKEN_KEY, t ? t.trim() : null); }

  async function gh(path, opts = {}) {
    const t = token();
    if (!t) throw new Error('No admin token set (More → Admin access).');
    const res = await fetch(`https://api.github.com${path}`, {
      ...opts,
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${t}`, 'X-GitHub-Api-Version': '2022-11-28', ...(opts.body ? { 'Content-Type': 'application/json' } : {}) }
    });
    if (res.status === 204) return null;
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`GitHub ${res.status}: ${j.message || 'request failed'}`);
    return j;
  }

  const b64decode = s => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\n/g, '')), c => c.charCodeAt(0)));
  const b64encode = s => { const bytes = new TextEncoder().encode(s); let bin = ''; for (const b of bytes) bin += String.fromCharCode(b); return btoa(bin); };

  async function readJson(path) {
    const j = await gh(`/repos/${repo}/contents/${path}?ref=${branch}`);
    return { data: JSON.parse(b64decode(j.content)), sha: j.sha };
  }
  async function writeJson(path, data, message, sha) {
    const content = JSON.stringify(data, null, 2) + '\n';
    return gh(`/repos/${repo}/contents/${path}`, { method: 'PUT', body: JSON.stringify({ message, content: b64encode(content), sha, branch }) });
  }
  // Read-modify-write with one retry on a conflict (e.g. two devices saving at once).
  async function update(path, mutate, message) {
    for (let i = 0; i < 2; i++) {
      const { data, sha } = await readJson(path);
      const next = await mutate(structuredClone(data));
      const errs = validate(path, next);
      if (errs.length) throw new Error('Not saved — validation failed:\n' + errs.slice(0, 6).join('\n'));
      try { return await writeJson(path, next, message, sha); }
      catch (e) { if (i === 0 && /409|does not match/.test(e.message)) continue; throw e; }
    }
  }
  async function runNow(inputs = {}) {
    return gh(`/repos/${repo}/actions/workflows/pipeline.yml/dispatches`, { method: 'POST', body: JSON.stringify({ ref: branch, inputs }) });
  }
  async function whoami() {
    const r = await gh(`/repos/${repo}`);
    return { full: r.full_name, push: !!r.permissions?.push };
  }

  // ---- validation (mirrors src/engine/conditions.js + src/config.js) ----
  const FIELDS = ['countries', 'topics', 'entities', 'sections', 'tier', 'sourceCount', 'urgency', 'direction', 'pct', 'casualties', 'score', 'level', 'text', 'title', 'flameOn', 'watch', 'opinion', 'noise', 'majorCountry', 'ageHours', 'tier1', 'baseScore', 'reliableCount'];
  const OPS = ['has', 'hasAny', 'hasAll', 'hasNone', 'eq', 'ne', 'in', 'gt', 'gte', 'lt', 'lte', 'matches', 'exists'];
  function vCond(c, p) {
    const e = [];
    if (!c || typeof c !== 'object') return [`${p}: condition must be an object`];
    if (Array.isArray(c)) { c.forEach((x, i) => e.push(...vCond(x, `${p}[${i}]`))); return e; }
    if (c.all || c.any) { const l = c.all || c.any; if (!Array.isArray(l) || !l.length) return [`${p}: all/any needs a non-empty list`]; l.forEach((x, i) => e.push(...vCond(x, `${p}[${i}]`))); return e; }
    if (c.not) return vCond(c.not, `${p}.not`);
    if (!FIELDS.includes(c.field)) e.push(`${p}: unknown field "${c.field}"`);
    if (!OPS.includes(c.op)) e.push(`${p}: unknown op "${c.op}"`);
    if (c.op === 'matches') { try { new RegExp(c.value, 'iu'); } catch (x) { e.push(`${p}: bad regex`); } }
    return e;
  }
  const LV = ['background', 'notable', 'important', 'critical'];
  const HM = /^\d{2}:\d{2}$/;
  function validate(path, d) {
    const e = [];
    if (path.endsWith('preferences.json')) {
      if (!['critical', 'critical+important', 'all'].includes(d.severity)) e.push('severity invalid');
      for (const k of ['daily', 'evening', 'weekly', 'monthly']) if (d[k]?.time && !HM.test(d[k].time)) e.push(`${k}.time must be HH:MM`);
      if (d.quietHours?.enabled && !(HM.test(d.quietHours.start) && HM.test(d.quietHours.end))) e.push('quiet hours must be HH:MM');
      (d.watchlist || []).forEach((w, i) => { if (!w.id || !w.label) e.push(`watchlist[${i}] needs id and label`); if (w.match) e.push(...vCond(w.match, `watchlist.${w.id}`)); });
    } else if (path.endsWith('sources.json')) {
      const ids = new Set(), fids = new Set();
      for (const s of d.sources || []) {
        if (!/^[a-z0-9-]+$/.test(s.id || '')) e.push(`source id "${s.id}" must be lowercase letters, digits, dashes`);
        if (ids.has(s.id)) e.push(`duplicate source ${s.id}`); ids.add(s.id);
        if (!(s.tier === 'publisher' || [1, 2, 3, 4].includes(s.tier))) e.push(`${s.id}: tier must be 1-4`);
        for (const f of s.feeds || []) {
          if (fids.has(f.id)) e.push(`duplicate feed ${f.id}`); fids.add(f.id);
          if (f.kind !== 'gnews' && !/^https?:\/\//.test(f.url || '')) e.push(`${f.id}: feed URL must start with http(s)://`);
        }
      }
    } else if (path.endsWith('rules.json')) {
      for (const r of d.rules || []) { e.push(...vCond(r.if, `rules.${r.id}`)); for (const k of ['minLevel', 'maxLevel']) if (r.then?.[k] && !LV.includes(r.then[k])) e.push(`rules.${r.id}: bad ${k}`); }
    } else if (path.endsWith('templates.json')) {
      for (const t of d.templates || []) { if (!t.text) e.push(`templates.${t.id}: text required`); e.push(...vCond(t.when, `templates.${t.id}`)); }
    } else if (path.endsWith('flameon.json')) {
      for (const r of d.rules || []) e.push(...vCond(r.when, `flameon.${r.id}`));
    } else if (path.endsWith('scoring.json')) {
      for (const f of d.topicFactors || []) e.push(...vCond(f.when, `scoring.${f.id}`));
      const L = d.levels || {};
      if (!(L.critical > L.important && L.important > L.notable)) e.push('levels must satisfy critical > important > notable');
    } else if (path.endsWith('subscriptions.json')) {
      for (const s of d.subscriptions || []) if (!s.endpoint || !s.keys?.p256dh || !s.keys?.auth) e.push('subscription missing endpoint/keys');
    }
    return e;
  }

  // ---- Web Push subscription ----
  function urlB64ToUint8Array(b64) {
    const pad = '='.repeat((4 - (b64.length % 4)) % 4);
    const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, c => c.charCodeAt(0));
  }
  async function subscribe(vapidPublicKey) {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('This browser does not support Web Push here. On iPhone: Share → Add to Home Screen, then open the app from the icon (iOS 16.4+).');
    if (!vapidPublicKey) throw new Error('Push is not configured yet (no VAPID public key in config/push.json).');
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error('Notification permission was not granted. Enable it in the browser/site settings.');
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(vapidPublicKey) });
    return sub.toJSON();
  }
  function deviceLabel() {
    const ua = navigator.userAgent;
    const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'Mac' : 'Device';
    const br = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
    return `${os} · ${br}`;
  }
  async function registerSubscription(sub) {
    return update('config/subscriptions.json', d => {
      d.subscriptions = (d.subscriptions || []).filter(s => s.endpoint !== sub.endpoint);
      d.subscriptions.push({ endpoint: sub.endpoint, keys: sub.keys, label: deviceLabel(), addedAt: new Date().toISOString() });
      return d;
    }, `Add push subscription (${deviceLabel()})`);
  }
  async function unregisterSubscription() {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return false;
    const ep = sub.endpoint;
    await sub.unsubscribe();
    if (hasToken()) await update('config/subscriptions.json', d => { d.subscriptions = (d.subscriptions || []).filter(s => s.endpoint !== ep); return d; }, 'Remove push subscription');
    return true;
  }

  window.Admin = { configure, hasToken, setToken, readJson, update, runNow, whoami, validate, subscribe, registerSubscription, unregisterSubscription, deviceLabel, get repo() { return repo; } };
})();
