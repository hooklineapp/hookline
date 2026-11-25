// 3D-Pinsimulation mit der eigenen Physik (js/pinphys.js): Kugel startet rollend mit gemessenem Tempo und Richtung
// (plus Anpassung der 2D-Simulation an die Messung); optional bleiben gemessen stehende Pins fest.
import { PIN_IDS, HEADPIN_Y, BALL_R } from './lane.js';
import { interpX } from './analysis.js';
import { createWorld, step, tilt, PHYS, PIN_ZC } from './pinphys.js';

// Lage je Körper: [x, y, z, qx, qy, qz, qw] (Schwerpunkt)
const pose = (b) => [b.p[0], b.p[1], b.p[2], b.q[0], b.q[1], b.q[2], b.q[3]];

// Physik im Rahmen halten: einzelne Kontakte können Energie erzeugen (Pins flogen sonst über 100 m).
// Pins fliegen real höchstens wenige Meter: Tempo begrenzen, nicht über die Abdeckung und nicht weit zurück
// Richtung Spieler.
function tame(W) {
  for (const b of [...Object.values(W.pins), W.ball]) {
    if (b.fixed) continue;
    const v = Math.hypot(...b.v), vm = b === W.ball ? 12 : 9;
    if (v > vm) b.v = b.v.map(x => x * vm / v);
    const w = Math.hypot(...b.w);
    if (w > 70) b.w = b.w.map(x => x * 70 / w);
    if (b.p[2] > 0.9 && b.v[2] > 0) b.v[2] = 0;
    if (b.p[1] < HEADPIN_Y - 1.2 && b.v[1] < 0) b.v[1] = 0;
  }
}

export function simulatePins3D(shot, an, params = {}, opts = {}) {
  if (!an || !an.path?.length) return null;
  const t0 = performance.now();
  const before = (shot.pinsBefore || PIN_IDS).slice();
  const after = shot.pinsAfter ? new Set(shot.pinsAfter) : null;
  const y0 = HEADPIN_Y - 0.45;
  const dx0 = params.dx || 0, dang = params.dang || 0, vf = params.vf || 1;
  const x0 = interpX(an.path, y0) + dx0, x1 = interpX(an.path, HEADPIN_Y) + dx0;
  const dir = Math.atan2(x1 - x0, HEADPIN_Y - y0) + dang;
  const v = Math.max(3, an.speedImpact || an.speedAvg || 7.5) * vf;
  const dx = Math.sin(dir), dy = Math.cos(dir);
  // rollend: ω = (v·dy, −v·dx, 0)/R; dazu etwas Seitendrall (Hook) um die Hochachse ist für Stöße unerheblich
  const W = createWorld({
    phys: opts.phys,
    ball: { p: [x0, y0, BALL_R], v: [v * dx, v * dy, 0], w: [v * dy / BALL_R, -v * dx / BALL_R, 0] },
    pins: before, fixed: opts.predict ? null : after,
  });
  W.kicks = opts.kicks || null;
  const P = W.P, frames = [], falls = {};
  let tOut = 0;
  const steps = Math.round((opts.dur || P.dur) / P.dt);
  for (let k = 0; k <= steps; k++) {
    if (W.t >= tOut - 1e-9) {
      const fr = { t: W.t, ball: pose(W.ball), pins: {} };
      for (const [id, b] of Object.entries(W.pins)) {
        fr.pins[id] = pose(b);
        if (falls[id] == null && tilt(b.q) > 0.17) falls[id] = W.t;     // > 10°: Pin beginnt zu fallen
      }
      if (opts.record !== false) frames.push(fr);
      tOut += P.out;
    }
    step(W);
    tame(W);
  }
  const standing = Object.entries(W.pins).filter(([, b]) => tilt(b.q) < 0.6 && b.p[2] > 0).map(([id]) => +id).sort((a, b) => a - b);
  return { frames, dur: opts.dur || P.dur, three: true, falls, standing, ms: Math.round(performance.now() - t0) };
}

// Mit Messung: gemessen stehende Pins fest; gemessen gefallene, die die Physik nicht umwirft, bekommen zum
// Zeitpunkt aus 2D-Simulation/Messung einen Stoß in Fallrichtung (zweiter Durchgang).
export function simulateMeasured3D(shot, an, params, falls2d = {}, opts = {}) {
  const first = simulatePins3D(shot, an, params, opts);
  if (!first || !shot.pinsAfter) return first;
  const after = new Set(shot.pinsAfter), kicks = [];
  // Mit Stößen läuft das Abräumen etwas anders: dann kann ein anderer, gemessen gefallener Pin stehen bleiben.
  // Darum nachstoßen, bis alle gemessen gefallenen Pins liegen (höchstens 4 Durchgänge).
  let sim = first, ms = first.ms;
  for (let pass = 0; pass < 4; pass++) {
    let added = 0;
    for (const id of shot.pinsBefore || PIN_IDS) {
      if (after.has(id) || !sim.standing.includes(id) || kicks.some(k => k.id === id)) continue;
      const f = falls2d[id] || {}, t = f.t >= 0 ? f.t : 0.35, d = f.dir || 0;
      kicks.push({ id, t, h: 0.3, J: [Math.sin(d) * 0.75, Math.cos(d) * 0.75, 0] }); added++;
    }
    if (!added) {   // schon gestoßen und steht trotzdem: kräftiger stoßen
      const still = kicks.filter(k => sim.standing.includes(k.id));
      if (!still.length) break;
      still.forEach(k => { k.J = k.J.map(v => v * 1.6); k.t = Math.max(0, k.t - 0.05); });
    }
    sim = simulatePins3D(shot, an, params, { ...opts, kicks: kicks.map(k => ({ ...k, J: [...k.J] })) }); ms += sim.ms;
  }
  if (sim !== first) { sim.kicked = kicks.map(k => k.id); sim.ms = ms; }
  // Was die Physik trotzdem nicht umwirft, kippt sichtbar um: Das Replay zeigt immer genau das gemessene Ergebnis.
  const forced = (shot.pinsBefore || PIN_IDS).filter(id => !after.has(id) && sim.standing.includes(id));
  if (forced.length && sim.frames.length) {
    const fk = falls2d || {};
    for (const id of forced) {
      const d = fk[id]?.dir || 0, t0 = Math.max(0.15, fk[id]?.t >= 0 ? fk[id].t : 0.35), dur = 0.35;
      const dx = Math.sin(d), dy = Math.cos(d), ax = [-dy, dx, 0];
      const f0 = sim.frames.find(f => f.t >= t0) || sim.frames[sim.frames.length - 1];
      const st = f0.pins[id];
      const base = [st[0], st[1], st[2] - PIN_ZC], q0 = st.slice(3);
      for (const f of sim.frames) {
        if (f.t < t0) continue;
        const u = Math.min(1, (f.t - t0) / dur), a = (Math.PI / 2) * u * u;   // beschleunigt kippen
        const qf = [ax[0] * Math.sin(a / 2), ax[1] * Math.sin(a / 2), 0, Math.cos(a / 2)];
        const q = qmul(qf, q0);
        const r = 0.06 * Math.sin(a);   // liegend ruht der Pin auf seinem Bauch
        f.pins[id] = [base[0] + dx * PIN_ZC * Math.sin(a), base[1] + dy * PIN_ZC * Math.sin(a), base[2] + PIN_ZC * Math.cos(a) + r, ...q];
      }
    }
    sim.standing = sim.standing.filter(id => !forced.includes(id));
    sim.forced = forced;
  }
  return sim;
}

const qmul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];

export { tilt };
export const STEP_OUT = PHYS.out;

export function sim3dAt(sim, t) {
  const f = sim.frames;
  const x = Math.max(0, Math.min(f.length - 1.001, t / STEP_OUT));
  const i = Math.floor(x), a = x - i, A = f[i], B = f[Math.min(f.length - 1, i + 1)];
  const mix = (p, q) => {
    const o = p.slice(0, 3).map((v, k) => v + (q[k] - v) * a);
    const d = p[3] * q[3] + p[4] * q[4] + p[5] * q[5] + p[6] * q[6], s = d < 0 ? -1 : 1;
    const r = [3, 4, 5, 6].map(k => p[k] + (s * q[k] - p[k]) * a), n = Math.hypot(...r) || 1;
    return [...o, ...r.map(v => v / n)];
  };
  const pins = {};
  for (const id of Object.keys(A.pins)) pins[id] = mix(A.pins[id], B.pins[id]);
  return { ball: mix(A.ball, B.ball), pins };
}

// Im Worker rechnen (Promise); ohne Worker-Unterstützung direkt
let worker = null, seq = 0;
const waiting = new Map();
export function simulate3DAsync(shot, an, params, falls) {
  const plain = (o) => JSON.parse(JSON.stringify(o));
  if (typeof Worker === 'undefined') return Promise.resolve(simulateMeasured3D(shot, an, params, falls));
  if (!worker) {
    worker = new Worker(new URL('./sim3d-worker.js?v=' + (globalThis.BT_VERSION || ''), import.meta.url), { type: 'module' });
    worker.onmessage = (e) => { const w = waiting.get(e.data.id); if (w) { waiting.delete(e.data.id); e.data.ok ? w.res(e.data.sim) : w.rej(new Error(e.data.error)); } };
  }
  const id = ++seq;
  return new Promise((res, rej) => { waiting.set(id, { res, rej }); worker.postMessage({ id, shot: plain(shot), an: plain(an), params: plain(params || {}), falls: plain(falls || {}) }); });
}
