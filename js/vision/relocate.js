// Gespeicherte Bahn wiederfinden: Ecken aus einem Referenzbild (Bahn-Profil) ins aktuelle Kamerabild übertragen.
// Gleiches Verfahren wie das Mitführen im Betrieb (Shi-Tomasi + pyramidaler Lucas-Kanade + RANSAC-Homografie),
// nur mit größerem Suchbereich, weil das Handy nach einem Bahnwechsel nur ungefähr wieder gleich steht.
import { toGray, buildPyramid, detectFeatures, makeTemplates, trackLK, coarseShift } from './lk.js';
import { ransacHomography, homography, apply } from './geometry.js';

export const RW = 320;   // Arbeitsbreite (Referenzbild und Vergleich)

// Graubild in Arbeitsbreite aus Video, Bild, ImageBitmap oder Canvas
export function grayOf(src, sw, sh) {
  const w = RW, h = Math.max(16, Math.round(RW * sh / sw));
  const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const cx = cv.getContext('2d', { willReadFrequently: true });
  cx.drawImage(src, 0, 0, w, h);
  return { w, h, d: toGray(cx.getImageData(0, 0, w, h).data, w, h) };
}

// eigener Zufall: der gemeinsame Zufall der Auswertung (Wiederholbarkeit bei Videos) bleibt unberührt
function lcg(seed = 4242) { let s = seed; return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; }; }

function convex(q) {
  const p = [q[0], q[1], q[3], q[2]];
  let s = 0;
  for (let i = 0; i < 4; i++) {
    const a = p[i], b = p[(i + 1) % 4], c = p[(i + 2) % 4];
    const z = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (!z || (s && Math.sign(z) !== s)) return false;
    s = Math.sign(z);
  }
  return true;
}
const area = (q) => { const p = [q[0], q[1], q[3], q[2]]; let a = 0; for (let i = 0; i < 4; i++) { const u = p[i], v = p[(i + 1) % 4]; a += u[0] * v[1] - v[0] * u[1]; } return Math.abs(a) / 2; };

// A: Referenz {w,h,d}, B: aktuelles Bild {w,h,d} (gleiche Breite), corners: normiert in A (FoulL, FoulR, KopfL, KopfR).
// Rückgabe { ok, corners (normiert in B), q (Anteil passender Merkmale), n, why }
export function relocate(A, B, corners) {
  if (!A || !B || A.w !== B.w || Math.abs(A.h - B.h) > 2) return { ok: false, why: 'format' };
  const { w, h } = A;
  const LV = 5, R = 6;
  const pa = buildPyramid(A.d, w, h, LV), pb = buildPyramid(B.d, w, h, LV);
  const pts = detectFeatures(pa[0], 320);
  if (pts.length < 30) return { ok: false, why: 'merkmale', n: pts.length };
  const tpls = makeTemplates(pa, pts, R);
  // Merkmale auf der Bahnebene (Bahn, Nachbarbahnen, Anlauf): dort stimmt eine Homografie exakt
  const cpx = corners.map(([x, y]) => [x * w - 0.5, y * h - 0.5]);
  const Hu = homography(cpx, [[0, 0], [1, 0], [0, 1], [1, 1]]);
  const plane = pts.map(([x, y]) => { if (!Hu) return 0; const [u, v] = apply(Hu, x, y); return u > -2 && u < 3 && v > -0.4 && v < 1.02 ? 1 : 0; });
  const rnd = lcg();
  const fit = (pred, thr) => {
    const res = trackLK(pb, tpls, pred, R, 12, 26);
    const s = [], d = [], pl = [];
    res.forEach((r, i) => { if (r) { s.push(pts[i]); d.push([r[0], r[1]]); pl.push(plane[i]); } });
    const F = s.length >= 12 ? ransacHomography(s, d, thr, 300, rnd) : null;
    if (!F) return null;
    // Feinschritt nur mit Inliern auf der Bahnebene (keine Parallaxe von Decke/Wänden)
    const ps = [], pd = [];
    s.forEach((p, i) => { if (F.inliers[i] && pl[i]) { ps.push(p); pd.push(d[i]); } });
    let H = F.H, planeN = ps.length;
    if (ps.length >= 12) { const G = ransacHomography(ps, pd, thr * 0.75, 150, rnd); if (G && G.count >= 10) { H = G.H; planeN = G.count; } }
    return { H, count: F.count, plane: planeN };
  };
  let best = null;
  const starts = [[0, 0], coarseShift(pb, tpls, pts, 8)];
  for (const [sx, sy] of starts) {
    let F = fit(pts.map(([x, y]) => [x + sx, y + sy]), 3.5);
    if (!F) continue;
    // zweiter Durchgang ab der gefundenen Lage: auch Merkmale weiter außen finden zurück (Drehung, Zoom)
    const F2 = fit(pts.map(([x, y]) => apply(F.H, x, y)), 2.0);
    if (F2 && F2.count >= F.count * 0.8) F = F2;
    if (!best || F.count > best.count) best = F;
  }
  if (!best) return { ok: false, why: 'kein Treffer', n: pts.length };
  const q = best.count / pts.length;
  const out = cpx.map(([x, y]) => apply(best.H, x, y));
  const inside = out.every(([x, y]) => x > -0.25 * w && x < 1.25 * w && y > -0.25 * h && y < 1.25 * h);
  const ar = area(out) / Math.max(1, area(cpx));
  const ok = best.count >= Math.max(24, pts.length * 0.18) && best.plane >= 8 && inside && convex(out) && ar > 0.4 && ar < 2.5;
  return { ok, q, n: pts.length, count: best.count, plane: best.plane, corners: out.map(([x, y]) => [(x + 0.5) / w, (y + 0.5) / h]), why: ok ? '' : 'unsicher' };
}
