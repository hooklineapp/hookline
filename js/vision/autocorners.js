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

// Bahn mit dem Modell finden (ohne Antippen), dann auf die Kanten einrasten; null, wenn unsicher
export async function mlCorners(frame, a) {
  try { const u = new URL('./lanenet.bin', import.meta.url); u.search = new URL(import.meta.url).search; await loadLaneNet(u.href); } catch { return null; }
  const r = runLaneNet(frame);
  if (r.corners.some(c => !c) || r.area < 0.002 || r.iou < 0.3 || !plausible(r.corners, frame.width, frame.height)) return { ml: r };
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
  const ml = !a.target && a.ml !== false ? await mlCorners(frame, a) : null;
  const res = { type: 'auto', ...(ml?.corners ? ml : autoCorners(frame, a)) };
  if (ml && !ml.corners) res.mlFail = true;
  else if (ml?.corners) res.ordered = true;   // Modell liefert FoulL, FoulR, KopfL, KopfR schon richtig
  return res;
}
