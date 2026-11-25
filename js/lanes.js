// Bahn-Profile: gespeicherte Einrichtungen (Ecken + kleines Referenzbild) zum schnellen Wechseln zwischen Bahnen.
// Liegt nur im Browser-Speicher dieses Geräts.
const KEY = 'bt.lanes.v1', ACT = 'bt.lane.active', MAX = 30;

export function lanes() {
  try { const a = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
}
function write(a) {
  try { localStorage.setItem(KEY, JSON.stringify(a)); return true; } catch { return false; }   // voll oder privat
}
export function laneById(id) { return lanes().find(l => l.id === id) || null; }
export function activeLane() { let id = null; try { id = localStorage.getItem(ACT); } catch { /* */ } return id ? laneById(id) : null; }
export function setActiveLane(id) { try { if (id) localStorage.setItem(ACT, id); else localStorage.removeItem(ACT); } catch { /* */ } }

// p: { name, corners, img (JPEG-Daten-URL), w, h }. Gleicher Name überschreibt. Rückgabe: gespeichertes Profil oder null
export function saveLane(p) {
  const a = lanes(), now = Date.now();
  let l = (p.id && a.find(x => x.id === p.id)) || a.find(x => x.name.trim().toLowerCase() === p.name.trim().toLowerCase());
  if (l) Object.assign(l, p, { id: l.id, used: now });
  else { l = { ...p, id: 'l' + now.toString(36) + Math.random().toString(36).slice(2, 6), created: now, used: now }; a.push(l); }
  a.sort((x, y) => (y.used || 0) - (x.used || 0));
  while (a.length > MAX) a.pop();
  return write(a) ? l : null;
}
export function touchLane(id, patch = {}) {
  const a = lanes(), l = a.find(x => x.id === id);
  if (!l) return null;
  Object.assign(l, patch, { used: Date.now() });
  return write(a) ? l : null;
}
export function deleteLane(id) {
  write(lanes().filter(l => l.id !== id));
  if (activeLane()?.id === id) setActiveLane(null);
}
