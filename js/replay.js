// Replay ohne Video: Draufsicht oder rekonstruierte Kamerasicht aus gespeicherten Bahnpunkten.
import { LANE_W, GUTTER_W, HEADPIN_Y, PIT_Y, BOARD_W, PINS, PIN_IDS, ARROWS, DOTS, BALL_R, PIN_H, xOfBoard } from './lane.js';
import { cameraFromH, mul } from './vision/geometry.js';
import { interpX } from './analysis.js';

const COL = { lane: '#e9cf9f', lane2: '#dcbd86', board: 'rgba(120,80,30,.16)', gutter: '#8b9099', cap: '#c9ced6', deck: '#f2e3c4',
  pit: '#2b2f36', approach: '#f3e2bd', foul: '#c0392b', arrow: '#6b4a22', path: '#e4572e', cmp: 'rgba(40,60,90,.28)', ball: '#2f6fed', bp: '#16a34a' };

function pinRadiusAt(z) { // vereinfachtes Profil für Zeichnung
  const t = z / PIN_H;
  if (t < 0.3) return 0.03 + 0.1 * t;
  if (t < 0.55) return 0.06 - 0.12 * (t - 0.3);
  if (t < 0.72) return 0.03 - 0.04 * (t - 0.55);
  if (t < 0.92) return 0.03;
  return 0.03 * (1 - (t - 0.92) / 0.08);
}

export class Replay {
  constructor(canvas) {
    this.c = canvas; this.ctx = canvas.getContext('2d');
    this.p = 1; this.playing = false; this.speed = 1; this.mode = 'top'; this.exag = 4; this.hand = 'R';
    this.cmp = [];
    this._raf = 0;
  }
  set(shot, an, opts = {}) {
    this.shot = shot; this.an = an; Object.assign(this, opts);
    const pts = (shot.points || []).slice().sort((a, b) => a[0] - b[0]);
    this.pts = pts;
    this.t0 = shot.tStart ?? (pts[0] ? pts[0][0] : 0);
    this.t1 = shot.tImpact ?? (pts.length ? pts[pts.length - 1][0] : 1);
    if (!(this.t1 > this.t0)) this.t1 = this.t0 + 2.5;
    this.p = opts.p ?? 1;
    this.draw();
  }
  yAt(t) { // Kugel-Y zur Zeit t, linear zwischen Messpunkten, Rand linear verlängert
    const p = this.pts; if (!p.length) return 0;
    if (t <= p[0][0]) { const v = this.an?.speedRelease || 8; return Math.max(0, p[0][2] - v * (p[0][0] - t)); }
    for (let i = 1; i < p.length; i++) if (p[i][0] >= t) { const a = p[i - 1], b = p[i]; return a[2] + (b[2] - a[2]) * (t - a[0]) / (b[0] - a[0] || 1); }
    const v = this.an?.speedImpact || 7; const l = p[p.length - 1]; return Math.min(HEADPIN_Y, l[2] + v * (t - l[0]));
  }
  play() {
    if (this.playing) return;
    if (this.p >= 1) this.p = 0;
    this.playing = true;
    let last = performance.now();
    const dur = (this.t1 - this.t0) + 1.2; // +Pins
    const step = (now) => {
      if (!this.playing) return;
      this.p = Math.min(1, this.p + (now - last) / 1000 * this.speed / dur); last = now;
      this.draw(); this.onprogress?.(this.p);
      if (this.p >= 1) { this.playing = false; this.onend?.(); return; }
      this._raf = requestAnimationFrame(step);
    };
    this._raf = requestAnimationFrame(step);
  }
  pause() { this.playing = false; cancelAnimationFrame(this._raf); }
  seek(p) { this.p = Math.max(0, Math.min(1, p)); this.draw(); }

  _fit() {
    const c = this.c, dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return [w, h];
  }

  draw() {
    if (!this.shot) return;
    const [w, h] = this._fit();
    const ctx = this.ctx;
    ctx.clearRect(0, 0, w, h);
    if (this.mode === 'camera' && this.shot.cam) this._drawCam(w, h);
    else this._drawTop(w, h);
  }

  _state() {
    const dur = (this.t1 - this.t0) + 1.2;
    const t = this.t0 + this.p * dur;
    const rolling = t <= this.t1;
    const y = rolling ? this.yAt(t) : HEADPIN_Y;
    const path = this.an?.path || [];
    const x = path.length ? interpX(path, y) : LANE_W / 2;
    const pinsFallen = !rolling;
    return { t, y, x, rolling, pinsFallen, fade: Math.min(1, (t - this.t1) / 0.6) };
  }

  // ---------- Draufsicht ----------
  _drawTop(w, h) {
    const ctx = this.ctx;
    const horiz = w > h * 1.4;
    const L = PIT_Y + 0.35, Wd = LANE_W + 2 * GUTTER_W + 0.1;
    const pad = 10;
    const len = (horiz ? w : h) - 2 * pad, wid = (horiz ? h : w) - 2 * pad;
    const sy = len / (L + 0.6);
    const sx = Math.min(wid / Wd, sy * this.exag);
    // Weltpunkt -> Bildschirm
    const P = horiz
      ? (x, y) => [pad + (y + 0.5) * sy, h / 2 + (x - LANE_W / 2) * sx]
      : (x, y) => [w / 2 + (x - LANE_W / 2) * sx, h - pad - (y + 0.5) * sy];
    const rect = (x0, y0, x1, y1, fill) => {
      const a = P(x0, y0), b = P(x1, y1);
      ctx.fillStyle = fill; ctx.fillRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
    };
    rect(-GUTTER_W - 0.05, -0.5, LANE_W + GUTTER_W + 0.05, 0, COL.approach);
    rect(-GUTTER_W - 0.05, 0, LANE_W + GUTTER_W + 0.05, PIT_Y, COL.cap);
    rect(-GUTTER_W, 0, 0, PIT_Y, COL.gutter);
    rect(LANE_W, 0, LANE_W + GUTTER_W, PIT_Y, COL.gutter);
    rect(0, 0, LANE_W, PIT_Y, COL.lane);
    rect(0, HEADPIN_Y - 0.6, LANE_W, PIT_Y, COL.deck);
    rect(-GUTTER_W - 0.05, PIT_Y, LANE_W + GUTTER_W + 0.05, PIT_Y + 0.35, COL.pit);
    // Bretter
    ctx.lineWidth = 1;
    for (let b = 1; b < 39; b++) {
      const x = b * BOARD_W; const a = P(x, 0), c = P(x, HEADPIN_Y - 0.6);
      ctx.strokeStyle = b % 5 === 0 ? 'rgba(120,80,30,.32)' : COL.board;
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(c[0], c[1]); ctx.stroke();
    }
    rect(0, -0.012, LANE_W, 0.012, COL.foul);
    // Pfeile + Punkte
    ctx.fillStyle = COL.arrow;
    for (const a of ARROWS) {
      const x = xOfBoard(a.b, 'R'); const tip = P(x, a.y), l = P(x - BOARD_W * 0.6, a.y - 0.35), r = P(x + BOARD_W * 0.6, a.y - 0.35);
      ctx.beginPath(); ctx.moveTo(...tip); ctx.lineTo(...l); ctx.lineTo(...r); ctx.fill();
    }
    for (const d of DOTS) { const p = P(xOfBoard(d.b, 'R'), d.y); ctx.beginPath(); ctx.arc(p[0], p[1], 1.8, 0, 7); ctx.fill(); }
    // Vergleichswürfe
    ctx.lineWidth = 1.5; ctx.strokeStyle = COL.cmp;
    for (const an of this.cmp) if (an?.path) this._poly(an.path, P);
    const st = this._state();
    const path = this.an?.path || [];
    // Laufweg bis aktueller Position
    if (path.length) {
      ctx.lineWidth = 3; ctx.strokeStyle = COL.path; ctx.lineCap = 'round';
      this._poly(path.filter(p => p[0] <= st.y + 0.01), P);
    }
    // Breakpoint
    const bp = this.an?.breakpoint;
    if (bp && st.y >= bp.y) {
      const p = P(interpX(path, bp.y), bp.y);
      ctx.fillStyle = COL.bp; ctx.beginPath(); ctx.arc(p[0], p[1], 5, 0, 7); ctx.fill();
    }
    // Pins
    this._pinsTop(P, sx, sy, st);
    // Kugel
    if (st.rolling) {
      const p = P(st.x, st.y);
      const r = Math.max(4, BALL_R * Math.min(sx, sy * 3));
      ctx.fillStyle = this.ballColor || COL.ball; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(p[0], p[1], r, 0, 7); ctx.fill(); ctx.stroke();
    }
  }
  _poly(path, P) {
    const ctx = this.ctx; if (path.length < 2) return;
    ctx.beginPath();
    path.forEach(([y, x], i) => { const p = P(x, y); i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]); });
    ctx.stroke();
  }
  _pinsTop(P, sx, sy, st) {
    const ctx = this.ctx;
    const before = new Set(this.shot.pinsBefore || PIN_IDS);
    const after = this.shot.pinsAfter ? new Set(this.shot.pinsAfter) : null;
    const r = Math.max(3.5, 0.06 * Math.min(sx, sy * 3));
    for (const id of PIN_IDS) {
      const [x, y] = PINS[id]; const p = P(x, y);
      let standing = before.has(id);
      let alpha = 1;
      if (st.pinsFallen && after && standing && !after.has(id)) { alpha = 1 - 0.75 * st.fade; standing = st.fade < 1; }
      ctx.globalAlpha = before.has(id) ? alpha : 0.25;
      ctx.beginPath(); ctx.arc(p[0], p[1], r, 0, 7);
      ctx.fillStyle = standing ? '#fff' : '#cfd4dc'; ctx.fill();
      ctx.strokeStyle = standing ? '#c0392b' : '#9aa1ab'; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  // ---------- Kamerasicht ----------
  _drawCam(w, h) {
    const ctx = this.ctx, cam = this.shot.cam;
    // Bildfläche im Seitenverhältnis der Aufnahme einpassen
    const ar = cam.aspect || 16 / 9;
    let vw = w, vh = w / ar; if (vh > h) { vh = h; vw = h * ar; }
    const ox = (w - vw) / 2, oy = (h - vh) / 2;
    const Hs = mul(new Float64Array([vw, 0, ox, 0, vh, oy, 0, 0, 1]), new Float64Array(cam.H));
    // Kamera aus Homografie, f im Zielmaßstab, Hauptpunkt = Mitte des Bildfelds
    const C = cameraFromH(mul(new Float64Array([1, 0, -ox, 0, 1, -oy, 0, 0, 1]), Hs), vw, vh, cam.f * vw);
    const P = (X, Y, Z = 0) => { const p = C.P(X, Y, Z); return [p[0] + ox, p[1] + oy, p[2]]; };
    ctx.save();
    ctx.beginPath(); ctx.rect(ox, oy, vw, vh); ctx.clip();
    const g = ctx.createLinearGradient(0, oy, 0, oy + vh); g.addColorStop(0, '#3a3f48'); g.addColorStop(1, '#5a606b');
    ctx.fillStyle = g; ctx.fillRect(ox, oy, vw, vh);
    const quad = (x0, y0, x1, y1, fill, z = 0) => {
      const pts = [P(x0, y0, z), P(x1, y0, z), P(x1, y1, z), P(x0, y1, z)];
      if (pts.some(p => p[2] <= 0.05)) return;
      ctx.fillStyle = fill; ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])); ctx.closePath(); ctx.fill();
    };
    const yNear = Math.max(-4, C.camPos[1] + 0.8);
    for (const off of [-1.4, 1.4]) { // Nachbarbahnen angedeutet
      quad(off + 0 - GUTTER_W, yNear, off + LANE_W + GUTTER_W, PIT_Y, '#9a8d74');
      quad(off, 0, off + LANE_W, HEADPIN_Y, '#c9b28a');
    }
    quad(-GUTTER_W - 0.06, yNear, LANE_W + GUTTER_W + 0.06, 0, COL.approach);
    quad(-GUTTER_W - 0.06, 0, LANE_W + GUTTER_W + 0.06, PIT_Y, COL.cap);
    quad(-GUTTER_W, 0, 0, PIT_Y, COL.gutter);
    quad(LANE_W, 0, LANE_W + GUTTER_W, PIT_Y, COL.gutter);
    quad(0, 0, LANE_W, PIT_Y, COL.lane);
    quad(0, HEADPIN_Y - 0.6, LANE_W, PIT_Y, COL.deck);
    quad(-GUTTER_W - 0.06, PIT_Y, LANE_W + GUTTER_W + 0.06, PIT_Y + 1.2, COL.pit);
    quad(-1.6, PIT_Y + 1.2, LANE_W + 1.6, PIT_Y + 1.25, '#1d2127');
    ctx.lineWidth = 0.6; ctx.strokeStyle = COL.board;
    for (let b = 1; b < 39; b++) { const a = P(b * BOARD_W, Math.max(0, yNear)), c = P(b * BOARD_W, HEADPIN_Y - 0.6); ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(c[0], c[1]); ctx.stroke(); }
    quad(0, -0.012, LANE_W, 0.012, COL.foul);
    ctx.fillStyle = COL.arrow;
    for (const a of ARROWS) {
      const x = xOfBoard(a.b, 'R'); const pts = [P(x, a.y), P(x - BOARD_W * 0.6, a.y - 0.35), P(x + BOARD_W * 0.6, a.y - 0.35)];
      ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])); ctx.fill();
    }
    const st = this._state();
    const path = this.an?.path || [];
    ctx.strokeStyle = COL.cmp; ctx.lineWidth = 1.2;
    for (const an of this.cmp) if (an?.path) this._polyCam(an.path, P);
    ctx.strokeStyle = COL.path; ctx.lineWidth = 2.5; ctx.lineCap = 'round';
    this._polyCam(path.filter(p => p[0] <= st.y + 0.01), P);
    // Pins (hinten zuerst) + Kugel nach Tiefe sortiert
    const before = new Set(this.shot.pinsBefore || PIN_IDS);
    const after = this.shot.pinsAfter ? new Set(this.shot.pinsAfter) : null;
    const items = PIN_IDS.filter(id => before.has(id)).map(id => ({ id, d: P(...PINS[id])[2] }));
    if (st.rolling) items.push({ ball: true, d: P(st.x, st.y, BALL_R)[2] });
    items.sort((a, b) => b.d - a.d);
    for (const it of items) {
      if (it.ball) {
        const c = P(st.x, st.y, BALL_R); const r = BALL_R * C.f / c[2];
        ctx.fillStyle = this.ballColor || COL.ball; ctx.beginPath(); ctx.arc(c[0], c[1], Math.max(2, r), 0, 7); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,.35)'; ctx.beginPath(); ctx.arc(c[0] - r * 0.3, c[1] - r * 0.35, Math.max(1, r * 0.3), 0, 7); ctx.fill();
        continue;
      }
      const [X, Y] = PINS[it.id];
      let a = 1;
      if (st.pinsFallen && after && !after.has(it.id)) a = 1 - st.fade;
      if (a <= 0.02) continue;
      ctx.globalAlpha = a;
      const steps = 14; const L = [], R = [];
      for (let s = 0; s <= steps; s++) {
        const z = PIN_H * s / steps, p = P(X, Y, z), r = pinRadiusAt(z) * C.f / p[2];
        L.push([p[0] - r, p[1]]); R.push([p[0] + r, p[1]]);
      }
      ctx.fillStyle = '#fbfbf8'; ctx.strokeStyle = 'rgba(0,0,0,.25)'; ctx.lineWidth = 0.6;
      ctx.beginPath(); L.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])); R.reverse().forEach(p => ctx.lineTo(p[0], p[1])); ctx.closePath(); ctx.fill(); ctx.stroke();
      const n = P(X, Y, PIN_H * 0.7), rn = 0.032 * C.f / n[2];
      ctx.fillStyle = '#d33'; ctx.fillRect(n[0] - rn, n[1] - Math.max(0.6, rn * 0.25), 2 * rn, Math.max(0.8, rn * 0.35));
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }
  _polyCam(path, P) {
    const ctx = this.ctx; if (path.length < 2) return;
    ctx.beginPath(); let started = false;
    for (const [y, x] of path) { const p = P(x, y, 0.002); if (p[2] <= 0.05) continue; started ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]); started = true; }
    ctx.stroke();
  }
}

// kleine statische Mini-Bahn (für Listen)
export function miniLane(canvas, an, opts = {}) {
  const r = new Replay(canvas);
  r.exag = opts.exag || 5; r.cmp = opts.cmp || [];
  r.set({ points: [], pinsBefore: opts.pinsBefore || PIN_IDS, pinsAfter: opts.pinsAfter || null, tStart: 0, tImpact: 1 }, an, { p: 1 });
  return r;
}
