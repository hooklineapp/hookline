// Offline-Speicher: die App läuft immer mit der Fassung, die bereits im Browser liegt ("cache first").
// Eine neue Fassung wird erst übernommen, wenn der Nutzer in Optionen → Info "Aktualisieren" tippt.
const V = 'hl-v1.14.4';
const SHELL = ['./', 'index.html', 'manifest.webmanifest', 'css/app.css', 'icons/icon.svg', 'icons/icon-small.svg', 'icons/icon-32.png', 'icons/icon-192.png',
  'js/main.js', 'js/settings.js', 'js/i18n.js', 'js/db.js', 'js/store.js', 'js/ui.js', 'js/camera.js', 'js/processor.js',
  'js/analysis.js', 'js/scoring.js', 'js/lane.js', 'js/replay.js', 'js/pinsim.js', 'js/mascot.js', 'js/autotune.js', 'js/update.js', 'js/colorpicker.js', 'js/pinphys.js', 'js/pinsim3d.js', 'js/sim3d-worker.js', 'js/pin3d-gl.js',
  'js/vision/engine.js', 'js/vision/geometry.js', 'js/vision/lk.js', 'js/vision/worker.js', 'js/vision/snap.js', 'js/vision/autolane.js',
  'js/views/live.js', 'js/views/history.js', 'js/views/stats.js', 'js/views/options.js', 'js/views/common.js'];

self.addEventListener('install', (e) => {
  // neue Fassung vollständig laden, aber noch nicht aktivieren (wartet auf "Aktualisieren").
  // Jede Datei mit ?v=<Version> abrufen: so liefert auch der CDN-Zwischenspeicher garantiert die neue Fassung.
  e.waitUntil((async () => {
    const c = await caches.open(V);
    // Fortschritt an alle offenen Fenster melden (Lade-Overlay beim Aktualisieren)
    let done = 0;
    const tell = async (extra) => {
      for (const cl of await self.clients.matchAll({ includeUncontrolled: true, type: 'window' }))
        cl.postMessage({ type: 'sw-progress', version: V, done, total: SHELL.length, ...extra });
    };
    await tell();
    await Promise.all(SHELL.map(async (u) => {
      const r = await fetch(new Request(u + (u.includes('?') ? '&' : '?') + 'v=' + V, { cache: 'reload' }));
      if (!r.ok) throw new Error('Laden fehlgeschlagen: ' + u);
      await c.put(new Request(u), r);
      done++; await tell({ file: u });
    }));
  })());
});
self.addEventListener('message', (e) => { if (e.data === 'skipWaiting') self.skipWaiting(); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.includes('/test/') || u.pathname.endsWith('/version.json')) return;
  e.respondWith((async () => {
    const c = await caches.open(V);
    const hit = await c.match(e.request, { ignoreSearch: true });
    if (hit) return hit;
    const r = await fetch(e.request, { cache: 'no-cache' });
    if (r.ok) c.put(e.request, r.clone());
    return r;
  })());
});
