// Schlanke 3D-Starrkörperphysik für Kugel und Pins (ohne Bibliothek). Pins sind Starrkörper aus einer Kette von
// Kugeln entlang des Normprofils plus Standfuß-Punkten; Stöße mit sequentiellen Impulsen (Stoßzahl, Coulomb-Reibung),
// Drehimpuls mit Trägheitstensor. Umgebung: Bahn/Pindeck, flache Rinnen, Seitenbleche (Kickbacks), Grube, Rückwand.
// Werte: Pin 1,53 kg (USBC 1,53–1,64 kg), Schwerpunkt 13,5 cm, Kugel 7 kg; Stoßzahl flache Rinne 0,37–0,66
// (USBC Pin Carry Study 2009).
import { PINS, PIN_IDS, HEADPIN_Y, PIT_Y, LANE_W, BALL_R, GUTTER_W, PIN_H } from './lane.js';

// Pinprofil (Höhe, Radius) in Metern
export const PIN_PROFILE = [[0, 0.0285], [0.03, 0.04], [0.0635, 0.0475], [0.114, 0.0605], [0.165, 0.0575],
  [0.22, 0.04], [0.27, 0.0225], [0.30, 0.025], [0.33, 0.031], [0.36, 0.027], [0.381, 0.0]];

export const PHYS = {
  dt: 1 / 600, dur: 1.6, iters: 8, out: 0.01,
  mPin: 1.55, mBall: 7.0,
  eBallPin: 0.65, ePinPin: 0.55, eFloor: 0.25, eWall: 0.55, eGutter: 0.45, eBack: 0.1,
  muBallPin: 0.12, muPinPin: 0.15, muFloor: 0.22, muBallFloor: 0.18, muWall: 0.3,
  sideX: GUTTER_W + 0.06,           // Seitenbleche: Abstand vom Bahnrand
  backY: PIT_Y + 1.1,                // Rückwand (Vorhang)
  rollDamp: 0.4, slop: 0.0015, beta: 0.25,
};

// Kollisionskugeln eines Pins (Höhe über Fuß, Radius) und Standfuß-Ring
const PIN_SPH = [[0.032, 0.040], [0.075, 0.052], [0.118, 0.059], [0.165, 0.056], [0.212, 0.043], [0.262, 0.024], [0.305, 0.026], [0.345, 0.029]];
const FOOT = Array.from({ length: 6 }, (_, k) => [Math.cos(k * Math.PI / 3) * 0.026, Math.sin(k * Math.PI / 3) * 0.026, 0]);

// Masse, Schwerpunkt und Trägheit aus dem Profil (gleichmäßige Dichte, Drehkörper)
function pinInertia(m) {
  let V = 0, zc = 0;
  const sl = [];
  for (let i = 1; i < PIN_PROFILE.length; i++) {
    const [z0, r0] = PIN_PROFILE[i - 1], [z1, r1] = PIN_PROFILE[i];
    for (let k = 0; k < 20; k++) {
      const z = z0 + (z1 - z0) * (k + 0.5) / 20, r = r0 + (r1 - r0) * (k + 0.5) / 20, dz = (z1 - z0) / 20;
      const v = Math.PI * r * r * dz; V += v; zc += v * z; sl.push([z, r, v]);
    }
  }
  zc /= V;
  let Iz = 0, Ix = 0;
  for (const [z, r, v] of sl) { const dm = m * v / V; Iz += dm * r * r / 2; Ix += dm * (r * r / 4 + (z - zc) ** 2); }
  // Echte Pins haben im Bauch Hohlräume: Schwerpunkt laut Norm ~13,5 cm (5 5/16 Zoll, zulässig etwa 13,0–14,5 cm)
  // über dem Boden statt ~15 cm bei voller Dichte. Trägheit bleibt die des vollen Profils um seinen Schwerpunkt.
  return { zc: 0.135, Ix, Iz, zcSolid: zc };
}
const PIN_I = pinInertia(1.55);

// ---- kleine Vektor-/Quaternion-Helfer
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function qrot(q, v) { // q = [x,y,z,w]
  const [x, y, z, w] = q, tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + y * tz - z * ty, v[1] + w * ty + z * tx - x * tz, v[2] + w * tz + x * ty - y * tx];
}
function qint(q, w, dt) { // Quaternion mit Winkelgeschwindigkeit integrieren
  const [x, y, z, s] = q, h = 0.5 * dt;
  const n = [x + h * (w[0] * s + w[1] * z - w[2] * y), y + h * (w[1] * s + w[2] * x - w[0] * z), z + h * (w[2] * s + w[0] * y - w[1] * x), s - h * (w[0] * x + w[1] * y + w[2] * z)];
  const l = Math.hypot(...n); return n.map(v => v / l);
}

class Body {
  constructor(kind, pos, mass, inertia, q = [0, 0, 0, 1]) {
    this.kind = kind; this.p = pos; this.v = [0, 0, 0]; this.w = [0, 0, 0]; this.q = q;
    this.m = mass; this.im = mass ? 1 / mass : 0; this.Ib = inertia; this.fixed = !mass;
  }
  // inverse Trägheit in Weltkoordinaten angewendet auf Vektor
  invI(v) {
    if (this.fixed) return [0, 0, 0];
    const qc = [-this.q[0], -this.q[1], -this.q[2], this.q[3]];
    const b = qrot(qc, v); const r = [b[0] / this.Ib[0], b[1] / this.Ib[1], b[2] / this.Ib[2]];
    return qrot(this.q, r);
  }
  velAt(r) { const c = cross(this.w, r); return [this.v[0] + c[0], this.v[1] + c[1], this.v[2] + c[2]]; }
  impulse(J, r) {
    if (this.fixed) return;
    this.v[0] += J[0] * this.im; this.v[1] += J[1] * this.im; this.v[2] += J[2] * this.im;
    const dw = this.invI(cross(r, J)); this.w[0] += dw[0]; this.w[1] += dw[1]; this.w[2] += dw[2];
  }
}

// Kollisionsgeometrie eines Körpers in Weltkoordinaten: Kugeln [x,y,z,r,rx,ry,rz] (r* = Hebel vom Schwerpunkt)
function spheres(b) {
  if (b.kind === 'ball') return [[b.p[0], b.p[1], b.p[2], BALL_R, 0, 0, 0]];
  const out = [];
  for (const [h, r] of PIN_SPH) { const o = qrot(b.q, [0, 0, h - PIN_I.zc]); out.push([b.p[0] + o[0], b.p[1] + o[1], b.p[2] + o[2], r, o[0], o[1], o[2]]); }
  return out;
}
function footPts(b) {
  return FOOT.map(f => { const o = qrot(b.q, [f[0], f[1], -PIN_I.zc]); return [b.p[0] + o[0], b.p[1] + o[1], b.p[2] + o[2], o]; });
}

// Kontakt lösen (Normalimpuls mit Stoßzahl als Zielgeschwindigkeit, Reibung begrenzt)
function makeContact(a, b, n, ra, rb, depth, e, mu) {
  const va = a.velAt(ra), vb = b ? b.velAt(rb) : [0, 0, 0];
  const rv = [va[0] - vb[0], va[1] - vb[1], va[2] - vb[2]];
  const vn = dot(rv, n);
  const kN = (rr, bd, nn) => { if (!bd || bd.fixed) return 0; const c = bd.invI(cross(rr, nn)); return bd.im + dot(cross(c, rr), nn); };
  const mN = 1 / (kN(ra, a, n) + kN(rb, b, n));
  // Tangenten
  const t1 = Math.abs(n[2]) < 0.9 ? cross(n, [0, 0, 1]) : cross(n, [1, 0, 0]); const l1 = Math.hypot(...t1); t1[0] /= l1; t1[1] /= l1; t1[2] /= l1;
  const t2 = cross(n, t1);
  return { a, b, n, ra, rb, depth, e, mu, mN, t1, t2, mT1: 1 / (kN(ra, a, t1) + kN(rb, b, t1)), mT2: 1 / (kN(ra, a, t2) + kN(rb, b, t2)),
    bounce: vn < -0.4 ? -e * vn : 0, jn: 0, jt1: 0, jt2: 0 };
}
function solve(c, dt) {
  const { a, b, n } = c;
  const va = a.velAt(c.ra), vb = b ? b.velAt(c.rb) : [0, 0, 0];
  const rv = [va[0] - vb[0], va[1] - vb[1], va[2] - vb[2]];
  // normal: Ziel = Rückprall + Eindringkorrektur
  const bias = Math.max(c.bounce, PHYS.beta / dt * Math.max(0, c.depth - PHYS.slop));
  let dj = c.mN * (bias - dot(rv, n));
  const j0 = c.jn; c.jn = Math.max(0, j0 + dj); dj = c.jn - j0;
  const J = [n[0] * dj, n[1] * dj, n[2] * dj];
  a.impulse(J, c.ra); if (b) b.impulse([-J[0], -J[1], -J[2]], c.rb);
  // Reibung
  for (const [t, key, mT] of [[c.t1, 'jt1', c.mT1], [c.t2, 'jt2', c.mT2]]) {
    const va2 = a.velAt(c.ra), vb2 = b ? b.velAt(c.rb) : [0, 0, 0];
    const vt = dot([va2[0] - vb2[0], va2[1] - vb2[1], va2[2] - vb2[2]], t);
    let d = -vt * mT; const lim = c.mu * c.jn, o = c[key];
    c[key] = Math.max(-lim, Math.min(lim, o + d)); d = c[key] - o;
    const T = [t[0] * d, t[1] * d, t[2] * d];
    a.impulse(T, c.ra); if (b) b.impulse([-T[0], -T[1], -T[2]], c.rb);
  }
}

// Bodenhöhe an (x, y): Bahn/Deck/flache Rinnen auf 0, Grube tiefer
// Rinnen liegen ~5 cm tiefer (Kugel in der Rinne läuft an den Pins vorbei)
const floorZ = (x, y) => (y > PIT_Y ? -0.35 : (x < -0.01 || x > LANE_W + 0.01) ? -0.05 : 0);

export function createWorld(opts) {
  const P = { ...PHYS, ...(opts.phys || {}) };
  const bodies = [];
  const ball = new Body('ball', [...opts.ball.p], P.mBall, [0.4 * P.mBall * BALL_R ** 2, 0.4 * P.mBall * BALL_R ** 2, 0.4 * P.mBall * BALL_R ** 2]);
  ball.v = [...opts.ball.v]; ball.w = [...opts.ball.w];
  bodies.push(ball);
  const pins = {};
  const Ip = [PIN_I.Ix * P.mPin / 1.55, PIN_I.Ix * P.mPin / 1.55, PIN_I.Iz * P.mPin / 1.55];
  for (const id of opts.pins) {
    const fixed = opts.fixed?.has(id);
    const b = new Body('pin', [PINS[id][0], PINS[id][1], PIN_I.zc], fixed ? 0 : P.mPin, Ip, [0, 0, Math.sin(id * 0.7), Math.cos(id * 0.7)]);
    b.id = id; pins[id] = b; bodies.push(b);
  }
  return { P, bodies, ball, pins, t: 0 };
}

export function step(W) {
  const { P, bodies } = W, dt = P.dt;
  // geplante Anstöße: { id, t, J: [x,y,z], h: Höhe über Fuß }
  if (W.kicks) for (const k of W.kicks) if (!k.done && W.t >= k.t && W.pins[k.id]) {
    const b = W.pins[k.id]; b.impulse(k.J, qrot(b.q, [0, 0, k.h - PIN_I.zc])); k.done = true;
  }
  // Schwerkraft
  for (const b of bodies) if (!b.fixed) b.v[2] -= 9.81 * dt;
  // Kontakte sammeln
  const C = [];
  const sph = bodies.map(spheres);
  for (let i = 0; i < bodies.length; i++) {
    const a = bodies[i];
    // Boden: Kugeln (liegender Pin, Kugel) und Standfuß
    const muF = a.kind === 'ball' ? P.muBallFloor : P.muFloor;
    for (const s of sph[i]) {
      const fz = floorZ(s[0], s[1]), d = fz + s[3] - s[2];
      if (d > 0) C.push(makeContact(a, null, [0, 0, 1], [s[4], s[5], s[6] - s[3]], null, d, P.eFloor, muF));
    }
    if (a.kind === 'pin') for (const f of footPts(a)) {
      const d = floorZ(f[0], f[1]) - f[2];
      if (d > 0) C.push(makeContact(a, null, [0, 0, 1], f[3], null, d, P.eFloor, P.muFloor));
    }
    // Seitenbleche, Rückwand (nur im hinteren Bereich)
    for (const s of sph[i]) {
      if (s[1] > HEADPIN_Y - 0.6) {
        const xl = -P.sideX, xr = LANE_W + P.sideX;
        if (s[0] - s[3] < xl && s[2] < 0.6) C.push(makeContact(a, null, [1, 0, 0], [s[4] - s[3], s[5], s[6]], null, xl - (s[0] - s[3]), P.eWall, P.muWall));
        if (s[0] + s[3] > xr && s[2] < 0.6) C.push(makeContact(a, null, [-1, 0, 0], [s[4] + s[3], s[5], s[6]], null, s[0] + s[3] - xr, P.eWall, P.muWall));
      }
      if (s[1] + s[3] > P.backY) C.push(makeContact(a, null, [0, -1, 0], [s[4], s[5] + s[3], s[6]], null, s[1] + s[3] - P.backY, P.eBack, 0.5));
    }
    // Körper untereinander (grober Test über Abstand der Schwerpunkte)
    for (let k = i + 1; k < bodies.length; k++) {
      const b = bodies[k];
      if (a.fixed && b.fixed) continue;
      const dx = a.p[0] - b.p[0], dy = a.p[1] - b.p[1], dz = a.p[2] - b.p[2];
      if (dx * dx + dy * dy + dz * dz > 0.36) continue;   // > 0,6 m: kein Kontakt möglich
      const ball = a.kind === 'ball' || b.kind === 'ball';
      const e = ball ? P.eBallPin : P.ePinPin, mu = ball ? P.muBallPin : P.muPinPin;
      for (const s of sph[i]) for (const u of sph[k]) {
        const ex = s[0] - u[0], ey = s[1] - u[1], ez = s[2] - u[2], d2 = ex * ex + ey * ey + ez * ez, rr = s[3] + u[3];
        if (d2 >= rr * rr || d2 < 1e-12) continue;
        const d = Math.sqrt(d2), n = [ex / d, ey / d, ez / d];
        C.push(makeContact(a, b, n, [s[4] - n[0] * s[3], s[5] - n[1] * s[3], s[6] - n[2] * s[3]], [u[4] + n[0] * u[3], u[5] + n[1] * u[3], u[6] + n[2] * u[3]], rr - d, e, mu));
      }
    }
  }
  for (let it = 0; it < P.iters; it++) for (const c of C) solve(c, dt);
  // integrieren, leichte Roll-/Drehdämpfung
  for (const b of bodies) {
    if (b.fixed) continue;
    b.p[0] += b.v[0] * dt; b.p[1] += b.v[1] * dt; b.p[2] += b.v[2] * dt;
    b.q = qint(b.q, b.w, dt);
    if (b.kind === 'pin') { const f = Math.exp(-P.rollDamp * dt); b.w = b.w.map(v => v * f); }
  }
  W.t += dt;
  return C.length;
}

// Neigung der Pinachse (0 = steht, π/2 = liegt)
export const tilt = (q) => Math.acos(Math.max(-1, Math.min(1, 1 - 2 * (q[0] * q[0] + q[1] * q[1]))));
// Fußpunkt (Pinmitte unten) und Achse für Darstellung
export function pinPose(b) { const a = qrot(b.q, [0, 0, 1]); return { base: [b.p[0] - a[0] * PIN_I.zc, b.p[1] - a[1] * PIN_I.zc, b.p[2] - a[2] * PIN_I.zc], axis: a, q: [...b.q] }; }
export const PIN_ZC = PIN_I.zc;
export { PIN_H };
