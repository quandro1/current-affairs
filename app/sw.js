// Service worker: offline shell + network-first data + Web Push display.
// Bump CACHE on every app release so installed copies pick up the new shell.
const CACHE = 'ca-v1.0.1';
const SHELL = ['./', './index.html', './styles.css', './app.js', './admin.js', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/badge-96.png', './icons/favicon-32.png'];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    for (const u of SHELL) { try { if (!(await c.match(u))) await c.add(u); } catch (_) { /* non-fatal: next load retries */ } }
    self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // GitHub API etc. go straight to the network
  const isData = url.pathname.includes('/data/');
  const isDoc = req.mode === 'navigate';
  if (isData || isDoc) {
    // Network first so news is fresh; cached copy when offline.
    e.respondWith((async () => {
      try {
        const res = await fetch(req, { cache: 'no-store' });
        if (res.ok) { const c = await caches.open(CACHE); c.put(isDoc ? './index.html' : req, res.clone()).catch(() => {}); }
        return res;
      } catch (_) {
        const hit = await caches.match(isDoc ? './index.html' : req, { ignoreSearch: true });
        return hit || new Response(JSON.stringify({ offline: true }), { status: 503, headers: { 'content-type': 'application/json' } });
      }
    })());
    return;
  }
  e.respondWith((async () => {
    const hit = await caches.match(req, { ignoreSearch: true });
    if (hit) return hit;
    const res = await fetch(req);
    if (res.ok) { const c = await caches.open(CACHE); c.put(req, res.clone()).catch(() => {}); }
    return res;
  })());
});

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { title: 'Current Affairs', body: e.data && e.data.text() }; }
  const title = d.title || 'Current Affairs';
  e.waitUntil(self.registration.showNotification(title, {
    body: d.body || '',
    tag: d.tag || undefined,
    renotify: d.level === 'critical',
    requireInteraction: d.level === 'critical',
    icon: 'icons/icon-192.png',
    badge: 'icons/badge-96.png',
    data: { url: d.url || './#/' },
    timestamp: d.ts || Date.now()
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const target = new URL(e.notification.data?.url || './#/', self.registration.scope).href;
  e.waitUntil((async () => {
    const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) { if (c.url.startsWith(self.registration.scope)) { await c.focus(); c.navigate ? c.navigate(target) : c.postMessage({ nav: target }); return; } }
    await clients.openWindow(target);
  })());
});
