// Gezielte Aktualisierung: prüfen, ob auf dem Server eine neuere Fassung liegt, und sie auf Wunsch übernehmen.
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

export async function applyUpdate() {
  const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
  const reload = () => location.reload();
  if (!reg) { reload(); return; }
  navigator.serviceWorker.addEventListener('controllerchange', reload, { once: true });
  try { await reg.update(); } catch { /* offline */ }
  // auf die neue, fertig geladene Fassung warten (höchstens 20 s)
  const waitInstalled = () => new Promise((res) => {
    if (reg.waiting) return res(reg.waiting);
    const sw = reg.installing;
    if (!sw) return res(null);
    sw.addEventListener('statechange', () => { if (sw.state === 'installed') res(reg.waiting || sw); if (sw.state === 'redundant') res(null); });
    setTimeout(() => res(reg.waiting || null), 20000);
  });
  const w = await waitInstalled();
  if (w) w.postMessage('skipWaiting');
  else { // kein neuer Service Worker gefunden: Speicher leeren und frisch laden
    for (const k of await caches.keys()) await caches.delete(k);
    reload();
  }
}
