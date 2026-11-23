// Offline-Speicher: online immer zuerst die neueste Fassung vom Server holen ("network first"),
// nur ohne Netz (oder bei sehr langsamem Netz) aus dem Speicher antworten.
const V = 'hl-v1.8.0';
const SHELL = ['./', 'index.html', 'manifest.webmanifest', 'css/app.css', 'icons/icon.svg', 'icons/icon-small.svg', 'icons/icon-32.png', 'icons/icon-192.png',
  'js/main.js', 'js/settings.js', 'js/i18n.js', 'js/db.js', 'js/store.js', 'js/ui.js', 'js/camera.js', 'js/processor.js',
  'js/analysis.js', 'js/scoring.js', 'js/lane.js', 'js/replay.js', 'js/pinsim.js', 'js/mascot.js', 'js/autotune.js',
  'js/vision/engine.js', 'js/vision/geometry.js', 'js/vision/lk.js', 'js/vision/worker.js', 'js/vision/snap.js', 'js/vision/autolane.js',
  'js/views/live.js', 'js/views/history.js', 'js/views/stats.js', 'js/views/options.js', 'js/views/common.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(V).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.includes('/test/')) return;
  e.respondWith((async () => {
    const c = await caches.open(V);
    const net = fetch(e.request, { cache: 'no-cache' }).then(r => { if (r.ok) c.put(e.request, r.clone()); return r; });
    // höchstens 4 s aufs Netz warten, dann (falls vorhanden) gespeicherte Fassung
    const timeout = new Promise(res => setTimeout(res, 4000));
    try {
      const r = await Promise.race([net, timeout]);
      if (r) return r;
    } catch { /* offline */ }
    const hit = await c.match(e.request, { ignoreSearch: true });
    return hit || net;
  })());
});
