// Automatische Bahnerkennung aus einem Bild:
// 1) Kanten + Hough-Linien  2) Fluchtpunkt der Bahnlinien  3) Kantenprofil der Strahlen vom Fluchtpunkt
// 4) breiteste Lücke zwischen Kanten = Bahn (Rinnen sind ~4,5x schmaler)  5) Foul-Linie = Ende der Rinnenkante
// 6) Kopfpin = unterer Rand der weißen Pins. Ergebnis: 4 Ecken (Engine-Pixel) oder null.

function sobel(g, w, h) {
  const mag = new Float32Array(w * h), gx = new Float32Array(w * h), gy = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const a = g[i - w - 1], b = g[i - w], c = g[i - w + 1], d = g[i - 1], f = g[i + 1], p = g[i + w - 1], q = g[i + w], r = g[i + w + 1];
    const sx = (c + 2 * f + r) - (a + 2 * d + p), sy = (p + 2 * q + r) - (a + 2 * b + c);
    gx[i] = sx; gy[i] = sy; mag[i] = Math.hypot(sx, sy);
  }
  return { mag, gx, gy };
}

function houghLines(E, w, h, maxLines) {
  const { mag, gx, gy } = E;
  // Schwelle: oberste 7 % der Gradienten
  const sample = []; for (let i = 0; i < mag.length; i += 7) if (mag[i] > 0) sample.push(mag[i]);
  sample.sort((a, b) => a - b);
  const thr = Math.max(40, sample[Math.floor(sample.length * 0.93)] || 60);
  const nT = 180, diag = Math.ceil(Math.hypot(w, h)), nR = 2 * diag + 1;
  const acc = new Float32Array(nT * nR);
  const cs = new Float32Array(nT), sn = new Float32Array(nT);
  for (let t = 0; t < nT; t++) { cs[t] = Math.cos(t * Math.PI / nT); sn[t] = Math.sin(t * Math.PI / nT); }
  for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) {
    const i = y * w + x;
    if (mag[i] < thr) continue;
    // Gradientenrichtung = Normale der Linie; nur ±6° um sie herum abstimmen
    let th = Math.atan2(gy[i], gx[i]); if (th < 0) th += Math.PI; if (th >= Math.PI) th -= Math.PI;
    const t0 = Math.round(th * nT / Math.PI);
    for (let dt = -6; dt <= 6; dt++) {
      const t = (t0 + dt + nT) % nT;
      const r = Math.round(x * cs[t] + y * sn[t]) + diag;
      acc[t * nR + r] += 1;
    }
  }
  const lines = [];
  const used = new Uint8Array(nT * nR);
  for (let k = 0; k < maxLines; k++) {
    let best = 0, bi = -1;
    for (let i = 0; i < acc.length; i++) if (!used[i] && acc[i] > best) { best = acc[i]; bi = i; }
    if (bi < 0 || best < Math.min(w, h) * 0.12) break;
    const t = Math.floor(bi / nR), r = bi % nR - diag;
    // nahezu waagrechte Linien (Normale fast senkrecht) auslassen
    const lineAngle = Math.abs(90 - Math.abs(t - 90)); // 0 = senkrechte Normale -> waagrechte Linie
    for (let dt = -4; dt <= 4; dt++) for (let dr = -8; dr <= 8; dr++) {
      const tt = (t + dt + nT) % nT, rr = r + diag + dr; if (rr >= 0 && rr < nR) used[tt * nR + rr] = 1;
    }
    if (lineAngle > 80) continue;
    lines.push({ c: cs[t], s: sn[t], r, votes: best });
  }
  return lines;
}

function vanishingPoint(lines, w, h) {
  let best = null;
  for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) {
    const A = lines[i], B = lines[j];
    const d = A.c * B.s - A.s * B.c; if (Math.abs(d) < 0.05) continue;
    const x = (A.r * B.s - A.s * B.r) / d, y = (A.c * B.r - A.r * B.c) / d;
    if (y > h * 0.8 || y < -h * 1.5 || x < -w || x > 2 * w) continue;
    let score = 0;
    for (const L of lines) {
      const dist = Math.abs(L.c * x + L.s * y - L.r);
      if (dist < 2.5 + 0.004 * Math.hypot(x - w / 2, y - h / 2)) score += L.votes;
    }
    if (!best || score > best.score) best = { x, y, score };
  }
  return best;
}

// Kantenstärke quer zum Strahl vom Fluchtpunkt zu (x, yRef), über den Abschnitt f0..f1 des Strahls
function rayEdge(E, w, h, vp, x, yRef, f0, f1) {
  const dx = x - vp.x, dy = yRef - vp.y, len = Math.hypot(dx, dy);
  const nx = -dy / len, ny = dx / len;
  let s = 0, n = 0;
  const steps = 60;
  for (let k = 0; k <= steps; k++) {
    const f = f0 + (f1 - f0) * k / steps;
    const px = Math.round(vp.x + dx * f), py = Math.round(vp.y + dy * f);
    if (px < 1 || py < 1 || px >= w - 1 || py >= h - 1) continue;
    const i = py * w + px;
    s += Math.abs(E.gx[i] * nx + E.gy[i] * ny); n++;
  }
  return n > 10 ? s / n : 0;
}

export function autoLane(frame, opt = {}) {
  const { width: w, height: h, data } = frame;
  const g = new Float32Array(w * h), sat = new Float32Array(w * h);
  for (let i = 0, j = 0; i < w * h; i++, j += 4) {
    const r = data[j], gg = data[j + 1], b = data[j + 2];
    g[i] = 0.299 * r + 0.587 * gg + 0.114 * b;
    sat[i] = Math.max(r, gg, b) - Math.min(r, gg, b);
  }
  const E = sobel(g, w, h);
  const lines = houghLines(E, w, h, 40);
  if (lines.length < 3) return { error: 'lines' };
  const vp = vanishingPoint(lines, w, h);
  if (!vp) return { error: 'vp' };
  // Referenzzeile: weit unten, aber über dem unteren Rand
  const yRef = Math.min(h - 3, vp.y + (h - vp.y) * 0.92);
  const xs = [], prof = [];
  for (let x = -w * 0.5; x <= w * 1.5; x += 1) { xs.push(x); prof.push(rayEdge(E, w, h, vp, x, yRef, 0.25, 0.75)); }
  // lokale Maxima mit Mindestabstand
  const mx = Math.max(...prof);
  const peaks = [];
  for (let i = 2; i < prof.length - 2; i++) {
    if (prof[i] < mx * 0.18) continue;
    if (prof[i] >= prof[i - 1] && prof[i] >= prof[i + 1] && prof[i] >= prof[i - 2] && prof[i] >= prof[i + 2]) {
      if (peaks.length && xs[i] - peaks[peaks.length - 1].x < 3) { if (prof[i] > peaks[peaks.length - 1].v) peaks[peaks.length - 1] = { x: xs[i], v: prof[i] }; }
      else peaks.push({ x: xs[i], v: prof[i] });
    }
  }
  if (peaks.length < 2) return { error: 'peaks' };
  // Bahnkandidaten: Lücke zwischen zwei Kanten; Bewertung: Breite, Kantenstärke, Nähe zum Wunschpunkt
  const target = opt.target ? opt.target[0] + (opt.target[0] - vp.x) * ((yRef - opt.target[1]) / Math.max(1, opt.target[1] - vp.y)) : w / 2;
  const gaps = [];
  for (let i = 0; i + 1 < peaks.length; i++) gaps.push({ a: peaks[i], b: peaks[i + 1], wd: peaks[i + 1].x - peaks[i].x });
  const maxW = Math.max(...gaps.map(g => g.wd));
  let best = null;
  for (const G of gaps) {
    if (G.wd < maxW * 0.55) continue; // Rinnen/Abdeckungen sind deutlich schmaler
    const mid = (G.a.x + G.b.x) / 2;
    const contains = target >= G.a.x && target <= G.b.x;
    // mit Wunschpunkt: dessen Bahn; ohne: die nächstgelegene (breiteste) Bahn nahe der Bildmitte
    const sc = opt.target ? (contains ? 2 : 0) - Math.abs(mid - target) / w + G.wd / maxW + (G.a.v + G.b.v) / (2 * mx)
      : (contains ? 0.4 : 0) - 0.6 * Math.abs(mid - target) / w + 1.6 * G.wd / maxW + (G.a.v + G.b.v) / (2 * mx);
    if (!best || sc > best.sc) best = { ...G, sc };
  }
  if (!best) return { error: 'lane' };
  const rayPt = (x, f) => [vp.x + (x - vp.x) * f, vp.y + (yRef - vp.y) * f];
  // Foul-Linie: von unten nach oben die Stelle suchen, ab der die Kante durchgehend vorhanden ist
  const foulF = (x) => {
    const dx = x - vp.x, dy = yRef - vp.y, len = Math.hypot(dx, dy), nx = -dy / len, ny = dx / len;
    const vals = [];
    for (let k = 0; k <= 200; k++) {
      const f = 0.15 + 0.85 * k / 200 * (1 / 0.92);
      const px = Math.round(vp.x + dx * f), py = Math.round(vp.y + dy * f);
      if (px < 1 || py < 1 || px >= w - 1 || py >= h - 1) { vals.push(null); continue; }
      let m = 0; for (let o = -1; o <= 1; o++) { const i = py * w + Math.min(w - 2, Math.max(1, px + o)); m = Math.max(m, Math.abs(E.gx[i] * nx + E.gy[i] * ny)); }
      vals.push({ f, m });
    }
    const ok = vals.filter(Boolean);
    const ref = ok.slice(0, Math.floor(ok.length * 0.5)).map(v => v.m).sort((a, b) => a - b);
    const lvl = ref[Math.floor(ref.length * 0.5)] || 1;
    // letzte Stelle (von oben), nach der die Kante für ein längeres Stück unter 30 % fällt
    let lastF = ok.length ? ok[ok.length - 1].f : 1;
    for (let k = Math.floor(ok.length * 0.3); k < ok.length - 6; k++) {
      let weak = 0; for (let q = 0; q < 6; q++) if (ok[k + q].m < lvl * 0.3) weak++;
      if (weak >= 5) { lastF = ok[k].f; break; }
    }
    return lastF;
  };
  const fA = foulF(best.a.x), fB = foulF(best.b.x);
  let FL = rayPt(best.a.x, fA), FR = rayPt(best.b.x, fB);
  // beide Seiten sollten etwa in einer Linie liegen; sonst die plausiblere (weiter unten) übernehmen
  if (Math.abs(FL[1] - FR[1]) > (h - vp.y) * 0.12) {
    const y = Math.max(FL[1], FR[1]);
    FL = rayPt(best.a.x, (y - vp.y) / (yRef - vp.y)); FR = rayPt(best.b.x, (y - vp.y) / (yRef - vp.y));
  }
  // Kopfpin: unterster Rand weißer Pixel im Keil nahe dem Fluchtpunkt
  const lumSorted = []; for (let i = 0; i < g.length; i += 13) lumSorted.push(g[i]); lumSorted.sort((a, b) => a - b);
  const white = lumSorted[Math.floor(lumSorted.length * 0.9)];
  let headY = null;
  const yTop = Math.max(0, Math.floor(vp.y + 1)), yBot = Math.floor(Math.min(FL[1], FR[1]));
  for (let y = yTop; y < yTop + (yBot - yTop) * 0.45; y++) {
    const f = (y - vp.y) / (yRef - vp.y);
    const xa = vp.x + (best.a.x - vp.x) * f, xb = vp.x + (best.b.x - vp.x) * f;
    const c0 = Math.round(xa + (xb - xa) * 0.15), c1 = Math.round(xb - (xb - xa) * 0.15);
    let cnt = 0, n = 0;
    for (let x = Math.max(0, c0); x <= Math.min(w - 1, c1); x++) { n++; const i = y * w + x; if (g[i] >= white * 0.92 && sat[i] < 60) cnt++; }
    if (n >= 2 && cnt / n > 0.12) headY = y;
  }
  if (headY == null) return { error: 'pins' };
  // Pinfuß liegt ~ eine halbe Pin-Breite unter der untersten weißen Zeile (Schatten/Unschärfe)
  headY += 0.5;
  const fh = (headY - vp.y) / (yRef - vp.y);
  const HL = rayPt(best.a.x, fh), HR = rayPt(best.b.x, fh);
  // Plausibilität: Bahn von Foul-Linie bis Kopfpin muss nach oben schmaler werden, Foul unter Kopfpin
  if (!(FL[1] > HL[1] + 3 && FR[1] > HR[1] + 3)) return { error: 'geometry' };
  const nearW = Math.hypot(FR[0] - FL[0], FR[1] - FL[1]), farW = Math.hypot(HR[0] - HL[0], HR[1] - HL[1]);
  if (nearW < w * 0.06 || farW >= nearW || farW < 2) return { error: 'geometry' };
  return { corners: [FL, FR, HL, HR], vp, lines: lines.length, score: best.sc };
}
