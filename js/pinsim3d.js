// 3D-Pinsimulation mit der eigenen Physik (js/pinphys.js): Kugel startet rollend mit gemessenem Tempo und Richtung
// (plus Anpassung der 2D-Simulation an die Messung); optional bleiben gemessen stehende Pins fest.
import { PIN_IDS, HEADPIN_Y, BALL_R } from './lane.js';
import { interpX } from './analysis.js';
import { createWorld, step, tilt, PHYS } from './pinphys.js';

// Lage je Körper: [x, y, z, qx, qy, qz, qw] (Schwerpunkt)
const pose = (b) => [b.p[0], b.p[1], b.p[2], b.q[0], b.q[1], b.q[2], b.q[3]];

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
  if (sim === first) return first;
  sim.kicked = kicks.map(k => k.id); sim.ms = ms;
  return sim;
}

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
