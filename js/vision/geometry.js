// Homografie, RANSAC, Kameramodell. Matrizen als Float64Array(9) zeilenweise.

export function solve(A, b) {           // Gauss mit Pivot, A: n*n (Array von Arrays), b: n
  const n = b.length;
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      if (f) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

function normT(pts) {
  let mx = 0, my = 0;
  for (const p of pts) { mx += p[0]; my += p[1]; }
  mx /= pts.length; my /= pts.length;
  let d = 0;
  for (const p of pts) d += Math.hypot(p[0] - mx, p[1] - my);
  d = d / pts.length || 1;
  const s = Math.SQRT2 / d;
  return [s, mx, my];
}

// Homografie src->dst aus >=4 Punktpaaren (normalisierte DLT, h33=1, kleinste Quadrate)
export function homography(src, dst) {
  const n = src.length;
  if (n < 4) return null;
  const [ss, sx, sy] = normT(src), [ds, dx, dy] = normT(dst);
  const AtA = Array.from({ length: 8 }, () => new Array(8).fill(0));
  const Atb = new Array(8).fill(0);
  const row = new Array(8);
  for (let i = 0; i < n; i++) {
    const x = (src[i][0] - sx) * ss, y = (src[i][1] - sy) * ss;
    const u = (dst[i][0] - dx) * ds, v = (dst[i][1] - dy) * ds;
    for (let pass = 0; pass < 2; pass++) {
      let rhs;
      if (pass === 0) { row[0] = x; row[1] = y; row[2] = 1; row[3] = 0; row[4] = 0; row[5] = 0; row[6] = -u * x; row[7] = -u * y; rhs = u; }
      else { row[0] = 0; row[1] = 0; row[2] = 0; row[3] = x; row[4] = y; row[5] = 1; row[6] = -v * x; row[7] = -v * y; rhs = v; }
      for (let a = 0; a < 8; a++) {
        const ra = row[a];
        if (!ra) continue;
        Atb[a] += ra * rhs;
        for (let b = 0; b < 8; b++) AtA[a][b] += ra * row[b];
      }
    }
  }
  const h = solve(AtA, Atb);
  if (!h) return null;
  const Hn = [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
  // H = Td^-1 * Hn * Ts
  const Ts = [ss, 0, -ss * sx, 0, ss, -ss * sy, 0, 0, 1];
  const Tdi = [1 / ds, 0, dx, 0, 1 / ds, dy, 0, 0, 1];
  const H = mul(Tdi, mul(Hn, Ts));
  return scale1(H);
}

export function scale1(H) {
  const s = H[8] || 1;
  const o = new Float64Array(9);
  for (let i = 0; i < 9; i++) o[i] = H[i] / s;
  return o;
}

export function mul(A, B) {
  const C = new Float64Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++)
    C[i * 3 + j] = A[i * 3] * B[j] + A[i * 3 + 1] * B[3 + j] + A[i * 3 + 2] * B[6 + j];
  return C;
}

export function inv(M) {
  const [a, b, c, d, e, f, g, h, i] = M;
  const A = e * i - f * h, B = -(d * i - f * g), Cc = d * h - e * g;
  const det = a * A + b * B + c * Cc;
  if (Math.abs(det) < 1e-15) return null;
  const r = 1 / det;
  return new Float64Array([A * r, -(b * i - c * h) * r, (b * f - c * e) * r,
    B * r, (a * i - c * g) * r, -(a * f - c * d) * r,
    Cc * r, -(a * h - b * g) * r, (a * e - b * d) * r]);
}

export function apply(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

// RANSAC für Homografie. Gibt {H, inliers:Uint8Array, count}
// deterministischer Zufall (gleiches Video -> gleiches Ergebnis)
let _seed = 12345;
export function seededRandom() { _seed = (_seed * 16807) % 2147483647; return (_seed - 1) / 2147483646; }
export function resetRandom(s = 12345) { _seed = s; }
export function ransacHomography(src, dst, thresh = 2, iters = 120, rnd = seededRandom) {
  const n = src.length;
  if (n < 4) return null;
  let best = null, bestCount = 0, bestMask = null;
  const t2 = thresh * thresh;
  const mask = new Uint8Array(n);
  for (let it = 0; it < iters; it++) {
    const idx = new Set();
    while (idx.size < 4) idx.add((rnd() * n) | 0);
    const ids = [...idx];
    const H = homography(ids.map(i => src[i]), ids.map(i => dst[i]));
    if (!H) continue;
    let c = 0;
    for (let i = 0; i < n; i++) {
      const p = apply(H, src[i][0], src[i][1]);
      const dx = p[0] - dst[i][0], dy = p[1] - dst[i][1];
      mask[i] = dx * dx + dy * dy < t2 ? 1 : 0;
      c += mask[i];
    }
    if (c > bestCount) { bestCount = c; best = H; bestMask = mask.slice(); if (c > n * 0.9) break; }
  }
  if (!best || bestCount < 6) return null;
  // Verfeinern mit allen Inliern (zweimal)
  for (let k = 0; k < 2; k++) {
    const s = [], d = [];
    for (let i = 0; i < n; i++) if (bestMask[i]) { s.push(src[i]); d.push(dst[i]); }
    const H = homography(s, d);
    if (!H) break;
    best = H; bestCount = 0;
    for (let i = 0; i < n; i++) {
      const p = apply(H, src[i][0], src[i][1]);
      const dx = p[0] - dst[i][0], dy = p[1] - dst[i][1];
      bestMask[i] = dx * dx + dy * dy < t2 * 1.5 ? 1 : 0;
      bestCount += bestMask[i];
    }
  }
  return { H: best, inliers: bestMask, count: bestCount };
}

// Kamera aus Boden-Homografie (Bahn-Meter -> Bildpixel). Hauptpunkt = Bildmitte.
// Liefert {f, cx, cy, R:[r1,r2,r3], t, P(X,Y,Z)->[u,v], planeH(Z)}
export function cameraFromH(H, w, h, fGuess) {
  const cx = w / 2, cy = h / 2;
  // verschieben auf Hauptpunkt
  const T = new Float64Array([1, 0, -cx, 0, 1, -cy, 0, 0, 1]);
  const G = mul(T, H);
  const h11 = G[0], h12 = G[1], h21 = G[3], h22 = G[4], h31 = G[6], h32 = G[7];
  const cands = [];
  const d1 = h31 * h32;
  if (Math.abs(d1) > 1e-12) cands.push(-(h11 * h12 + h21 * h22) / d1);
  const d2 = h31 * h31 - h32 * h32;
  if (Math.abs(d2) > 1e-12) cands.push((h12 * h12 + h22 * h22 - h11 * h11 - h21 * h21) / d2);
  let f = 0;
  const ok = cands.filter(v => v > 0).map(Math.sqrt).filter(v => v > 0.3 * w && v < 6 * w);
  if (fGuess) f = fGuess;
  else if (ok.length) f = ok.reduce((a, b) => a + b, 0) / ok.length;
  else f = 0.8 * Math.max(w, h);
  const kc = (i) => [G[i] / f, G[3 + i] / f, G[6 + i]];
  let r1 = kc(0), r2 = kc(1), t = kc(2);
  const n1 = Math.hypot(...r1), n2 = Math.hypot(...r2);
  const lam = 2 / (n1 + n2);
  r1 = r1.map(v => v * lam); r2 = r2.map(v => v * lam); t = t.map(v => v * lam);
  let lamS = lam;
  if (t[2] < 0) { r1 = r1.map(v => -v); r2 = r2.map(v => -v); t = t.map(v => -v); lamS = -lam; }
  // r2 orthogonalisieren
  const d = r1[0] * r2[0] + r1[1] * r2[1] + r1[2] * r2[2];
  r2 = r2.map((v, i) => v - d * r1[i]);
  const nn = Math.hypot(...r2); r2 = r2.map(v => v / nn);
  let r3 = [r1[1] * r2[2] - r1[2] * r2[1], r1[2] * r2[0] - r1[0] * r2[2], r1[0] * r2[1] - r1[1] * r2[0]];
  // Z nach oben: Kamera muss über der Ebene liegen. Kamerazentrum C = -R^T t; C·z > 0
  const Cz = -(r3[0] * t[0] + r3[1] * t[1] + r3[2] * t[2]);
  if (Cz < 0) r3 = r3.map(v => -v);
  // Projektion konsistent zur gemessenen Homografie: Z=0 ist exakt H, die Höhe kommt als kleine Korrektur dazu
  // (H = 1/lam · M·[r1 r2 t], M = Kamera-Matrix mit Hauptpunkt). So verfälschen kleine Eckfehler die Höhe nicht.
  const m3 = [f * r3[0] + cx * r3[2], f * r3[1] + cy * r3[2], r3[2]].map(v => v / lamS);
  const P = (X, Y, Z) => {
    const x = H[0] * X + H[1] * Y + H[2] + Z * m3[0];
    const y = H[3] * X + H[4] * Y + H[5] + Z * m3[1];
    const w = H[6] * X + H[7] * Y + H[8] + Z * m3[2];
    // Tiefe (Meter) für Größenberechnungen aus dem metrischen Modell
    const z = r1[2] * X + r2[2] * Y + r3[2] * Z + t[2];
    return [x / w, y / w, z];
  };
  const planeH = (z0) => scale1(new Float64Array([H[0], H[1], H[2] + z0 * m3[0], H[3], H[4], H[5] + z0 * m3[1], H[6], H[7], H[8] + z0 * m3[2]]));
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const camPos = [-dot(r1, t), -dot(r2, t), -dot(r3, t)]; // C = -R^T t
  return { f, cx, cy, r1, r2, r3, t, P, planeH, camPos };
}
