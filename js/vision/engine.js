// Kern der Bildauswertung: Nachführung (Handkamera), Bahn-Entzerrung, Hintergrundmodell,
// Kugelsuche, Wurf-Zustandsautomat, Pin-Erkennung. Reines JS, läuft im Worker, im Hauptthread und in Node.
import { homography, apply, mul, inv, ransacHomography, cameraFromH, resetRandom } from './geometry.js';
import { snapCorners } from './snap.js';
import { toGray, buildPyramid, detectFeatures, makeTemplates, trackLK, coarseShift } from './lk.js';
import { LANE_W, GUTTER_W, PIT_Y, HEADPIN_Y, BALL_R, PIN_H, PINS, PIN_IDS, topLineY } from '../lane.js';

export const ENGINE_DEFAULTS = {
  trackMode: 'hand',      // hand | tripod
  features: 140, lkRadius: 5, lkLevels: 4, lkIters: 8, lkMaxErr: 20, ransacPx: 2.0,
  refRefresh: true, keyQ: 0.4, snapCorners: true, planeFeatures: true, planeMargin: 4, planeMin: 10,      // Referenzbild bei guter Lage auffrischen
  fovDeg: 0,              // 0 = aus Kalibrierung schätzen
  topLine: 'headpin',     // headpin | pit
  gridScale: 1,           // 0.75 fein, 1 normal, 1.5 grob
  detMode: 'both',        // both | motion | color
  motionThr: 38, devK: 3.0, bgRate: 0.06, fgAbsorb: 0.004,
  colorTol: 1.0, lumTol: 1.0, minColorFrac: 0.15,
  startMin: 0.4, startMax: 8.0, startFrames: 3,
  minSpeed: 2.0, maxSpeed: 14.0, maxMiss: 0.35, maxMissNear: 0.9, maxMissLong: 1.2, nearY: 8, impactY: 17.85,
  sizeTolLo: 0.35, sizeTolHi: 2.6, topEdge: true, topEdgeOfs: 0,
  pinsEnabled: true, pinDelay: 1.8, pinWindow: 0.3, pinRatio: 0.5, pinRefMin: 0.4, pinAbsMin: 0.4, pinOccluded: 'standing',
  pinZLow: 0.45, pinLumThr: 0, pinRefEvery: 0.5, cropMax: 900,
  pinTrack: false, pinTrackDur: 1.4, pinTrackLag: 0.015,
  // Handy-Robustheit: Belichtungsausgleich, Verankerung am Referenzbild (jedes n-te Bild);
  // Nachbarschaftsvergleich (nbPx) und weiche Kugelfarbe im Lauf sind aus, weil sie saubere Aufnahmen verschlechtern
  gainComp: true, refAnchor: true, refAnchorEvery: 2, nbPx: 0, nbMax: 4, colorSoft: false,
  colorClusters: true, colorSampleBall: true, clusterTolC: 12, clusterTolY: 36,
  motionFallback: false, motionSeedSize: 0.8, motionSeedExtra: 4,   // Wurfstart über Bewegung, wenn die Kugelfarbe nicht passt   // Kugelfarbe: bis 3 Farbgruppen, Probe über die ganze Kugel
  cooldown: 3.0, debug: false,
};

const pinR = [[0, 0.0285], [0.03, 0.04], [0.0635, 0.0475], [0.114, 0.0605], [0.165, 0.0575],
  [0.22, 0.04], [0.27, 0.0225], [0.30, 0.025], [0.33, 0.031], [0.36, 0.027], [0.381, 0.0]];
function pinRadius(z) {
  for (let i = 1; i < pinR.length; i++) if (z <= pinR[i][0]) {
    const [z0, r0] = pinR[i - 1], [z1, r1] = pinR[i];
    return r0 + (r1 - r0) * (z - z0) / (z1 - z0);
  }
  return 0;
}

// Pin-Verlauf: Messhöhen (Anteil der Pinhöhe) und seitliche Versätze (× 6 cm)
const PT_Z = [0.6, 0.7, 0.8, 0.9, 0.98], PT_L = [-1.8, -1.1, -0.5, 0, 0.5, 1.1, 1.8];
const PT_MIN = 10, PT_THR = 0.35, PT_SIDE = 0.15, PT_SH = 2;

// liegt Pixel k in der Silhouette g (seitlich um eine Pinbreite, nach oben um ein Drittel der Höhe aufgeweitet)?
function nearPin(g, k, cw) {
  if (k < 0 || !g.span.length) return false;
  const x = k % cw, y = (k - x) / cw;
  const top = g.span[g.span.length - 1][0], bot = g.span[0][0], hgt = Math.abs(bot - top) / 0.65;
  const yMin = Math.min(top, bot) - hgt * 0.35, yMax = Math.max(top, bot) + hgt * 0.5;
  if (y < yMin || y > yMax) return false;
  let a = 1e9, b = -1e9;
  for (const [, aa, bb] of g.span) { a = Math.min(a, aa); b = Math.max(b, bb); }
  const wd = b - a + 1;
  return x >= a - wd && x <= b + wd;
}

const ycc = (r, g, b) => [0.299 * r + 0.587 * g + 0.114 * b, -0.1687 * r - 0.3313 * g + 0.5 * b, 0.5 * r - 0.4187 * g - 0.0813 * b];

export class Engine {
  constructor(opts = {}) {
    this.o = { ...ENGINE_DEFAULTS, ...opts };
    this.ref = null; this.ballColor = null; this.pinsBefore = [...PIN_IDS];
    this.events = [];
    this.resetShot();
  }
  setOptions(o) {
    const g = this.o.gridScale;
    Object.assign(this.o, o);
    if (o.gridScale !== undefined && o.gridScale !== g) this.grid = null;
    if (this.ref && (o.features !== undefined || o.lkRadius !== undefined || o.lkLevels !== undefined)) this._needRecal = true;
  }
  setBallColor(c) { this.ballColor = c; }
  setPinsBefore(list) { this.pinsBefore = list && list.length ? [...list] : [...PIN_IDS]; }
  resetShot() {
    this.state = this.ref ? 'idle' : 'nocal';
    this.seed = []; this.seedM = []; this.motionTrack = false; this.track = []; this.itrack = []; this.miss = 0;
    this.pinMeas = []; this.tImpact = null; this.tStart = null; this.lastPinRefT = -1e9;
    this.pinSeries = []; this._ptRef = null;
  }

  // corners: normalisiert [[x,y] FoulL, FoulR, ObenL, ObenR]
  calibrate(frame, corners, opts) {
    const { width: w, height: h, data } = frame;
    const o = this.o;
    const gray = toGray(data, w, h);
    const pyr = buildPyramid(gray, w, h, o.lkLevels);
    const yT = topLineY(o.topLine);
    // normalisiert (kontinuierlich, Pixelmitte bei +0,5) -> Engine-Pixel (Pixelmitte ganzzahlig)
    let img = corners.map(([x, y]) => [x * w - 0.5, y * h - 0.5]);
    let snapped = false;
    if (o.snapCorners && !opts?.noSnap) {
      const r = snapCorners(gray, w, h, img, yT);
      if (r) { img = r.corners; snapped = true; corners = img.map(([x, y]) => [(x + 0.5) / w, (y + 0.5) / h]); }
    }
    const Href = homography([[0, 0], [LANE_W, 0], [0, yT], [LANE_W, yT]], img);
    if (!Href) throw new Error('Kalibrierung ungültig');
    const pts = detectFeatures(pyr[0], o.features);
    // Merkmale auf der Bahnebene (Bahn, Rinnen, Nachbarbahnen, Anlauf) markieren: deren Homografie stimmt auch bei
    // Handbewegung exakt; Decke, Wände, Maskierung haben Parallaxe und dienen nur der groben Lage.
    const Hi = inv(Href);
    const plane = pts.map(([x, y]) => {
      const w = Hi[6] * x + Hi[7] * y + Hi[8]; if (w <= 0) return 0;
      const X = (Hi[0] * x + Hi[1] * y + Hi[2]) / w, Y = (Hi[3] * x + Hi[4] * y + Hi[5]) / w;
      return X > -o.planeMargin && X < LANE_W + o.planeMargin && Y > -4 && Y < HEADPIN_Y - 0.5 ? 1 : 0;
    });
    const tpls = makeTemplates(pyr, pts, o.lkRadius);
    this.ref = { w, h, pts, plane, tpls, Href, corners: corners.map(c => [...c]) };
    resetRandom();
    this.T = new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]); this.Tprev = null; this.key = null; this.keyCount = 0;
    const fFov = o.fovDeg > 0 ? (w / 2) / Math.tan(o.fovDeg * Math.PI / 360) : 0;
    this.f = cameraFromH(Href, w, h, fFov || undefined).f;
    this.grid = null; this.lost = 0; this.quality = 1; this._needRecal = false;
    this.pinRef = null; this.pinRefCand = null;
    this.frameN = 0;
    this.resetShot();
    return { features: pts.length, f: this.f / w, snapped, corners: this.ref.corners };
  }

  // Rechteck (normalisiert) für hochaufgelösten Pin-Ausschnitt, falls gerade gebraucht
  cropRequest(t) {
    if (!this.ref || !this.o.pinsEnabled || !this.cam) return null;
    const ts = t / 1000;
    const need = (this.state === 'idle' && ts - this.lastPinRefT >= this.o.pinRefEvery) ||
      (this.state === 'settle' && ts >= this.tPinAt) || this._wantTrack(ts);
    if (!need) return null;
    return this.pinRect();
  }
  // Pin-Verlauf: Ausschnitt in jedem Bild, sobald die Kugel nahe den Pins ist, bis die Pins liegen
  _wantTrack(ts) {
    if (!this.o.pinTrack || !this.pinRef) return false;
    if (this.state === 'roll') { const l = this.track[this.track.length - 1]; return !!l && l[2] > 13; }
    return this.state === 'settle' && ts < this.tImpact + this.o.pinTrackDur;
  }
  pinRect() {
    const { w, h } = this.ref, P = this.cam.P;
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const id of PIN_IDS) {
      const [X, Y] = PINS[id];
      for (const [dx, z] of [[-0.07, 0], [0.07, 0], [-0.07, PIN_H], [0.07, PIN_H]]) {
        const [u, v] = P(X + dx, Y, z);
        x0 = Math.min(x0, u); x1 = Math.max(x1, u); y0 = Math.min(y0, v); y1 = Math.max(y1, v);
      }
    }
    const mx = (x1 - x0) * 0.25 + 4, my = (y1 - y0) * 0.3 + 4;
    x0 = Math.max(0, x0 - mx); y0 = Math.max(0, y0 - my); x1 = Math.min(w, x1 + mx); y1 = Math.min(h, y1 + my);
    if (x1 - x0 < 4 || y1 - y0 < 4) return null;
    return { x: (x0 + 0.5) / w, y: (y0 + 0.5) / h, w: (x1 - x0) / w, h: (y1 - y0) / h };
  }

  // Kugelfarbe aus einer angetippten Stelle. Kugeln sind oft gemustert (Wirbel, Verläufe): deshalb bis zu 3
  // Farbgruppen (k-Means in YCbCr, Helligkeit schwächer gewichtet), jede mit eigener Streuung. Ist die Bahn schon
  // eingerichtet, deckt die Probe die ganze Kugel ab (Bildradius aus der Kamera), sonst einen festen Radius.
  sampleColor(frame, nx, ny, nr) {
    const { width: w, height: h, data } = frame;
    const cx = nx * w - 0.5, cy = ny * h - 0.5;
    let r = Math.max(2, nr * w);
    const cam = this.cam || (this.ref && this.ref.w === w ? cameraFromH(this.ref.Href, w, h, this.f) : null);
    if (this.o.colorSampleBall && cam && this.ref && this.ref.w === w) {
      try {
        const HR = inv(cam.planeH(BALL_R));
        const [X, Y] = apply(HR, cx, cy);
        const z = cam.P(X, Y, BALL_R)[2];
        if (isFinite(z) && z > 0) r = Math.min(0.08 * w, Math.max(3, 0.7 * BALL_R * cam.f / z));
      } catch { /* fester Radius */ }
    }
    const s = [];
    for (let y = Math.max(0, cy - r | 0); y < Math.min(h, cy + r); y++)
      for (let x = Math.max(0, cx - r | 0); x < Math.min(w, cx + r); x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
        const i = (y * w + x) * 4; s.push([data[i], data[i + 1], data[i + 2]]);
      }
    if (s.length < 4) return null;
    const yc = s.map(p => ycc(...p)).sort((a, b) => a[0] - b[0]);
    // Glanzlichter und tiefe Schatten weglassen
    const tr = yc.slice(Math.floor(yc.length * 0.05), Math.ceil(yc.length * 0.95));
    const stats = (arr) => {
      const m = [0, 0, 0]; arr.forEach(v => { m[0] += v[0]; m[1] += v[1]; m[2] += v[2]; });
      m[0] /= arr.length; m[1] /= arr.length; m[2] /= arr.length;
      let sy = 0, sc = 0; arr.forEach(v => { sy += (v[0] - m[0]) ** 2; sc += (v[1] - m[1]) ** 2 + (v[2] - m[2]) ** 2; });
      return { y: m[0], cb: m[1], cr: m[2], sy: Math.sqrt(sy / arr.length), sc: Math.sqrt(sc / arr.length) };
    };
    // k-Means mit k = 3, Start: am weitesten auseinanderliegende Punkte
    const dist = (a, b) => 0.25 * (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
    let cen = [tr[tr.length >> 1]];
    while (cen.length < 3 && tr.length >= 12) {
      let far = null, fd = -1;
      for (const v of tr) { const d = Math.min(...cen.map(c => dist(v, c))); if (d > fd) { fd = d; far = v; } }
      if (fd < 60) break;                  // keine weiteren deutlich anderen Farben
      cen.push(far);
    }
    let lab = new Array(tr.length).fill(0);
    for (let it = 0; it < 8; it++) {
      lab = tr.map(v => { let bi = 0, bd = Infinity; cen.forEach((c, k) => { const d = dist(v, c); if (d < bd) { bd = d; bi = k; } }); return bi; });
      cen = cen.map((c, k) => { const g = tr.filter((_, i) => lab[i] === k); if (!g.length) return c; const st = stats(g); return [st.y, st.cb, st.cr]; });
    }
    let clusters = cen.map((_, k) => { const g = tr.filter((_, i) => lab[i] === k); return g.length ? { ...stats(g), share: g.length / tr.length } : null; })
      .filter(c => c && c.share >= 0.15).sort((a, b) => b.share - a.share);
    // Gruppen, die wie die Bahn selbst aussehen (Probe teils neben der Kugel), verwerfen
    const lane = this._laneColor();
    if (lane && clusters.length > 1) {
      const rest = clusters.filter(c => !(Math.hypot(c.cb - lane.cb, c.cr - lane.cr) < 10 && Math.abs(c.y - lane.y) < 30));
      if (rest.length) clusters = rest;
    }
    const all = stats(tr);
    const main = clusters[0] || all;
    const rgb = [0, 0, 0]; s.forEach(p => { rgb[0] += p[0]; rgb[1] += p[1]; rgb[2] += p[2]; });
    return { y: main.y, cb: main.cb, cr: main.cr, sy: main.sy, sc: main.sc, clusters, rgb: rgb.map(v => Math.round(v / s.length)) };
  }
  // typische Farbe der Bahn (Median des Hintergrundmodells auf der Bahnfläche)
  _laneColor() {
    const g = this.grid; if (!g || g.frames < 8) return null;
    const ys = [], cbs = [], crs = [];
    for (let j = 0; j < g.ny; j += 7) for (let i = 0; i < g.nx; i += 3) {
      const X = g.X0 + (i + 0.5) * g.cx; if (X < 0.05 || X > LANE_W - 0.05) continue;
      const k = j * g.nx + i; if (!g.valid[k]) continue;
      const c = ycc(g.bg[k * 3], g.bg[k * 3 + 1], g.bg[k * 3 + 2]); ys.push(c[0]); cbs.push(c[1]); crs.push(c[2]);
    }
    if (ys.length < 20) return null;
    const med = (a) => a.sort((p, q) => p - q)[a.length >> 1];
    return { y: med(ys), cb: med(cbs), cr: med(crs) };
  }

  _ensureGrid() {
    if (this.grid) return this.grid;
    const s = this.o.gridScale || 1;
    const cx = (LANE_W / 39 / 2) * s, cy = 0.03 * s;
    const X0 = -GUTTER_W, X1 = LANE_W + GUTTER_W, Y0 = -0.3;
    // Raster bis dorthin, wo der Sehstrahl über die Kugeloberkante (Kugel am Kopfpin) den Boden trifft
    let Y1 = PIT_Y + 0.5;
    if (this.cam) {
      const [, cyc, czc] = this.cam.camPos;
      if (czc > 2 * BALL_R + 0.05) Y1 = Math.min(32, Math.max(Y1, cyc + (HEADPIN_Y + BALL_R - cyc) * czc / (czc - 2 * BALL_R) + 0.6));
      else Y1 = 32;
    }
    const nx = Math.ceil((X1 - X0) / cx), ny = Math.ceil((Y1 - Y0) / cy), n = nx * ny;
    this.grid = {
      cx, cy, X0, Y0, nx, ny, n,
      cur: new Uint8Array(n * 3), bg: new Float32Array(n * 3), dev: new Float32Array(n),
      valid: new Uint8Array(n), fg: new Uint8Array(n), tmp: new Uint8Array(n), col: new Uint8Array(n),
      U: new Float32Array(n), V: new Float32Array(n), Wt: new Float32Array(n), lab: new Int32Array(n),
      age: new Uint16Array(n), frames: 0,
    };
    return this.grid;
  }

  _rectify(frame, H) {
    const g = this._ensureGrid();
    const { width: w, height: h, data } = frame;
    const { nx, ny, cx, cy, X0, Y0, cur, valid, U, V, Wt } = g;
    for (let j = 0; j < ny; j++) {
      const Y = Y0 + (j + 0.5) * cy;
      const bu = H[1] * Y + H[2], bv = H[4] * Y + H[5], bw = H[7] * Y + H[8];
      for (let i = 0; i < nx; i++) {
        const X = X0 + (i + 0.5) * cx;
        const k = j * nx + i;
        const ww = H[6] * X + bw;
        if (ww <= 1e-9) { valid[k] = 0; continue; }
        const u = (H[0] * X + bu) / ww, v = (H[3] * X + bv) / ww;
        if (u < 0 || v < 0 || u >= w - 1 || v >= h - 1) { valid[k] = 0; continue; }
        const p = ((v + 0.5 | 0) * w + (u + 0.5 | 0)) * 4;
        cur[k * 3] = data[p]; cur[k * 3 + 1] = data[p + 1]; cur[k * 3 + 2] = data[p + 2];
        valid[k] = 1; U[k] = u; V[k] = v; Wt[k] = 1 / (ww * ww * ww);
      }
    }
  }

  _foreground() {
    const g = this.grid, o = this.o;
    const { n, cur, bg, dev, valid, fg, col, age } = g;
    const learning = g.frames < 8;
    const a = learning ? 0.35 : o.bgRate;
    const bc = this.ballColor;
    const useColor = !!bc && o.detMode !== 'motion';
    // eine oder mehrere Farbgruppen (gemusterte Kugeln); alte gespeicherte Farben haben nur eine
    const cls = bc ? (o.colorClusters && bc.clusters && bc.clusters.length ? bc.clusters : [bc]) : [];
    // Mindesttoleranz: einzelne Farbgruppen sind sehr einheitlich; ferne, unscharfe Kugeln weichen stärker ab
    const multi = cls.length > 1, cMin = multi ? o.clusterTolC : 7, lMin = multi ? o.clusterTolY : 28;
    const cTols = cls.map(c => o.colorTol * Math.max(cMin, 2.5 * c.sc)), lTols = cls.map(c => o.lumTol * Math.max(lMin, 2.5 * c.sy));
    let active = 0;
    // Belichtung und Weißabgleich ausgleichen: Verhältnis aktuelles Bild / Hintergrund je Farbkanal (Median über
    // eingelernte Zellen). Handys regeln Helligkeit und Farbe ständig nach; ohne Ausgleich wird die ganze Bahn "Bewegung".
    let gr = 1, ggn = 1, gb = 1;
    if (o.gainComp && !learning) {
      const rr = [], rg = [], rb = [];
      for (let k = (g.frames * 7) % 41; k < n; k += 41) {
        if (!valid[k] || age[k] < 8 || fg[k]) continue;
        const b0 = bg[k * 3], b1 = bg[k * 3 + 1], b2 = bg[k * 3 + 2];
        if (b0 < 25 || b1 < 25 || b2 < 25 || b0 > 245 || b1 > 245 || b2 > 245) continue;
        rr.push(cur[k * 3] / b0); rg.push(cur[k * 3 + 1] / b1); rb.push(cur[k * 3 + 2] / b2);
      }
      const prev = g.gain || [1, 1, 1];
      if (rr.length > 60) {
        const med = (a) => { a.sort((x, y) => x - y); return a[a.length >> 1]; };
        // echte Belichtung ändert sich langsam; große Sprünge sind Verdeckung (Person vor der Kamera)
        const lim = (m, p0) => Math.min(p0 * 1.03, Math.max(p0 * 0.97, m));
        gr = lim(med(rr), prev[0]); ggn = lim(med(rg), prev[1]); gb = lim(med(rb), prev[2]);
      } else [gr, ggn, gb] = prev;
    }
    g.gain = [gr, ggn, gb];
    const ig0 = 1 / gr, ig1 = 1 / ggn, ig2 = 1 / gb;
    // Nachbarschaftsvergleich: kleine Lagefehler (Wackeln, Rolling Shutter) verschieben Kanten um 1–2 Pixel.
    // Je Rasterzeile: wie viele Zellen längs entsprechen nbPx Bildpixeln?
    const nbR = this._nbRows();
    for (let k = 0; k < n; k++) {
      if (!valid[k]) { fg[k] = 0; age[k] = 0; continue; }
      const r = cur[k * 3] * ig0, gg = cur[k * 3 + 1] * ig1, b = cur[k * 3 + 2] * ig2;
      if (useColor) {
        const Y = 0.299 * r + 0.587 * gg + 0.114 * b, Cb = -0.1687 * r - 0.3313 * gg + 0.5 * b, Cr = 0.5 * r - 0.4187 * gg - 0.0813 * b;
        let m = 0;
        for (let q = 0; q < cls.length; q++) if (Math.hypot(Cb - cls[q].cb, Cr - cls[q].cr) < cTols[q] && Math.abs(Y - cls[q].y) < lTols[q]) { m = 1; break; }
        col[k] = m;
      } else col[k] = 0;
      if (age[k] === 0) { // neu sichtbar
        bg[k * 3] = r; bg[k * 3 + 1] = gg; bg[k * 3 + 2] = b; dev[k] = o.motionThr * 0.3; age[k] = 1; fg[k] = 0; continue;
      }
      const d = Math.abs(r - bg[k * 3]) + Math.abs(gg - bg[k * 3 + 1]) + Math.abs(b - bg[k * 3 + 2]);
      const thr = Math.max(o.motionThr, o.devK * dev[k]);
      let isFg = !learning && age[k] > 4 && d > thr, dEff = d;
      if (isFg && nbR) {
        // passt der Wert zum Hintergrund einer Nachbarzelle, war es nur eine Verschiebung
        const i = k % g.nx, j = (k - i) / g.nx, rj = nbR.rj[j], ri = nbR.ri[j];
        search: for (let dj = -rj; dj <= rj; dj++) {
          const jj = j + dj; if (jj < 0 || jj >= g.ny) continue;
          for (let di = -ri; di <= ri; di++) {
            const ii = i + di; if ((!di && !dj) || ii < 0 || ii >= g.nx) continue;
            const q = jj * g.nx + ii; if (!valid[q] || age[q] < 5) continue;
            const dq = Math.abs(r - bg[q * 3]) + Math.abs(gg - bg[q * 3 + 1]) + Math.abs(b - bg[q * 3 + 2]);
            if (dq <= thr) { isFg = false; dEff = dq; break search; }
          }
        }
      }
      const rate = isFg ? o.fgAbsorb : a;
      bg[k * 3] += rate * (r - bg[k * 3]); bg[k * 3 + 1] += rate * (gg - bg[k * 3 + 1]); bg[k * 3 + 2] += rate * (b - bg[k * 3 + 2]);
      if (!isFg) dev[k] += a * (dEff - dev[k]);
      if (age[k] < 60000) age[k]++;
      fg[k] = o.detMode === 'color' ? col[k] : (isFg ? 1 : 0);
      active += fg[k];
    }
    g.frames++;
    // Öffnen: 3x3-Kreuz erodieren, dann dilatieren
    const { nx, ny, tmp } = g;
    tmp.fill(0);
    for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
      const k = j * nx + i;
      if (fg[k] && fg[k - 1] && fg[k + 1] && fg[k - nx] && fg[k + nx]) tmp[k] = 1;
    }
    fg.fill(0);
    for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
      const k = j * nx + i;
      if (tmp[k]) { fg[k] = 1; fg[k - 1] = 1; fg[k + 1] = 1; fg[k - nx] = 1; fg[k + nx] = 1; }
    }
    return active;
  }

  // Suchradius je Rasterzeile (in Zellen), der nbPx Bildpixeln entspricht – längs und quer
  _nbRows() {
    const o = this.o, g = this.grid;
    if (!(o.nbPx > 0) || !this.H) return null;
    if (!g.nbR) g.nbR = { rj: new Uint8Array(g.ny), ri: new Uint8Array(g.ny) };
    const H = this.H, xc = LANE_W / 2, P = (x, y) => { const w = H[6] * x + H[7] * y + H[8]; return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w]; };
    for (let j = 0; j < g.ny; j++) {
      const Y = g.Y0 + (j + 0.5) * g.cy;
      const a = P(xc, Y), b = P(xc, Y + g.cy), c = P(xc + g.cx, Y);
      const dy = Math.hypot(b[0] - a[0], b[1] - a[1]), dx = Math.hypot(c[0] - a[0], c[1] - a[1]);
      g.nbR.rj[j] = Math.min(o.nbMax, Math.round(o.nbPx / Math.max(1e-3, dy)));
      g.nbR.ri[j] = Math.min(o.nbMax, Math.max(1, Math.round(o.nbPx / Math.max(1e-3, dx))));
    }
    return g.nbR;
  }

  _blobs() {
    const g = this.grid, o = this.o;
    const { nx, ny, fg, lab, col, U, V, Wt, cx, cy, X0, Y0 } = g;
    lab.fill(0);
    const blobs = [];
    const st = [];
    let L = 0;
    for (let k0 = 0; k0 < g.n; k0++) {
      if (!fg[k0] || lab[k0]) continue;
      L++; st.push(k0); lab[k0] = L;
      let area = 0, cnt = 0, su = 0, sv = 0, sw = 0, i0 = 1e9, i1 = -1, j0 = 1e9, j1 = -1, vMin = 1e9, vMax = -1e9;
      while (st.length) {
        const k = st.pop();
        const i = k % nx, j = (k / nx) | 0;
        area++; cnt += col[k];
        const wt = Wt[k]; su += U[k] * wt; sv += V[k] * wt; sw += wt;
        if (V[k] < vMin) vMin = V[k]; if (V[k] > vMax) vMax = V[k];
        if (i < i0) i0 = i; if (i > i1) i1 = i; if (j < j0) j0 = j; if (j > j1) j1 = j;
        if (i > 0 && fg[k - 1] && !lab[k - 1]) { lab[k - 1] = L; st.push(k - 1); }
        if (i < nx - 1 && fg[k + 1] && !lab[k + 1]) { lab[k + 1] = L; st.push(k + 1); }
        if (j > 0 && fg[k - nx] && !lab[k - nx]) { lab[k - nx] = L; st.push(k - nx); }
        if (j < ny - 1 && fg[k + nx] && !lab[k + nx]) { lab[k + nx] = L; st.push(k + nx); }
      }
      if (area < 10) continue;
      blobs.push({
        area, colorFrac: cnt / area, u: su / sw, v: sv / sw, vMin, vMax,
        xMin: X0 + i0 * cx, xMax: X0 + (i1 + 1) * cx, yMin: Y0 + j0 * cy, yMax: Y0 + (j1 + 1) * cy,
      });
    }
    void o;
    return blobs;
  }

  // Kandidaten -> Kugelposition (Mittelpunkt auf Höhe R über der Bahn)
  _candidates(blobs) {
    const o = this.o, cam = this.cam;
    const HR = inv(cam.planeH(BALL_R));
    const [, cyc, czc] = cam.camPos;
    const out = [];
    for (const b of blobs) {
      let [X, Y] = apply(HR, b.u, b.v);
      if (!isFinite(X) || Y < -0.2 || Y > PIT_Y) continue;
      // Oberkante statt Schwerpunkt, wenn die Kugel groß genug abgebildet ist (Schatten/Spiegelung unten verfälschen)
      const depth = cam.P(X, Y, BALL_R)[2];
      const rImg = BALL_R * cam.f / depth;
      let v = b.v;
      if (o.topEdge && rImg > 2) {
        const wTop = Math.min(1, (rImg - 2) / 4);
        v = (1 - wTop) * b.v + wTop * (Math.round(b.vMin) + o.topEdgeOfs + rImg);
        [X, Y] = apply(HR, b.u, v);
      }
      const width = b.xMax - b.xMin, len = b.yMax - b.yMin;
      const near = Y - BALL_R;
      const far = czc > 2 * BALL_R + 0.05 ? cyc + (Y + BALL_R - cyc) * czc / (czc - 2 * BALL_R) : Y + 3;
      const expL = Math.max(2 * BALL_R, far - near);
      const wOk = width > 2 * BALL_R * o.sizeTolLo && width < 2 * BALL_R * o.sizeTolHi;
      const lOk = len > expL * o.sizeTolLo && len < expL * o.sizeTolHi;
      if (!wOk || !lOk) continue;
      // Farbe nur beim Start Pflicht; im Lauf leidet sie unter Unschärfe, Rauschen und Farbstich -> nur Abzug
      const colorOk = !(this.ballColor && o.detMode === 'both' && b.colorFrac < o.minColorFrac);
      const size = Math.abs(Math.log(width / (2 * BALL_R))) + Math.abs(Math.log(len / expL));
      out.push({ X, Y, u: b.u, v, size, colorFrac: b.colorFrac, area: b.area, colorOk });
    }
    return out;
  }

  _fitVel(pts, n = 6) {
    const p = pts.slice(-n);
    if (p.length < 2) return null;
    const t0 = p[0][0];
    let st = 0, sx = 0, sy = 0, stt = 0, stx = 0, sty = 0;
    for (const [t, x, y] of p) { const tt = t - t0; st += tt; sx += x; sy += y; stt += tt * tt; stx += tt * x; sty += tt * y; }
    const m = p.length, d = m * stt - st * st;
    if (Math.abs(d) < 1e-9) return null;
    const vx = (m * stx - st * sx) / d, vy = (m * sty - st * sy) / d;
    const ax = (sx - vx * st) / m, ay = (sy - vy * st) / m;
    return { t0, ax, ay, vx, vy };
  }

  // Startkandidaten sammeln: mehrere Bilder in Folge mit Vorwärtsbewegung
  _seedStep(cands, ts, seed, anyColor) {
    const o = this.o;
    const zone = cands.filter(c => (anyColor ? c.size < o.motionSeedSize : c.colorOk) && c.Y >= o.startMin && c.Y <= o.startMax && c.X > -GUTTER_W && c.X < LANE_W + GUTTER_W);
    let best = null;
    if (seed.length) {
      const [lt, lx, ly] = seed[seed.length - 1];
      const dt = ts - lt;
      if (dt > 0.25) seed = [];
      else for (const c of zone) {
        const vy = (c.Y - ly) / Math.max(dt, 1e-3), vx = Math.abs(c.X - lx) / Math.max(dt, 1e-3);
        if (vy >= o.minSpeed * 0.6 && vy <= o.maxSpeed * 1.3 && vx < 2.5) {
          const sc = c.size + Math.abs(vy - 7) * 0.05;
          if (!best || sc < best.sc) best = { c, sc };
        }
      }
    }
    if (best) return [...seed, [ts, best.c.X, best.c.Y, best.c.u, best.c.v]];
    if (zone.length) { zone.sort((a, b) => a.size - b.size || a.Y - b.Y); return [[ts, zone[0].X, zone[0].Y, zone[0].u, zone[0].v]]; }
    return seed;
  }
  _seedReady(seed) {
    if (seed.length < this.o.startFrames) return false;
    const v = this._fitVel(seed);
    return !!v && v.vy >= this.o.minSpeed && v.vy <= this.o.maxSpeed;
  }
  _startRoll(seed, ts, ev, restart) {
    this.state = 'roll'; this.track = seed.map(p => [p[0], p[1], p[2]]);
    this.itrack = seed.map(p => [p[0], (p[3] + 0.5) / this.ref.w, (p[4] + 0.5) / this.ref.h]);
    this.tStart = seed[0][0]; this.lastSeen = ts; this.alt = []; this.seedM = [];
    if (!restart) this.pinRef = this.pinRefCand;
    ev.push({ type: restart ? 'restart' : 'start', t: this.tStart });
  }

  _stateStep(cands, ts, ev) {
    const o = this.o;
    if (this.state === 'idle') {
      this.seed = this._seedStep(cands, ts, this.seed);
      // Ersatzweg: Kugelfarbe passt nicht (durchsichtig, Glitzer, Unschärfe, Farbstich) -> Start über Bewegung allein,
      // dafür mit mehr Bildern und guter Größe. Die Farbe zählt danach nur noch als Bonus.
      if (o.motionFallback && this.ballColor) this.seedM = this._seedStep(cands, ts, this.seedM || [], true);
      if (this._seedReady(this.seed)) { this.motionTrack = false; this._startRoll(this.seed, ts, ev); }
      else if (this.seedM && this.seedM.length >= o.startFrames + o.motionSeedExtra && this.seed.length < 2 && this._seedReady(this.seedM)) { this.motionTrack = true; this._startRoll(this.seedM, ts, ev); }
    } else if (this.state === 'roll') {
      const v = this._fitVel(this.track);
      const dt = ts - this.track[this.track.length - 1][0];
      let px, py;
      if (v) { px = v.ax + v.vx * (ts - v.t0); py = v.ay + v.vy * (ts - v.t0); }
      else { const l = this.track[this.track.length - 1]; px = l[1]; py = l[2]; }
      const gy = 0.5 + Math.abs(v ? v.vy : 8) * dt * 0.35, gx = 0.25 + 1.2 * dt;
      let best = null;
      for (const c of cands) {
        const ey = Math.abs(c.Y - py), ex = Math.abs(c.X - px);
        if (ey > gy || ex > gx) continue;
        if (!c.colorOk && !o.colorSoft && !this.motionTrack) continue;
        const sc = ey / gy + ex / gx + c.size * 0.5 + (c.colorOk ? 0 : this.motionTrack ? 0.3 : 0.8);
        if (!best || sc < best.sc) best = { c, sc };
      }
      if (!best) {
        // Alternative Spur (z. B. war der Anfang die Kugel noch in der Hand)
        this.alt = this._seedStep(cands, ts, this.alt || []);
        if (this.alt.length >= this.o.startFrames + 1 && this._seedReady(this.alt) && ts - this.lastSeen > 0.12) {
          this._startRoll(this.alt, ts, ev, true);
          return;
        }
      }
      if (best) {
        this.track.push([ts, best.c.X, best.c.Y]);
        this.itrack.push([ts, (best.c.u + 0.5) / this.ref.w, (best.c.v + 0.5) / this.ref.h]);
        this.lastSeen = ts;
      }
      const last = this.track[this.track.length - 1];
      const span = last[2] - this.track[0][2];
      // Spur ohne Vorwärtsbewegung (Bein, Hand, Schatten): verwerfen
      if (this.track.length >= 8) {
        const vv = this._fitVel(this.track, 8);
        if (vv && vv.vy < o.minSpeed * 0.5) {
          if (span > 6) {
            // Spur bleibt hängen (Kugel zu klein / verdeckt): stehende Punkte verwerfen und hochrechnen
            const yMaxT = Math.max(...this.track.map(p => p[2]));
            while (this.track.length > 8 && this.track[this.track.length - 1][2] < yMaxT - 0.05) { this.track.pop(); this.itrack.pop(); }
            const k = this.track.findIndex(p => p[2] >= yMaxT - 0.3);
            if (k > 8) { this.track.length = k + 1; this.itrack.length = k + 1; }
            this._impact(ev); return;
          }
          ev.push({ type: 'abort', t: ts }); this.resetShot(); this.state = 'idle'; return;
        }
      }
      if (last[2] >= o.impactY) this._impact(ev);
      // nahe der Foul-Linie verdeckt oft der Spieler die Kugel: dort längere Lücken erlauben
      else {
        const gap = ts - this.lastSeen;
        const lim = last[2] < o.nearY ? Math.max(o.maxMiss, o.maxMissNear) : o.maxMiss;
        if (gap > lim && last[2] > o.impactY - 4.5) this._impact(ev);
        // längere Spur: weiter auf die Kugel warten (Spieler läuft durchs Bild), erst dann hochrechnen
        else if (gap > lim && span > 6) { if (gap > o.maxMissLong) this._impact(ev); }
        else if (gap > lim) { ev.push({ type: 'abort', t: ts }); this.resetShot(); }
      }
    } else if (this.state === 'settle') {
      if (!this.o.pinsEnabled) this._finish(ts, ev);
      else if (ts >= this.tPinAt + o.pinWindow && this.pinMeas.length) this._finish(ts, ev);
      else if (ts >= this.tPinAt + o.pinWindow + 1.0) this._finish(ts, ev);
    } else if (this.state === 'cooldown') {
      if (ts >= this.tCoolEnd) { this.state = 'idle'; this.seed = []; ev.push({ type: 'ready', t: ts }); }
    }
  }

  _impact(ev) {
    const v = this._fitVel(this.track, 8);
    let t = this.track[this.track.length - 1][0];
    if (v && v.vy > 2) t = v.t0 + (this.o.impactY - v.ay) / v.vy;
    else { const l = this.track[this.track.length - 1]; t = l[0] + Math.max(0, this.o.impactY - l[2]) / 7.5; }
    this.tImpact = t; this.tPinAt = t + this.o.pinDelay; this.state = 'settle'; this.pinMeas = [];
    ev.push({ type: 'impact', t });
  }

  _finish(ts, ev) {
    let pins = null;
    if (this.o.pinsEnabled && this.pinMeas.length) pins = this._decidePins();
    const shot = {
      tStart: this.tStart, tImpact: this.tImpact, points: this.track.map(p => [+p[0].toFixed(4), +p[1].toFixed(4), +p[2].toFixed(4)]),
      itrack: this.itrack.map(p => [+p[0].toFixed(4), +p[1].toFixed(5), +p[2].toFixed(5)]),
      pinsBefore: [...this.pinsBefore], pinsAfter: pins ? pins.standing : null, pinDetail: pins ? pins.detail : null,
      cam: this._camSnapshot(),
    };
    if (this.o.pinTrack && this.pinSeries.length >= 6) shot.pinTrack = this._pinTimeline(pins ? pins.standing : null);
    this.pinSeries = []; this._ptRef = null;
    ev.push({ type: 'shot', t: ts, shot });
    this.state = 'cooldown'; this.tCoolEnd = ts + this.o.cooldown;
    this.track = []; this.seed = []; this.itrack = [];
  }

  _camSnapshot() {
    const { w, h } = this.ref;
    const S = new Float64Array([1 / w, 0, 0.5 / w, 0, 1 / h, 0.5 / h, 0, 0, 1]);
    return { H: Array.from(mul(S, this.H)), f: this.f / w, aspect: w / h };
  }

  // ---- Pins ----
  _pinGeometry(cam, crop) {
    const { w, h } = this.ref;
    const r = crop.rect, cw = crop.width, ch = crop.height;
    const sx = cw / (r.w * w), sy = ch / (r.h * h);
    const toC = (u, v) => [(u + 0.5 - r.x * w) * sx - 0.5, (v + 0.5 - r.y * h) * sy - 0.5];
    const [cxp, cyp] = cam.camPos;
    const geo = {};
    for (const id of PIN_IDS) {
      const [X, Y] = PINS[id];
      const dx = X - cxp, dy = Y - cyp, dist = Math.hypot(dx, dy);
      const px = -dy / dist, py = dx / dist; // quer zur Blickrichtung
      const [, vb] = toC(...cam.P(X, Y, 0)), [, vt] = toC(...cam.P(X, Y, PIN_H));
      const steps = Math.max(8, Math.ceil(Math.abs(vb - vt) * 2));
      const full = new Set(), meas = new Set(), span = [];
      for (let s = 0; s <= steps; s++) {
        const z = PIN_H * s / steps, rr = pinRadius(z) * 0.92;
        const [ua, va] = toC(...cam.P(X - px * rr, Y - py * rr, z)), [ub, vb2] = toC(...cam.P(X + px * rr, Y + py * rr, z));
        const row = Math.round((va + vb2) / 2);
        if (row < 0 || row >= ch) continue;
        const a = Math.max(0, Math.round(Math.min(ua, ub))), b = Math.min(cw - 1, Math.round(Math.max(ua, ub)));
        // Zeilen im oberen Teil: links/rechts daneben erscheint der Pin, wenn er zur Seite kippt
        if (z >= 0.3 * PIN_H && z <= 0.95 * PIN_H && (!span.length || span[span.length - 1][0] !== row)) span.push([row, a, b]);
        for (let x = a; x <= b; x++) {
          const k = row * cw + x; full.add(k);
          if (z >= this.o.pinZLow * PIN_H && z <= PIN_H * 0.96) meas.add(k);
        }
      }
      geo[id] = { dist, full, meas, span };
    }
    return geo;
  }

  _lum(crop) {
    const n = crop.width * crop.height, L = new Float32Array(n), d = crop.data;
    for (let i = 0, j = 0; i < n; i++, j += 4) L[i] = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
    return L;
  }

  _measurePins(crop) {
    const cam = this.cam;
    const geo = this._pinGeometry(cam, crop);
    this.pinMeas.push({ L: this._lum(crop), geo, w: crop.width, h: crop.height });
  }

  // ---- Pin-Verlauf ----
  // Jeder Pin hat eine feste Gruppe von 3D-Messpunkten (oberer Teil + links/rechts daneben). Sie werden in jedem Bild
  // über die aktuelle Kamera abgetastet; so stört die Handbewegung nicht. Weicht das Muster deutlich vom Referenzbild ab,
  // bewegt sich der Pin. Unten misst es nicht: dort verdeckt die Kugel die Pins.
  _sig(m, id, ou = 0, ov = 0) {
    const { w, h } = this.ref, r = m.rect, cw = m.w, ch = m.h, L = m.L;
    const sx = cw / (r.w * w), sy = ch / (r.h * h);
    const [X, Y] = PINS[id], [cxp, cyp] = m.cam.camPos;
    const dx = X - cxp, dy = Y - cyp, dist = Math.hypot(dx, dy), px = -dy / dist, py = dx / dist;
    const v = [], pix = [];
    for (const zf of PT_Z) for (const lf of PT_L) {
      const o = lf * 0.06, [u0, v0] = m.cam.P(X + px * o, Y + py * o, zf * PIN_H);
      const u = (u0 + 0.5 - r.x * w) * sx - 0.5 + ou, vv = (v0 + 0.5 - r.y * h) * sy - 0.5 + ov;
      const x0 = Math.floor(u), y0 = Math.floor(vv);
      if (x0 < 0 || y0 < 0 || x0 >= cw - 1 || y0 >= ch - 1) { v.push(NaN); pix.push(-1); continue; }
      const fx = u - x0, fy = vv - y0, k = y0 * cw + x0;
      v.push((L[k] * (1 - fx) + L[k + 1] * fx) * (1 - fy) + (L[k + cw] * (1 - fx) + L[k + cw + 1] * fx) * fy);
      pix.push(Math.round(vv) * cw + Math.round(u));
    }
    return { v, pix };
  }
  _trackPins(crop, ts) {
    const ref = this.pinRef;
    if (!ref.cam) return;
    if (!this._ptRef) {
      const before = PIN_IDS.filter(p => this.pinsBefore.includes(p));
      const order = before.slice().sort((a, b) => ref.geo[a].dist - ref.geo[b].dist);
      const sig = {};
      for (const id of order) {
        const s = this._sig(ref, id);
        // Punkte, die im Referenzbild von näheren Pins verdeckt sind, nicht verwenden
        // (mit Rand: fallende nähere Pins kippen in diesen Bereich hinein)
        const near = order.filter(q => q !== id && ref.geo[q].dist < ref.geo[id].dist).map(q => ref.geo[q]);
        const ok = s.v.map((x, i) => Number.isFinite(x) && !near.some(g => nearPin(g, s.pix[i], ref.w)));
        const vals = s.v.filter((_, i) => ok[i]);
        const mean = vals.reduce((a, x) => a + x, 0) / (vals.length || 1);
        const c = Math.sqrt(vals.reduce((a, x) => a + (x - mean) ** 2, 0) / (vals.length || 1));
        if (vals.length >= PT_MIN && c >= 8) sig[id] = { v: s.v, ok, c };
      }
      this._ptRef = { sig };
    }
    const m = { L: this._lum(crop), cam: this.cam, rect: crop.rect, w: crop.width, h: crop.height };
    const smp = { t: ts, d: {}, side: {} };
    for (const [id, R] of Object.entries(this._ptRef.sig)) {
      // kleine Lagefehler der Kamera (Handbewegung) ausgleichen: beste Verschiebung um bis zu ±PT_SH Pixel
      let best = null;
      for (let ov = -PT_SH; ov <= PT_SH; ov++) for (let ou = -PT_SH; ou <= PT_SH; ou++) {
        const s = this._sig(m, +id, ou, ov);
        const diff = [];
        for (let i = 0; i < s.v.length; i++) if (R.ok[i] && Number.isFinite(s.v[i])) diff.push([i, s.v[i] - R.v[i]]);
        if (diff.length < PT_MIN) continue;
        // gleichmäßige Helligkeitsänderung (Belichtung) abziehen
        const med = diff.map(x => x[1]).sort((a, b) => a - b)[diff.length >> 1];
        let D = 0, l = 0, nl = 0, rr = 0, nr = 0;
        for (const [i, x] of diff) {
          const y = x - med, lf = PT_L[i % PT_L.length];
          D += Math.abs(y);
          if (lf < -0.7) { l += y; nl++; } else if (lf > 0.7) { rr += y; nr++; }
        }
        D /= diff.length * R.c;
        if (!best || D < best.D) best = { D, side: ((nr ? rr / nr : 0) - (nl ? l / nl : 0)) / R.c };
      }
      if (!best) continue;
      smp.d[id] = best.D; smp.side[id] = best.side;
    }
    this.pinSeries.push(smp);
  }
  // Fallbeginn (s ab Einschlag), Kipprichtung (-1 links, 0 nach hinten, 1 rechts) und Sicherheit je Pin
  _pinTimeline(standingAfter) {
    const o = this.o, t0 = this.tImpact, after = new Set(standingAfter || []);
    const fv = this.track.length > 8 ? this._fitVel(this.track, 8) : null;
    const vb = fv && fv.vy > 2 ? fv.vy : 7.5;
    const out = {};
    for (const id of this.pinsBefore) {
      const ser = this.pinSeries.filter(s => s.d[id] != null).map(s => [s.t, s.d[id], s.side[id]]);
      if (ser.length < 6) continue;
      const d = ser.map((_, i) => { const w = ser.slice(Math.max(0, i - 1), i + 2).map(x => x[1]).sort((a, b) => a - b); return w[w.length >> 1]; });
      const pre = d.filter((_, i) => ser[i][0] < t0 - 0.05).sort((a, b) => a - b);
      const noise = pre.length ? pre[Math.floor(pre.length * 0.8)] : 0.1, noiseMed = pre.length ? pre[pre.length >> 1] : 0.05;
      const thr = Math.max(PT_THR, noise * 2.5);
      if (after.has(id)) { out[id] = { stand: true, conf: +Math.min(1, Math.max(0, 1 - noise / PT_THR)).toFixed(2) }; continue; }
      // frühestens, wenn die Kugel (oder ein Pin vor ihm) ihn erreicht haben kann
      const tMin = t0 + Math.max(-0.08, (PINS[id][1] - o.impactY - 0.3) / vb - 0.06);
      let tc = null, hold = 0;
      for (let i = 1; i < d.length; i++) {
        if (ser[i][0] < tMin || d[i] < thr) continue;
        // muss sich weiter unterscheiden (kurze Verdeckung zählt nicht)
        const rest = d.filter((_, k) => k > i && ser[k][0] <= ser[i][0] + 0.1);
        if (rest.some(v => v < thr * 0.7)) continue;
        hold = rest.length;
        // zurück bis zum Beginn des Anstiegs (Bewegungsbeginn statt Schwellenübertritt)
        const base = Math.max(noiseMed * 1.5, thr * 0.45);
        let k = i;
        while (k > 0 && d[k - 1] > base && ser[k - 1][0] >= tMin && ser[i][0] - ser[k - 1][0] < 0.12) k--;
        const a = k > 0 ? d[k - 1] : base, b = d[k];
        tc = (k > 0 ? ser[k - 1][0] : ser[0][0]) + (b > a ? Math.min(1, Math.max(0, (base - a) / (b - a))) : 1) * (k > 0 ? ser[k][0] - ser[k - 1][0] : 0);
        break;
      }
      if (tc == null) continue;
      const win = ser.filter(x => x[0] >= tc && x[0] <= tc + 0.15);
      const sd = win.length ? win.reduce((a, x) => a + x[2], 0) / win.length : 0;
      const conf = Math.min(1, Math.max(0, 1 - noise / thr)) * (hold >= 2 ? 1 : 0.5);
      out[id] = { t: +(tc - o.pinTrackLag - t0).toFixed(3), dir: Math.abs(sd) > PT_SIDE ? Math.sign(sd) : 0, conf: +conf.toFixed(2) };
    }
    // Drei oder mehr Pins ändern sich im selben Bild: eher etwas davor (Person, Hand, Schwenk) als echte Fallbewegung
    const fl = Object.values(out).filter(m => m.t != null);
    for (const m of fl) {
      if (fl.filter(q => Math.abs(q.t - m.t) <= 0.012).length >= 3) m.conf = +(m.conf * 0.4).toFixed(2);
    }
    return out;
  }

  _decidePins() {
    const o = this.o;
    const before = new Set(this.pinsBefore);
    const ref = this.pinRef;
    const order = PIN_IDS.filter(p => before.has(p)).sort((a, b) => this.pinMeas[0].geo[a].dist - this.pinMeas[0].geo[b].dist);
    // Schwelle: aus Referenz (Pins weiß vs. Hintergrund), sonst Otsu
    const thrOf = (m, standingSet) => {
      if (o.pinLumThr > 0) return o.pinLumThr;
      const inPin = new Uint8Array(m.L.length);
      for (const id of standingSet) for (const k of m.geo[id].meas) inPin[k] = 1;
      const pv = [], bv = [];
      for (let k = 0; k < m.L.length; k++) (inPin[k] ? pv : bv).push(m.L[k]);
      if (pv.length < 10 || bv.length < 10) return otsu(m.L);
      pv.sort((a, b) => a - b); bv.sort((a, b) => a - b);
      const Lp = pv[Math.floor(pv.length * 0.75)], Lb = bv[Math.floor(bv.length * 0.5)];
      return Lp - Lb > 25 ? Lb + 0.5 * (Lp - Lb) : otsu(m.L);
    };
    const refThr = ref ? thrOf(ref, order) : null;
    const standing = new Set();
    const detail = {};
    for (const id of order) {
      // sichtbare Messpixel: ohne Pixel stehender näherer Pins
      const ratios = [], abss = [], refs = [];
      let vis = 0, total = 0;
      for (const m of this.pinMeas) {
        const g = m.geo[id];
        total = g.meas.size;
        const thr = refThr ?? thrOf(m, [...before]);
        let cnt = 0, white = 0;
        for (const k of g.meas) {
          let occ = false;
          for (const s of standing) if (m.geo[s].dist < g.dist && m.geo[s].full.has(k)) { occ = true; break; }
          if (occ) continue;
          cnt++; if (m.L[k] > thr) white++;
        }
        vis = cnt;
        let refFrac = 1;
        if (ref) {
          const rg = ref.geo[id]; let rc = 0, rw = 0;
          for (const k of rg.meas) {
            let occ = false;
            for (const s of standing) if (ref.geo[s].dist < rg.dist && ref.geo[s].full.has(k)) { occ = true; break; }
            if (occ) continue;
            rc++; if (ref.L[k] > refThr) rw++;
          }
          refFrac = rc ? Math.max(0.2, rw / rc) : 1;
        }
        if (cnt) { ratios.push((white / cnt) / refFrac); abss.push(white / cnt); refs.push(refFrac); }
      }
      ratios.sort((a, b) => a - b);
      const ratio = ratios.length ? ratios[ratios.length >> 1] : 0;
      let state;
      if (vis < Math.max(4, total * 0.12)) state = o.pinOccluded === 'down' ? 'hidden-down' : 'hidden';
      else {
        // schwache Referenz (Messfeld lag vor dem Wurf neben dem Pin): nicht hochrechnen, sondern absolut urteilen
        const md = (a) => a.length ? [...a].sort((p, q) => p - q)[a.length >> 1] : 0;
        const weakRef = ref && md(refs) < o.pinRefMin;
        state = (weakRef ? md(abss) >= o.pinAbsMin : ratio >= o.pinRatio) ? 'standing' : 'down';
      }
      if (state === 'standing' || state === 'hidden') standing.add(id);
      const md = (a) => a.length ? [...a].sort((p, q) => p - q)[a.length >> 1] : 0;
      detail[id] = { state, ratio: +ratio.toFixed(2), vis, abs: +md(abss).toFixed(2), ref: +md(refs).toFixed(2) };
    }
    return { standing: PIN_IDS.filter(p => standing.has(p)), detail };
  }

  _newKey(w, h) {
    const o = this.o, ref = this.ref;
    const pts = detectFeatures(this.pyr[0], o.features);
    if (pts.length < 20) return;
    const Hg = inv(mul(this.T, ref.Href));
    if (!Hg) return;                       // Lage gerade nicht umkehrbar: altes Schlüsselbild behalten
    const plane = pts.map(([x, y]) => {
      const ww = Hg[6] * x + Hg[7] * y + Hg[8]; if (ww <= 0) return 0;
      const X = (Hg[0] * x + Hg[1] * y + Hg[2]) / ww, Y = (Hg[3] * x + Hg[4] * y + Hg[5]) / ww;
      return X > -o.planeMargin && X < LANE_W + o.planeMargin && Y > -4 && Y < HEADPIN_Y - 0.5 ? 1 : 0;
    });
    // Pyramide kopieren (wird im nächsten Bild überschrieben)
    const pyr = this.pyr.map(l => ({ w: l.w, h: l.h, d: l.d.slice() }));
    this.key = { pts, plane, tpls: makeTemplates(pyr, pts, o.lkRadius), M: this.T.slice() };
    this.keyCount = (this.keyCount || 0) + 1;
    void w; void h;
  }

  // Ende der Quelle (Videodatei): laufenden Wurf noch abschließen
  flush(t) {
    const ev = [], ts = t / 1000;
    if (this.state === 'roll' && this.track.length >= 8 && this.track[this.track.length - 1][2] - this.track[0][2] > 6) this._impact(ev);
    if (this.state === 'settle') this._finish(ts, ev);
    return ev;
  }

  // ---- Haupteinstieg ----
  // frame: {data,width,height}; t in ms; crop: {data,width,height,rect} | null
  process(frame, t, crop) {
    const ev = [];
    if (!this.ref) return { state: 'nocal', events: ev };
    const o = this.o;
    if (frame.width !== this.ref.w || frame.height !== this.ref.h || this._needRecal) {
      this.calibrate(frame, this.ref.corners, { noSnap: true });
      ev.push({ type: 'recal' });
    }
    const ts = t / 1000;
    const { width: w, height: h } = frame;
    let ok = true;
    if (o.trackMode === 'hand') {
      this.gray = toGray(frame.data, w, h, this.gray);
      this.pyr = buildPyramid(this.gray, w, h, this.ref.tpls[0] ? this.ref.tpls[0].length : o.lkLevels, this.pyr);
      const ref = this.ref;
      // Schlüsselbild: Merkmale stammen aus key, M bildet Referenzbild -> Schlüsselbild ab
      const key = this.key || (this.key = { pts: ref.pts, plane: ref.plane, tpls: ref.tpls, M: new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]) });
      const Mi = inv(key.M);
      const fitK = (key, pred) => {
        const res = trackLK(this.pyr, key.tpls, pred, o.lkRadius, o.lkIters, o.lkMaxErr);
        const s = [], d = [];
        res.forEach((r, i) => { if (r) { s.push(key.pts[i]); d.push([r[0], r[1]]); } });
        const R = s.length >= 8 ? ransacHomography(s, d, o.ransacPx, 100) : null;
        if (!R || R.count < Math.max(8, key.pts.length * 0.15)) return null;
        // zweite Stufe: nur Inlier auf der Bahnebene (keine Parallaxe)
        if (o.planeFeatures) {
          const ps = [], pd = [];
          let k = 0;
          res.forEach((r, i) => { if (r) { if (R.inliers[k] && key.plane[i]) { ps.push(key.pts[i]); pd.push([r[0], r[1]]); } k++; } });
          if (ps.length >= o.planeMin) {
            const R2 = ransacHomography(ps, pd, o.ransacPx * 0.75, 60);
            if (R2 && R2.count >= o.planeMin) return { ...R2, count: R.count, tracked: s.length, plane: R2.count };
          }
        }
        return { ...R, tracked: s.length };
      };
      const fit = (pred) => fitK(key, pred);
      // Vorhersage mit Bewegung der letzten Bilder (schnelle Schwenks)
      const Tk = mul(this.T, Mi), Tkp = this.Tprev ? mul(this.Tprev, Mi) : Tk;
      let pred = key.pts.map(p => { const a = apply(Tk, p[0], p[1]), b = apply(Tkp, p[0], p[1]); return [a[0] + 0.7 * (a[0] - b[0]), a[1] + 0.7 * (a[1] - b[1])]; });
      let R = fit(pred);
      if (!R) R = fit(key.pts.map(p => apply(Tk, p[0], p[1])));
      if (!R) {
        const [sx, sy] = coarseShift(this.pyr, key.tpls, pred, 8);
        R = fit(pred.map(p => [p[0] + sx, p[1] + sy]));
      }
      if (R) {
        const Tn = mul(R.H, key.M);
        // Plausibilität: Bahnecken dürfen nicht springen
        const Hn = mul(Tn, ref.Href), Ho = mul(this.T, ref.Href);
        let jump = 0;
        for (const [X, Y] of [[0, 0], [LANE_W, 0], [0, HEADPIN_Y], [LANE_W, HEADPIN_Y]]) {
          const a = apply(Hn, X, Y), b = apply(Ho, X, Y); jump = Math.max(jump, Math.hypot(a[0] - b[0], a[1] - b[1]));
        }
        if (jump < 0.25 * w || this.lost > 3) {
          this.Tprev = this.T; this.T = Tn; this.quality = R.count / key.pts.length; this.lost = 0;
          // Gegen Drift: auch direkt mit dem Referenzbild der Einrichtung vergleichen. Passt es, dort neu verankern
          // (Fehler aus der Kette von Schlüsselbildern, z. B. nach einem Ruckler, summieren sich so nicht auf).
          if (o.refAnchor && key.pts !== ref.pts && this.frameN % o.refAnchorEvery === 0) {
            const RA = fitK(ref, ref.pts.map(p => apply(this.T, p[0], p[1])));
            if (RA && RA.plane >= o.planeMin && RA.count >= Math.max(15, ref.pts.length * 0.25)) {
              const Ha = mul(RA.H, ref.Href), Hc = mul(this.T, ref.Href);
              let dmax = 0;
              for (const [X, Y] of [[0, 0], [LANE_W, 0], [0, HEADPIN_Y], [LANE_W, HEADPIN_Y]]) {
                const a = apply(Ha, X, Y), b = apply(Hc, X, Y); dmax = Math.max(dmax, Math.hypot(a[0] - b[0], a[1] - b[1]));
              }
              if (dmax < 0.08 * w) {
                this.T = RA.H; this.anchored = (this.anchored || 0) + 1;
                if (RA.count / ref.pts.length >= o.keyQ && this.state !== 'roll') this.key = null;   // Kette neu ab Referenz
              }
            }
          }
          // neues Schlüsselbild, wenn das alte nicht mehr gut passt (Schwenk, Verdeckung, Licht)
          if (o.refRefresh && this.quality < o.keyQ && R.count >= 12 && this.state !== 'roll') this._newKey(w, h);
        } else { ok = false; this.lost++; }
      } else { ok = false; this.lost++; this.quality = 0; this.Tprev = null; }
    } else { this.quality = 1; }
    this.H = mul(this.T, this.ref.Href);
    this.cam = cameraFromH(this.H, w, h, this.f);
    this.frameN++;

    // Pins: Ausschnitt verarbeiten
    if (crop && o.pinsEnabled) {
      if (this.state === 'idle') {
        this.pinRefCand = { L: this._lum(crop), geo: this._pinGeometry(this.cam, crop), w: crop.width, h: crop.height, cam: this.cam, rect: crop.rect };
        this.lastPinRefT = ts;
      } else {
        if (this._wantTrack(ts)) this._trackPins(crop, ts);
        if (this.state === 'settle' && ts >= this.tPinAt) this._measurePins(crop);
      }
    }

    let cands = [], active = 0;
    if (ok || o.trackMode === 'tripod') {
      this._rectify(frame, this.H);
      active = this._foreground();
      cands = this._candidates(this._blobs());
    } else if (this.state === 'roll' && this.lost > 20) { ev.push({ type: 'abort', t: ts }); this.resetShot(); }
    this._stateStep(cands, ts, ev);

    const { w: rw, h: rh } = this.ref;
    const S = new Float64Array([1 / rw, 0, 0.5 / rw, 0, 1 / rh, 0.5 / rh, 0, 0, 1]);
    const ball = this.state === 'roll' && this.lastSeen === ts ? this.track[this.track.length - 1] : null;
    // Messwerte für die Auto-Optimierung (alle 5 Bilder): Bewegung, Rauschen, Helligkeit, Bahnbreite am Pin
    let metrics = null;
    if (this.frameN % 5 === 0) {
      const hp = (X) => apply(this.H, X, HEADPIN_Y), a = hp(0), b = hp(LANE_W);
      const laneFarPx = Math.hypot(b[0] - a[0], b[1] - a[1]);
      let motion = 0;
      if (this._lastHm) for (const [X, Y] of [[0, 0], [LANE_W, 0], [0, HEADPIN_Y], [LANE_W, HEADPIN_Y]]) {
        const p1 = apply(this.H, X, Y), p0 = apply(this._lastHm, X, Y); motion = Math.max(motion, Math.hypot(p1[0] - p0[0], p1[1] - p0[1]));
      }
      this._lastHm = this.H;
      let noise = 0, nn = 0, lum = 0, nl = 0;
      if (this.grid) { const g = this.grid; for (let k = 0; k < g.n; k += 37) if (g.valid[k] && g.age[k] > 10) { noise += g.dev[k]; nn++; } }
      const d = frame.data; for (let i = 0; i < d.length; i += 4 * 97) { lum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; nl++; }
      metrics = { laneFarPx, motion: motion / 5, noise: nn ? noise / nn : 0, lum: nl ? lum / nl : 0, w };
    }
    const res = {
      state: this.state, ok, quality: this.quality, lost: this.lost, active, metrics,
      H: Array.from(mul(S, this.H)), f: this.f / w,
      ball: ball ? { x: ball[1], y: ball[2], u: this.itrack[this.itrack.length - 1][1], v: this.itrack[this.itrack.length - 1][2] } : null,
      cands: cands.slice(0, 6).map(c => [(c.u + 0.5) / rw, (c.v + 0.5) / rh]),
      trail: this.state === 'roll' ? this.itrack.slice(-60).map(p => [p[1], p[2]]) : null,
      events: ev,
    };
    if (o.debug && this.grid && this.frameN % 3 === 0) {
      const g = this.grid; const m = new Uint8Array(g.n);
      for (let k = 0; k < g.n; k++) m[k] = !g.valid[k] ? 0 : g.fg[k] ? (g.col[k] ? 3 : 2) : 1;
      res.debug = { nx: g.nx, ny: g.ny, mask: m };
    }
    return res;
  }
}

function otsu(L) {
  const hist = new Float64Array(256);
  for (let i = 0; i < L.length; i++) hist[Math.min(255, Math.max(0, L[i] | 0))]++;
  let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sB = 0, wB = 0, best = 0, thr = 128; const total = L.length;
  for (let i = 0; i < 256; i++) {
    wB += hist[i]; if (!wB) continue; const wF = total - wB; if (!wF) break;
    sB += i * hist[i]; const mB = sB / wB, mF = (sum - sB) / wF;
    const v = wB * wF * (mB - mF) ** 2; if (v > best) { best = v; thr = i; }
  }
  return thr;
}
