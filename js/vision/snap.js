// Ecken einrasten: Bahnkanten (Holz hell / Rinne dunkel) und Foul-Linie im Bild suchen und die
// getippten Ecken auf die Schnittpunkte der gefundenen Linien setzen.
import { homography, apply } from './geometry.js';
import { LANE_W, HEADPIN_Y } from '../lane.js';

function bil(d, w, h, x, y) {
  if (x < 0 || y < 0 || x > w - 1.001 || y > h - 1.001) return NaN;
  const xi = x | 0, yi = y | 0, fx = x - xi, fy = y - yi, i = yi * w + xi;
  return d[i] + (d[i + 1] - d[i]) * fx + (d[i + w] - d[i]) * fy + (d[i] - d[i + 1] - d[i + w] + d[i + w + 1]) * fx * fy;
}

// Linie a*x + b*y = c (a²+b²=1) robust durch Punkte (iteratives Kürzen der Ausreißer)
function fitLine(pts) {
  let use = pts.slice();
  let L = null;
  for (let it = 0; it < 4 && use.length >= 4; it++) {
    let mx = 0, my = 0; for (const [x, y] of use) { mx += x; my += y; } mx /= use.length; my /= use.length;
    let sxx = 0, syy = 0, sxy = 0; for (const [x, y] of use) { sxx += (x - mx) ** 2; syy += (y - my) ** 2; sxy += (x - mx) * (y - my); }
    const th = 0.5 * Math.atan2(2 * sxy, sxx - syy); // Richtung der Linie
    const a = -Math.sin(th), b = Math.cos(th);
    L = { a, b, c: a * mx + b * my };
    const res = use.map(([x, y]) => Math.abs(a * x + b * y - L.c));
    const sorted = [...res].sort((p, q) => p - q);
    const lim = Math.max(0.6, 2.5 * sorted[Math.floor(sorted.length * 0.5)]);
    const keep = use.filter((_, i) => res[i] <= lim);
    if (keep.length === use.length) break;
    use = keep;
  }
  if (L) { L.n = use.length; L.rms = Math.sqrt(use.reduce((s, [x, y]) => s + (L.a * x + L.b * y - L.c) ** 2, 0) / use.length); }
  return L;
}
function intersect(L1, L2) {
  const d = L1.a * L2.b - L1.b * L2.a;
  if (Math.abs(d) < 1e-9) return null;
  return [(L1.c * L2.b - L1.b * L2.c) / d, (L1.a * L2.c - L1.c * L2.a) / d];
}
function lineThrough(p, q) {
  const dx = q[0] - p[0], dy = q[1] - p[1], n = Math.hypot(dx, dy) || 1;
  const a = -dy / n, b = dx / n;
  return { a, b, c: a * p[0] + b * p[1] };
}

// gray: Float32 Graubild, img: Ecken in Pixeln [FL, FR, OL, OR], yTop: Y der oberen Ecken.
// Rückgabe: {corners:[...]} oder null, wenn die Kanten nicht sicher gefunden wurden.
export function snapCorners(gray, w, h, img, yTop, opt = {}) {
  const H = homography([[0, 0], [LANE_W, 0], [0, yTop], [LANE_W, yTop]], img);
  if (!H) return null;
  const searchM = opt.searchM ?? 0.08; // Suchbreite quer in Metern
  const sides = [];
  for (const X of [0, LANE_W]) {
    const out = X === 0 ? -1 : 1; // nach außen = Richtung Rinne
    const pts = [];
    for (let k = 0; k <= 48; k++) {
      const Y = 0.4 + (HEADPIN_Y - 1.2) * k / 48;
      const p = apply(H, X, Y), q = apply(H, X + out * searchM, Y);
      let dx = q[0] - p[0], dy = q[1] - p[1];
      const len = Math.hypot(dx, dy);
      if (!isFinite(len) || len < 0.7) continue;
      const r = Math.max(2, len); dx /= len; dy /= len;
      // Profil entlang der Normalen, Schritt 0,25 px
      let best = 0, bt = 0;
      const prof = [];
      for (let t = -r; t <= r; t += 0.25) prof.push([t, bil(gray, w, h, p[0] + dx * t, p[1] + dy * t)]);
      for (let i = 2; i < prof.length - 2; i++) {
        const g = prof[i - 2][1] - prof[i + 2][1]; // innen hell -> außen dunkel = positiv
        if (g > best) { best = g; bt = i; }
      }
      if (best < (opt.minContrast ?? 12) || bt < 3 || bt > prof.length - 4) continue;
      // Subpixel: Parabel durch die Gradienten um das Maximum
      const gAt = (i) => prof[i - 2][1] - prof[i + 2][1];
      const g0 = gAt(bt - 1), g1 = gAt(bt), g2 = gAt(bt + 1);
      const den = g0 - 2 * g1 + g2;
      const off = Math.abs(den) > 1e-6 ? 0.5 * (g0 - g2) / den : 0;
      const t = prof[bt][0] + Math.max(-1, Math.min(1, off)) * 0.25;
      pts.push([p[0] + dx * t, p[1] + dy * t]);
    }
    if (pts.length < 12) return null;
    const L = fitLine(pts);
    if (!L || L.n < 10 || L.rms > 1.2) return null;
    sides.push(L);
  }
  // Foul-Linie: dunkler Streifen; Suche längs der Bahn
  let foul = lineThrough(img[0], img[1]);
  const fp = [];
  for (let k = 1; k < 20; k++) {
    const X = LANE_W * k / 20;
    const p = apply(H, X, 0), q = apply(H, X, opt.foulM ?? 0.15);
    let dx = q[0] - p[0], dy = q[1] - p[1]; const len = Math.hypot(dx, dy);
    if (len < 1) continue; dx /= len; dy /= len;
    const r = Math.max(2, len);
    let lo = Infinity, lt = 0, sum = 0, n = 0;
    for (let t = -r; t <= r; t += 0.25) {
      const v = bil(gray, w, h, p[0] + dx * t, p[1] + dy * t);
      if (isNaN(v)) continue; sum += v; n++;
      if (v < lo) { lo = v; lt = t; }
    }
    if (n && sum / n - lo > (opt.minContrast ?? 12) * 1.5) fp.push([p[0] + dx * lt, p[1] + dy * lt]);
  }
  if (fp.length >= 8) { const L = fitLine(fp); if (L && L.rms < 1.0 && L.n >= 6) foul = L; }
  const top = lineThrough(img[2], img[3]);
  const c = [intersect(sides[0], foul), intersect(sides[1], foul), intersect(sides[0], top), intersect(sides[1], top)];
  if (c.some(p => !p)) return null;
  const maxMove = opt.maxMove ?? Math.max(6, 0.025 * w);
  if (c.some((p, i) => Math.hypot(p[0] - img[i][0], p[1] - img[i][1]) > maxMove)) return null;
  return { corners: c, rms: [sides[0].rms, sides[1].rms] };
}

// Grob gesetzte Ecken (normalisiert, Reihenfolge FoulL, FoulR, ObenL, ObenR) auf die Bahnkanten ziehen.
// Zwei Durchgänge, damit auch etwas weiter daneben gesetzte Punkte gefunden werden. Ergebnis normalisiert.
export function snapNormalized(gray, w, h, corners, yTop) {
  let img = corners.map(([x, y]) => [x * w - 0.5, y * h - 0.5]);
  let ok = false;
  for (let pass = 0; pass < 3; pass++) {
    // erst breit suchen (grob gesetzt), dann eng verfeinern
    const r = snapCorners(gray, w, h, img, yTop, { maxMove: Math.max(10, 0.06 * w), searchM: pass === 0 ? 0.2 : 0.08, foulM: pass === 0 ? 0.5 : 0.15 });
    if (!r) { if (pass === 0) continue; break; }
    const moved = Math.max(...r.corners.map((p, i) => Math.hypot(p[0] - img[i][0], p[1] - img[i][1])));
    img = r.corners; ok = true;
    if (moved < 0.5) break;
  }
  if (!ok) return { error: 'nosnap' };
  return { corners: img.map(([x, y]) => [(x + 0.5) / w, (y + 0.5) / h]) };
}
