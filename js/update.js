// Gezielte Aktualisierung: prüfen, ob auf dem Server eine neuere Fassung liegt, und sie auf Wunsch übernehmen.
// Alle Abrufe tragen die Versionsnummer im Namen, damit kein Zwischenspeicher (Browser oder CDN) Altes liefert.
const cmp = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); } return 0; };

export async function checkUpdate() {
  try {
    const r = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' });
    const { version } = await r.json();
    return { current: window.BT_VERSION, latest: version, available: cmp(version, window.BT_VERSION) > 0 };
  } catch {
    return { current: window.BT_VERSION, latest: null, available: false, offline: true };
  }
}

async function hardReload() {
  for (const k of await caches.keys()) await caches.delete(k);
  location.replace(location.pathname + '?u=' + Date.now() + location.hash);
}

// onProgress(anteil 0..1 oder null, schritt): 'start' | 'files' | 'activate' | 'reload'
export async function applyUpdate(latest, onProgress) {
  const prog = (p, step, extra) => { try { onProgress?.(p, step, extra); } catch { /* */ } };
  prog(null, 'start');
  if (!('serviceWorker' in navigator)) { prog(1, 'reload'); await hardReload(); return; }
  const onMsg = (e) => { const m = e.data; if (m && m.type === 'sw-progress' && m.total) prog(0.05 + 0.85 * m.done / m.total, 'files', m); };
  navigator.serviceWorker.addEventListener('message', onMsg);
  let done = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (!done) { done = true; prog(1, 'reload'); location.reload(); } }, { once: true });
  let reg;
  try {
    // neuen Service Worker mit Versionsnummer registrieren -> wird garantiert frisch geladen
    reg = await navigator.serviceWorker.register('sw.js?v=' + (latest || Date.now()), { updateViaCache: 'none' });
  } catch { await hardReload(); return; }
  // nichts Neues zu installieren (Service Worker ist schon aktuell) -> direkt frisch laden
  if (!reg.installing && !reg.waiting) { try { await reg.update(); } catch { /* */ } }
  if (!reg.installing && !reg.waiting) { prog(1, 'reload'); await hardReload(); return; }
  const w = await new Promise((res) => {
    const check = () => {
      if (reg.waiting) return res(reg.waiting);
      const sw = reg.installing;
      if (!sw) return false;
      sw.addEventListener('statechange', () => { if (sw.state === 'installed') res(reg.waiting || sw); if (sw.state === 'redundant') res(null); });
      return true;
    };
    if (!check()) reg.addEventListener('updatefound', check, { once: true });
    setTimeout(() => res(reg.waiting || null), 25000);
  });
  if (w) { prog(0.93, 'activate'); w.postMessage('skipWaiting'); }
  else await hardReload();
  // falls der Wechsel nicht automatisch neu lädt
  setTimeout(() => { if (!done) { done = true; hardReload(); } }, 4000);
}
