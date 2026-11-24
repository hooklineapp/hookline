// "Auto" für die Bahnecken: erst das Modell (ohne Antippen), sonst Kantensuche um den angetippten Punkt.
// Gemeinsam für Worker und Hauptthread (js/processor.js).
import { autoLane } from './autolane.js';
import { snapCorners, snapNormalized } from './snap.js';
import { toGray } from './lk.js';
import { loadLaneNet, runLaneNet } from './lanenet.js';
import { homography, apply } from './geometry.js';

// Gegencheck: konvexes Viereck, Foul-Linie vorn (unten), Bahn hinten schmaler als vorn, nicht winzig
export function plausible(c, w, h) {
  const P = c.map(([u, v]) => [u * w, v * h]), [fl, fr, kl, kr] = P;
  const q = [fl, fr, kr, kl];
  let sgn = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4], d = q[(i + 2) % 4];
    const z = (b[0] - a[0]) * (d[1] - b[1]) - (b[1] - a[1]) * (d[0] - b[0]);
    if (Math.abs(z) < 1e-6) return false;
    if (sgn && Math.sign(z) !== sgn) return false;
    sgn = Math.sign(z);
  }
  const len = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const front = len(fl, fr), back = len(kl, kr), H = Math.max(w, h);
  if (front < 0.03 * H || back >= front * 1.05) return false;
  const mf = [(fl[0] + fr[0]) / 2, (fl[1] + fr[1]) / 2], mk = [(kl[0] + kr[0]) / 2, (kl[1] + kr[1]) / 2];
  return mf[1] > mk[1] && len(mf, mk) > 0.05 * H;   // Foul-Linie liegt unter der Kopfpin-Linie und weit genug weg
}

// Liegt der angetippte Punkt (normiert) in der Bahn des Modells? (kleiner Rand erlaubt)
export function tapInLane(c, t, w, h) {
  const q = [c[0], c[1], c[3], c[2]].map(([u, v]) => [u * w, v * h]), p = [t[0] * w, t[1] * h];
  let sgn = 0, inside = true, dmin = Infinity;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4], ex = b[0] - a[0], ey = b[1] - a[1], L = Math.hypot(ex, ey) || 1;
    const z = (ex * (p[1] - a[1]) - ey * (p[0] - a[0])) / L;
    if (sgn && Math.sign(z) !== sgn) inside = false;
    sgn = sgn || Math.sign(z);
    const s = Math.max(0, Math.min(1, ((p[0] - a[0]) * ex + (p[1] - a[1]) * ey) / (L * L)));
    dmin = Math.min(dmin, Math.hypot(p[0] - a[0] - s * ex, p[1] - a[1] - s * ey));
  }
  return inside || dmin < 0.04 * Math.max(w, h);
}

// Bahn mit dem Modell finden, dann auf die Kanten einrasten; ohne gültiges Ergebnis nur { ml }.
// Ohne Antippen streng (IoU ≥ 0,35 und alle Ecken sicher ≥ 0,6: an Testbildern 1 von 20 Fehlgriffen statt 3),
// mit Antippen genügt weniger, wenn der Tipp in der gefundenen Bahn liegt (der Nutzer bestätigt das Modell).
export async function mlCorners(frame, a) {
  try { const u = new URL('./lanenet.bin', import.meta.url); u.search = new URL(import.meta.url).search; await loadLaneNet(u.href); } catch { return null; }
  const r = runLaneNet(frame);
  if (r.corners.some(c => !c) || r.area < 0.002 || !plausible(r.corners, frame.width, frame.height)) return { ml: r };
  const sure = r.iou >= 0.35 && Math.min(...r.conf) >= 0.6;
  const confirmed = a.target && r.iou >= 0.15 && tapInLane(r.corners, a.target, frame.width, frame.height);
  if (a.target ? !confirmed : !sure) return { ml: r };
  const { width: w, height: h } = frame;
  let c = r.corners;
  const yTop = a.yTop || 18.288;
  if (Math.abs(yTop - 18.288) > 0.01) {   // andere obere Linie (z. B. Grubenkante): über die Bahn-Homografie verschieben
    const H = homography([[0, 0], [1, 0], [0, 18.288], [1, 18.288]], c);
    if (H) c = [c[0], c[1], apply(H, 0, yTop), apply(H, 1, yTop)];
  }
  const sn = snapNormalized(toGray(frame.data, w, h), w, h, c, yTop);
  return { corners: sn.corners || c, ml: r, snapped: !!sn.corners };
}

export function autoCorners(frame, a) {
  const { width: w, height: h } = frame;
  const r = autoLane(frame, a.target ? { target: [a.target[0] * w - 0.5, a.target[1] * h - 0.5] } : {});
  if (!r.corners) return { error: r.error || 'fail' };
  const sn = snapCorners(toGray(frame.data, w, h), w, h, r.corners, a.yTop || 18.288);
  const c = (sn ? sn.corners : r.corners).map(([x, y]) => [(x + 0.5) / w, (y + 0.5) / h]);
  return { corners: c };
}

// Ein Aufruf für beide Wege
export async function findCorners(frame, a) {
  const ml = a.ml !== false ? await mlCorners(frame, a) : null;
  // Modell unsicher und kein Tipp: nicht blind raten (alte Kantensuche ohne Tipp lag oft daneben) -> Bahn antippen lassen
  const fallback = ml && !ml.corners && !a.target ? { error: 'pick' } : null;
  const res = { type: 'auto', ...(ml?.corners ? ml : fallback || autoCorners(frame, a)) };
  if (ml && !ml.corners) res.mlFail = true;
  else if (ml?.corners) res.ordered = true;   // Modell liefert FoulL, FoulR, KopfL, KopfR schon richtig
  return res;
}
