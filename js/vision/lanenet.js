// Bahnerkennung mit einem kleinen neuronalen Netz (ohne Bibliothek). Trainiert auf Blender-Hallen (tools/lanenet/train.py).
// Eingang: Bild auf 256x256 gestaucht; Ausgang 64x64: Fläche der Zielbahn + 4 Ecken-Heatmaps (FoulL, FoulR, KopfpinL, KopfpinR).
const IN = 256, OUT = 64;
const MEAN = [0.45, 0.42, 0.40];   // Rand der ersten Faltung wird mit dem Mittelwert aufgefüllt (wie im Training nach Normierung 0)

let W = null, CH = [16, 32, 64, 96, 64, 48], loading = null;   // Kanalzahlen: Stamm, e1, e2, e3, u2, u1

function half(u) {   // float16 -> float32
  const s = (u & 0x8000) ? -1 : 1, e = (u >> 10) & 0x1f, f = u & 0x3ff;
  if (e === 0) return s * f * 2 ** -24;
  if (e === 31) return f ? NaN : s * Infinity;
  return s * (1 + f / 1024) * 2 ** (e - 15);
}

export function loadLaneNet(url) {
  if (W) return Promise.resolve(W);
  if (!loading) loading = (async () => {
    const buf = await (await fetch(url)).arrayBuffer();
    const dv = new DataView(buf);
    const tag = String.fromCharCode(...new Uint8Array(buf, 0, 4));
    if (tag !== 'LNT1' && tag !== 'LNT2') throw new Error('lanenet: Format');
    let off = 8;
    if (tag === 'LNT2') { CH = [0, 1, 2, 3, 4, 5].map(i => dv.getUint16(8 + 2 * i, true)); off = 20; }   // breiteres Netz
    const n = dv.getUint32(4, true), h = new Uint16Array(buf, off, n), f = new Float32Array(n);
    for (let i = 0; i < n; i++) f[i] = half(h[i]);
    W = f; return W;
  })().catch(e => { loading = null; throw e; });
  return loading;
}

// ---- Bausteine (Tensor: {c, h, w, d: Float32Array CHW})
function conv3(x, Wt, o, B, ob, co, s, padVal) {    // volle 3x3-Faltung (nur der Stamm, 3 Eingänge)
  const ci = x.c, H = Math.ceil(x.h / s), Wd = Math.ceil(x.w / s), y = new Float32Array(co * H * Wd);
  for (let k = 0; k < co; k++) {
    const bk = B[ob + k];
    for (let i = 0; i < H; i++) for (let j = 0; j < Wd; j++) {
      let acc = bk;
      for (let c = 0; c < ci; c++) for (let di = 0; di < 3; di++) {
        const yy = i * s + di - 1;
        for (let dj = 0; dj < 3; dj++) {
          const xx = j * s + dj - 1;
          const v = yy < 0 || xx < 0 || yy >= x.h || xx >= x.w ? padVal[c] : x.d[(c * x.h + yy) * x.w + xx];
          acc += v * Wt[o + ((k * ci + c) * 3 + di) * 3 + dj];
        }
      }
      y[(k * H + i) * Wd + j] = acc > 0 ? acc : 0;
    }
  }
  return { c: co, h: H, w: Wd, d: y };
}
function dw3(x, Wt, o, B, ob, s, dil) {             // tiefenweise 3x3 + ReLU
  const H = Math.ceil(x.h / s), Wd = Math.ceil(x.w / s), y = new Float32Array(x.c * H * Wd);
  for (let c = 0; c < x.c; c++) {
    const base = c * x.h * x.w, wo = o + c * 9, b = B[ob + c];
    for (let i = 0; i < H; i++) for (let j = 0; j < Wd; j++) {
      let acc = b;
      for (let di = 0; di < 3; di++) {
        const yy = i * s + (di - 1) * dil;
        if (yy < 0 || yy >= x.h) continue;
        for (let dj = 0; dj < 3; dj++) {
          const xx = j * s + (dj - 1) * dil;
          if (xx < 0 || xx >= x.w) continue;
          acc += x.d[base + yy * x.w + xx] * Wt[wo + di * 3 + dj];
        }
      }
      y[(c * H + i) * Wd + j] = acc > 0 ? acc : 0;
    }
  }
  return { c: x.c, h: H, w: Wd, d: y };
}
function pw(x, Wt, o, B, ob, co, relu = true) {     // 1x1 (Matrixprodukt) [+ ReLU]
  const n = x.h * x.w, y = new Float32Array(co * n);
  for (let k = 0; k < co; k++) {
    const yo = k * n, b = B[ob + k];
    y.fill(b, yo, yo + n);
    for (let c = 0; c < x.c; c++) {
      const w = Wt[o + k * x.c + c];
      if (w === 0) continue;
      const xo = c * n;
      for (let p = 0; p < n; p++) y[yo + p] += w * x.d[xo + p];
    }
    if (relu) for (let p = yo; p < yo + n; p++) if (y[p] < 0) y[p] = 0;
  }
  return { c: co, h: x.h, w: x.w, d: y };
}
function up2cat(a, b) {                             // a nächster Nachbar x2, dann Kanäle von b anhängen
  const H = b.h, Wd = b.w, n = H * Wd, y = new Float32Array((a.c + b.c) * n);
  for (let c = 0; c < a.c; c++) for (let i = 0; i < H; i++) for (let j = 0; j < Wd; j++) y[c * n + i * Wd + j] = a.d[(c * a.h + (i >> 1)) * a.w + (j >> 1)];
  y.set(b.d, a.c * n);
  return { c: a.c + b.c, h: H, w: Wd, d: y };
}

function forward(x) {
  let o = 0;
  const take = (len) => { const at = o; o += len; return at; };
  const L = (ci, co) => ({ w: take(co * ci), b: take(co) });
  const [c0, c1, c2, c3, cu2, cu1] = CH;
  const stemW = take(c0 * 3 * 9), stemB = take(c0);
  let t = conv3(x, W, stemW, W, stemB, c0, 2, MEAN);
  const DS = (t, co, s = 1, d = 1) => {
    const dwW = take(t.c * 9), dwB = take(t.c);
    t = dw3(t, W, dwW, W, dwB, s, d);
    const p = L(t.c, co);
    return pw(t, W, p.w, W, p.b, co);
  };
  t = DS(t, c1, 2); const a = DS(t, c1);
  t = DS(a, c2, 2); const b = DS(t, c2);
  t = DS(b, c3, 2); t = DS(t, c3); t = DS(t, c3, 1, 2); const c = DS(t, c3, 1, 4);
  let u = up2cat(c, b); let p = L(u.c, cu2); u = pw(u, W, p.w, W, p.b, cu2); u = DS(u, cu2);
  u = up2cat(u, a); p = L(u.c, cu1); u = pw(u, W, p.w, W, p.b, cu1); u = DS(u, cu1);
  p = L(cu1, 5); const out = pw(u, W, p.w, W, p.b, 5, false);
  if (o !== W.length) throw new Error('lanenet: Gewichte passen nicht (' + o + ' / ' + W.length + ')');
  return out;
}

// RGBA-Bild (beliebige Größe) -> 3x256x256, bilinear, Werte 0..1
function input(frame) {
  const { data, width: w, height: h } = frame, d = new Float32Array(3 * IN * IN), n = IN * IN;
  for (let i = 0; i < IN; i++) {
    const fy = Math.min(h - 1.001, Math.max(0, (i + 0.5) * h / IN - 0.5)), y0 = fy | 0, ay = fy - y0;
    for (let j = 0; j < IN; j++) {
      const fx = Math.min(w - 1.001, Math.max(0, (j + 0.5) * w / IN - 0.5)), x0 = fx | 0, ax = fx - x0;
      const p00 = (y0 * w + x0) * 4, p01 = p00 + 4, p10 = p00 + w * 4, p11 = p10 + 4;
      for (let c = 0; c < 3; c++) {
        const v = (data[p00 + c] * (1 - ax) + data[p01 + c] * ax) * (1 - ay) + (data[p10 + c] * (1 - ax) + data[p11 + c] * ax) * ay;
        d[c * n + i * IN + j] = v / 255;
      }
    }
  }
  return { c: 3, h: IN, w: IN, d };
}

const sig = (v) => 1 / (1 + Math.exp(-v));

// Ergebnis: { corners: [[u,v] normiert | null] x4, conf: [..], area } – Ecken FoulL, FoulR, KopfpinL, KopfpinR
export function runLaneNet(frame) {
  if (!W) throw new Error('lanenet: nicht geladen');
  const out = forward(input(frame)), n = OUT * OUT;
  let area = 0;
  for (let p = 0; p < n; p++) if (out.d[p] > 0) area++;
  const corners = [], conf = [];
  for (let k = 0; k < 4; k++) {
    const o = (k + 1) * n;
    let bi = 0, bv = -1e9;
    for (let p = 0; p < n; p++) if (out.d[o + p] > bv) { bv = out.d[o + p]; bi = p; }
    const v0 = Math.floor(bi / OUT), u0 = bi % OUT, pk = sig(bv);
    conf.push(+pk.toFixed(2));
    if (pk < 0.25) { corners.push(null); continue; }
    let sw = 0, su = 0, sv = 0;
    for (let i = Math.max(0, v0 - 2); i <= Math.min(OUT - 1, v0 + 2); i++) for (let j = Math.max(0, u0 - 2); j <= Math.min(OUT - 1, u0 + 2); j++) {
      const s = sig(out.d[o + i * OUT + j]); sw += s; su += s * j; sv += s * i;
    }
    corners.push([su / sw / OUT, sv / sw / OUT]);    // Heatmap-Pixel j -> Eingangs-Koordinate j*4 -> normiert /256
  }
  return { corners, conf, area: area / n, iou: corners.every(Boolean) ? quadIoU(out.d, corners) : 0 };
}

// Gegencheck: wie gut deckt das Ecken-Viereck die erkannte Bahnfläche (beide unabhängig vorhergesagt)
function quadIoU(d, c) {
  const q = [c[0], c[1], c[3], c[2]].map(([u, v]) => [u * OUT, v * OUT]);
  const inside = (x, y) => {
    let s = 0;
    for (let i = 0; i < 4; i++) {
      const a = q[i], b = q[(i + 1) % 4], z = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
      if (z !== 0) { if (s && Math.sign(z) !== s) return false; s = Math.sign(z); }
    }
    return true;
  };
  let I = 0, U = 0;
  for (let i = 0; i < OUT; i++) for (let j = 0; j < OUT; j++) {
    const m = d[i * OUT + j] > 0, p = inside(j, i);
    if (m && p) I++;
    if (m || p) U++;
  }
  return U ? I / U : 0;
}
