// Offline: App-Hülle vorab cachen, danach "stale-while-revalidate".
const V = 'hl-v1.7.1';
const SHELL = ['./', 'index.html', 'manifest.webmanifest', 'css/app.css', 'icons/icon.svg', 'icons/icon-small.svg', 'icons/icon-32.png', 'icons/icon-192.png',
  'js/main.js', 'js/settings.js', 'js/i18n.js', 'js/db.js', 'js/store.js', 'js/ui.js', 'js/camera.js', 'js/processor.js',
  'js/analysis.js', 'js/scoring.js', 'js/lane.js', 'js/replay.js', 'js/pinsim.js', 'js/mascot.js', 'js/autotune.js',
  'js/vision/engine.js', 'js/vision/geometry.js', 'js/vision/lk.js', 'js/vision/worker.js', 'js/vision/snap.js', 'js/vision/autolane.js',
  'js/views/live.js', 'js/views/history.js', 'js/views/stats.js', 'js/views/options.js', 'js/views/common.js'];

self.addEventListener('install', (e) => { e.waitUntil(caches.open(V).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.includes('/test/')) return;
  e.respondWith(caches.open(V).then(async (c) => {
    const hit = await c.match(e.request, { ignoreSearch: true });
    // beim Server nachfragen (umgeht den 10-Minuten-Cache von GitHub Pages); offline greift der Speicher
    const net = fetch(e.request, { cache: 'no-cache' }).then(r => { if (r.ok) c.put(e.request, r.clone()); return r; }).catch(() => hit);
    return hit || net;
  }));
});
