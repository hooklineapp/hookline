// Eigene, schlanke Bildpyramide + Shi-Tomasi-Merkmale + pyramidaler Lucas-Kanade
// (inverse compositional, Vorlage = festes Referenzbild -> Gradienten nur einmal).

export function toGray(rgba, w, h, out) {
  const n = w * h;
  const g = out && out.length === n ? out : new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) g[i] = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
  return g;
}

export function buildPyramid(gray, w, h, levels, prev) {
  const L = [{ w, h, d: gray }];
  for (let l = 1; l < levels; l++) {
    const p = L[l - 1];
    const nw = p.w >> 1, nh = p.h >> 1;
    if (nw < 16 || nh < 16) break;
    const old = prev && prev[l];
    const d = old && old.d.length === nw * nh ? old.d : new Float32Array(nw * nh);
    const s = p.d, pw = p.w;
    for (let y = 0; y < nh; y++) {
      const r0 = 2 * y * pw, r1 = r0 + pw;
      for (let x = 0; x < nw; x++) {
        const x2 = 2 * x;
        d[y * nw + x] = 0.25 * (s[r0 + x2] + s[r0 + x2 + 1] + s[r1 + x2] + s[r1 + x2 + 1]);
      }
    }
    L.push({ w: nw, h: nh, d });
  }
  return L;
}

function bil(d, w, h, x, y) {
  if (x < 0) x = 0; else if (x > w - 1.001) x = w - 1.001;
  if (y < 0) y = 0; else if (y > h - 1.001) y = h - 1.001;
  const xi = x | 0, yi = y | 0, fx = x - xi, fy = y - yi, i = yi * w + xi;
  const a = d[i], b = d[i + 1], c = d[i + w], e = d[i + w + 1];
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + e) * fx * fy;
}

// Shi-Tomasi: bestes Merkmal je Rasterzelle. mask(x,y)->bool optional
export function detectFeatures(lv, maxN, mask, border = 8) {
  const { w, h, d } = lv;
  const cell = Math.max(8, Math.round(Math.sqrt((w * h) / (maxN * 1.6))));
  const cand = [];
  let maxQ = 0;
  for (let cy = border; cy < h - border; cy += cell) {
    for (let cx = border; cx < w - border; cx += cell) {
      let best = 0, bx = 0, by = 0;
      const ey = Math.min(cy + cell, h - border), ex = Math.min(cx + cell, w - border);
      for (let y = cy; y < ey; y += 2) {
        for (let x = cx; x < ex; x += 2) {
          if (mask && !mask(x, y)) continue;
          let sxx = 0, syy = 0, sxy = 0;
          for (let v = -2; v <= 2; v++) {
            const r = (y + v) * w;
            for (let u = -2; u <= 2; u++) {
              const i = r + x + u;
              const gx = d[i + 1] - d[i - 1], gy = d[i + w] - d[i - w];
              sxx += gx * gx; syy += gy * gy; sxy += gx * gy;
            }
          }
          const tr = (sxx + syy) / 2, q = tr - Math.sqrt(Math.max(0, tr * tr - (sxx * syy - sxy * sxy)));
          if (q > best) { best = q; bx = x; by = y; }
        }
      }
      if (best > 0) { cand.push([bx, by, best]); if (best > maxQ) maxQ = best; }
    }
  }
  cand.sort((a, b) => b[2] - a[2]);
  return cand.filter(c => c[2] > maxQ * 0.02 && c[2] > 200).slice(0, maxN).map(c => [c[0], c[1]]);
}

// Vorlagen eines Merkmals auf allen Ebenen vorbereiten
export function makeTemplates(pyr, pts, r) {
  const n = (2 * r + 1) ** 2;
  return pts.map(([x0, y0]) => {
    const lv = [];
    for (let l = 0; l < pyr.length; l++) {
      const { w, h, d } = pyr[l];
      const s = 1 / (1 << l), x = x0 * s, y = y0 * s;
      const T = new Float32Array(n), GX = new Float32Array(n), GY = new Float32Array(n);
      let k = 0, mean = 0;
      for (let v = -r; v <= r; v++) for (let u = -r; u <= r; u++) {
        T[k] = bil(d, w, h, x + u, y + v);
        GX[k] = 0.5 * (bil(d, w, h, x + u + 1, y + v) - bil(d, w, h, x + u - 1, y + v));
        GY[k] = 0.5 * (bil(d, w, h, x + u, y + v + 1) - bil(d, w, h, x + u, y + v - 1));
        mean += T[k]; k++;
      }
      mean /= n;
      let a = 0, b = 0, c = 0;
      for (let i = 0; i < n; i++) { T[i] -= mean; a += GX[i] * GX[i]; b += GX[i] * GY[i]; c += GY[i] * GY[i]; }
      const det = a * c - b * b;
      lv.push(det > 1e-6 ? { T, GX, GY, ia: c / det, ib: -b / det, ic: a / det } : null);
    }
    return lv;
  });
}

// Verfolgt Vorlagen im aktuellen Bild ab Vorhersage pred[i]=[x,y] (Ebene 0).
// Rückgabe: Array [x,y,err] oder null
export function trackLK(pyr, tpls, pred, r, iters = 8, maxErr = 18) {
  const out = new Array(tpls.length);
  const n = (2 * r + 1) ** 2;
  const S = new Float32Array(n);
  const top = pyr.length - 1;
  for (let i = 0; i < tpls.length; i++) {
    const tp = tpls[i];
    let gx = pred[i][0] / (1 << top), gy = pred[i][1] / (1 << top);
    let ok = true, err = 0;
    for (let l = top; l >= 0; l--) {
      const t = tp[l];
      const { w, h, d } = pyr[l];
      if (!t) { if (l > 0) { gx *= 2; gy *= 2; } continue; }
      for (let it = 0; it < iters; it++) {
        let k = 0, mean = 0;
        for (let v = -r; v <= r; v++) for (let u = -r; u <= r; u++) { S[k] = bil(d, w, h, gx + u, gy + v); mean += S[k]; k++; }
        mean /= n;
        let bx = 0, by = 0; err = 0;
        for (let j = 0; j < n; j++) { const e = S[j] - mean - t.T[j]; bx += e * t.GX[j]; by += e * t.GY[j]; err += Math.abs(e); }
        const dx = t.ia * bx + t.ib * by, dy = t.ib * bx + t.ic * by;
        gx -= dx; gy -= dy;
        if (dx * dx + dy * dy < 0.0009) break;
      }
      if (gx < 1 || gy < 1 || gx > w - 2 || gy > h - 2) { ok = false; break; }
      if (l > 0) { gx *= 2; gy *= 2; }
    }
    err /= n;
    out[i] = ok && err < maxErr ? [gx, gy, err] : null;
  }
  return out;
}

// Grobe globale Verschiebungssuche auf der obersten Ebene (Wiederfinden nach Verlust)
export function coarseShift(pyr, tpls, pred, radius) {
  const top = pyr.length - 1;
  const { w, h, d } = pyr[top];
  const s = 1 / (1 << top);
  let best = Infinity, bdx = 0, bdy = 0;
  for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
    let sum = 0, cnt = 0;
    for (let i = 0; i < tpls.length; i++) {
      const t = tpls[i][top]; if (!t) continue;
      const x = pred[i][0] * s + dx, y = pred[i][1] * s + dy;
      if (x < 2 || y < 2 || x > w - 3 || y > h - 3) continue;
      // 3x3 Zentrum der Vorlage vergleichen (mittelwertfrei)
      const r = Math.sqrt(t.T.length) | 0, c = (r >> 1);
      let m = 0; const v = [];
      for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) { const q = bil(d, w, h, x + a, y + b); v.push(q); m += q; }
      m /= 9; let k = 0;
      for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) { sum += Math.abs(v[k++] - m - t.T[(c + b) * r + c + a]); }
      cnt++;
    }
    if (cnt > 5) { const sc = sum / cnt; if (sc < best) { best = sc; bdx = dx; bdy = dy; } }
  }
  return [bdx / s, bdy / s];
}
