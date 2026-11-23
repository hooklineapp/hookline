// Pin-Simulation für das Replay: einfache 2D-Physik von oben (Kugel + 10 Pins als Scheiben, elastische Stöße, Reibung).
// Das Ergebnis wird an die gemessenen stehenden Pins angepasst. Gibt es einen gemessenen Pin-Verlauf (shot.pinTrack:
// Fallbeginn und Kipprichtung je Pin), werden viele Varianten gerechnet und die passendste genommen; sicher gemessene
// Fallzeiten ersetzen dann die berechneten (Mischung aus Messung und Simulation).
import { PINS, PIN_IDS, HEADPIN_Y, PIT_Y, LANE_W, BALL_R, GUTTER_W } from './lane.js';
import { interpX } from './analysis.js';

const PIN_R = 0.06, M_BALL = 7.0, M_PIN = 1.55, E_PP = 0.55, E_BP = 0.65;
const HIT_V = 0.6;          // ab dieser Geschwindigkeit (m/s) fällt ein Pin
const DT = 0.0015, DUR = 1.4, STEP_OUT = 0.01;
const CONF_USE = 0.7, CONF_SET = 0.7;   // ab dieser Sicherheit: Messung fließt ein / ersetzt die Simulation

// seeded Zufall, damit das gleiche Replay gleich aussieht
function rng(seed) { let s = seed >>> 0 || 1; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }

// ein Simulationslauf; P: Abweichungen vom gemessenen Kugelweg und Stoßzahlen
function run(shot, an, P, record) {
  const before = new Set(shot.pinsBefore || PIN_IDS);
  const after = shot.pinsAfter ? new Set(shot.pinsAfter) : null;
  const rnd = rng(P.seed);
  // Kugel kurz vor den Pins starten (y0 entspricht dem Einschlag-Zeitpunkt der Messung), Richtung aus dem Laufweg
  const y0 = HEADPIN_Y - 0.45;
  const x0 = interpX(an.path, y0) + P.dx, x1 = interpX(an.path, HEADPIN_Y) + P.dx;
  const dir = Math.atan2(x1 - x0, HEADPIN_Y - y0) + P.dang;
  const v = Math.max(3, an.speedImpact || an.speedAvg || 7.5) * P.vf;
  const ball = { x: x0, y: y0, vx: v * Math.sin(dir), vy: v * Math.cos(dir), r: BALL_R, m: M_BALL };
  const pins = {};
  for (const id of PIN_IDS) if (before.has(id)) pins[id] = { id, x: PINS[id][0], y: PINS[id][1], vx: 0, vy: 0, r: PIN_R, m: M_PIN, fall: -1, fdir: 0, static: false };
  // Pins, die laut Messung stehen geblieben sind, nehmen nicht an Stößen teil (die Simulation soll das Ergebnis zeigen)
  if (after) for (const id of after) if (pins[id]) pins[id].static = true;
  const bodies = Object.values(pins);
  const frames = [];
  let tOut = 0;
  const collide = (a, b, e) => {
    const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy), min = a.r + b.r;
    if (d >= min || d < 1e-6) return false;
    const nx = dx / d, ny = dy / d;
    const rv = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
    // überlappung auflösen
    const push = (min - d) / 2;
    a.x -= nx * push; a.y -= ny * push; b.x += nx * push; b.y += ny * push;
    if (rv > 0) return true;
    const j = -(1 + e) * rv / (1 / a.m + 1 / b.m);
    a.vx -= j * nx / a.m; a.vy -= j * ny / a.m; b.vx += j * nx / b.m; b.vy += j * ny / b.m;
    // etwas Streuung: Pins drehen und springen nicht perfekt
    const k = P.scat * Math.abs(rv);
    b.vx += (rnd() - 0.5) * k; b.vy += (rnd() - 0.5) * k * 0.5;
    return true;
  };
  for (let t = 0; t <= DUR + 1e-9; t += DT) {
    ball.x += ball.vx * DT; ball.y += ball.vy * DT;
    for (const p of bodies) {
      if (p.static) continue;
      if (collide(ball, p, P.ebp) && p.fall < 0 && Math.hypot(p.vx, p.vy) > HIT_V) { p.fall = t; p.fdir = Math.atan2(p.vx, p.vy); }
    }
    for (let i = 0; i < bodies.length; i++) for (let k = i + 1; k < bodies.length; k++) {
      const a = bodies[i], b = bodies[k];
      if (a.static || b.static) continue;
      if (collide(a, b, P.epp)) {
        for (const p of [a, b]) if (p.fall < 0 && Math.hypot(p.vx, p.vy) > HIT_V) { p.fall = t; p.fdir = Math.atan2(p.vx, p.vy); }
      }
    }
    for (const p of bodies) {
      if (p.static) continue;
      p.x += p.vx * DT; p.y += p.vy * DT;
      // Reibung: liegende Pins rutschen und bremsen stark
      const f = p.fall >= 0 ? Math.exp(-2.2 * DT) : Math.exp(-6 * DT);
      p.vx *= f; p.vy *= f;
      // Seitenwände / Grube
      const wl = -GUTTER_W - 0.05, wr = LANE_W + GUTTER_W + 0.05;
      if (p.x < wl) { p.x = wl; p.vx = Math.abs(p.vx) * 0.4; }
      if (p.x > wr) { p.x = wr; p.vx = -Math.abs(p.vx) * 0.4; }
      if (p.y > PIT_Y + 0.15) { p.vy *= 0.3; p.pit = true; }
    }
    if (ball.y > PIT_Y + 0.4) { ball.vx = 0; ball.vy = 0; ball.pit = true; }
    if (record && t >= tOut - 1e-9) {
      frames.push({ t, ball: { x: ball.x, y: ball.y, pit: !!ball.pit },
        pins: Object.fromEntries(bodies.map(p => [p.id, { x: p.x, y: p.y, fall: p.fall, fdir: p.fdir, pit: !!p.pit }])) });
      tOut += STEP_OUT;
    }
  }
  return { frames, fall: Object.fromEntries(bodies.map(p => [p.id, { t: p.fall, dir: p.fdir }])), after, rnd };
}

// Abweichung eines Laufs von der Messung (mittlerer quadratischer Zeitfehler + kleine Strafen)
function score(res, meas, P) {
  let e = 0, n = 0;
  for (const [id, m] of Object.entries(meas)) {
    if (m.stand || m.t == null || m.conf < CONF_USE) continue;
    const f = res.fall[id], w = m.conf;
    if (!f) continue;
    if (f.t < 0) e += w * 0.25 ** 2;
    else {
      const dt = Math.max(-0.25, Math.min(0.25, f.t - m.t));
      e += w * dt * dt;
      if (m.dir && Math.abs(f.dir) > 0.3 && Math.sign(f.dir) !== m.dir) e += w * 0.03 ** 2;
    }
    n += w;
  }
  // gemessen gefallen, in der Simulation aber stehend: leicht bestrafen (sonst kippen sie nur „von selbst“)
  if (res.after) for (const [id, f] of Object.entries(res.fall)) if (!res.after.has(+id) && f.t < 0) e += 0.3 * 0.1 ** 2;
  // Vorwissen: Messung des Kugelwegs ist gut, große Abweichungen unwahrscheinlich
  const prior = (P.dx / 0.05) ** 2 + (P.dang / 0.035) ** 2 + ((P.vf - 1) / 0.15) ** 2;
  return e / Math.max(1, n) + 0.0004 * prior;
}

export function simulatePins(shot, an, opts = {}) {
  if (!an || !an.path?.length) return null;
  const base = Math.round((an.entryBoard || 17) * 1000) + (shot.t || 0) % 100000;
  let P = { dx: 0, dang: 0, vf: 1, epp: E_PP, ebp: E_BP, scat: 0.18, seed: base };
  const meas = opts.mix !== false && shot.pinTrack ? shot.pinTrack : null;
  const used = meas ? Object.values(meas).filter(m => !m.stand && m.t != null && m.conf >= CONF_USE).length : 0;
  let fit = null;
  if (used) {
    // Suche: erst breit streuen, dann um die beste Variante verfeinern
    const r = rng(base ^ 0x5bd1e995);
    const U = (a, b) => a + (b - a) * r();
    let best = P, bestE = score(run(shot, an, P, false), meas, P);
    const tryP = (Q) => { const e = score(run(shot, an, Q, false), meas, Q); if (e < bestE) { bestE = e; best = Q; } };
    for (let i = 0; i < (opts.tries ?? 50); i++) tryP({ dx: U(-0.06, 0.06), dang: U(-0.04, 0.04), vf: U(0.85, 1.15), epp: U(0.4, 0.72), ebp: U(0.5, 0.8), scat: U(0.05, 0.3), seed: (r() * 4294967296) >>> 0 });
    for (let i = 0; i < (opts.refine ?? 25); i++) {
      const b = best;
      tryP({ dx: b.dx + U(-0.015, 0.015), dang: b.dang + U(-0.01, 0.01), vf: b.vf + U(-0.04, 0.04), epp: Math.min(0.8, Math.max(0.3, b.epp + U(-0.05, 0.05))), ebp: Math.min(0.85, Math.max(0.4, b.ebp + U(-0.05, 0.05))), scat: Math.max(0, b.scat + U(-0.04, 0.04)), seed: i % 3 ? b.seed : (r() * 4294967296) >>> 0 });
    }
    P = best;
    fit = { used, rms: 0 };
  }
  const res = run(shot, an, P, true);
  const { frames, after, rnd } = res;
  const src = {};
  for (const id of Object.keys(res.fall)) src[id] = 'sim';
  // sicher gemessene Fallzeiten und Richtungen übernehmen
  if (meas) {
    let se = 0, n = 0;
    for (const [id, m] of Object.entries(meas)) {
      if (!frames[0]?.pins[id]) continue;
      if (m.stand) { src[id] = 'mess'; continue; }
      if (m.t == null || m.conf < CONF_USE) continue;
      const f = res.fall[id];
      if (f && f.t >= 0) { se += (f.t - m.t) ** 2; n++; }
      if (m.conf < CONF_SET) continue;
      const tf = Math.max(0, m.t);
      let fd = f && f.t >= 0 ? f.dir : 0;
      if (m.dir && (Math.abs(fd) < 0.2 || Math.sign(fd) !== m.dir)) fd = m.dir * 0.7;
      for (const fr of frames) { const p = fr.pins[id]; if (fr.t >= tf) { p.fall = tf; p.fdir = fd; } else p.fall = -1; }
      src[id] = 'mess';
    }
    if (fit) fit.rms = n ? +Math.sqrt(se / n).toFixed(3) : null;
  }
  // Pins, die laut Messung gefallen sind, in der Simulation aber nicht: spät durch Nachbarschaft umfallen lassen
  if (after) {
    const last = frames[frames.length - 1];
    for (const id of Object.keys(last.pins)) {
      if (after.has(+id)) continue;
      if (last.pins[id].fall >= 0) continue;
      const tf = 0.25 + rnd() * 0.35, fd = (rnd() - 0.5) * 2.4;
      for (const fr of frames) if (fr.t >= tf) { fr.pins[id].fall = tf; fr.pins[id].fdir = fd; }
    }
  }
  const measured = Object.values(src).filter(s => s === 'mess').length;
  return { frames, dur: DUR, simulated: true, mixed: measured > 0, measured, src, fit };
}

// Zustand zur Zeit t (Sekunden ab Start der Simulation) mit Kippwinkel (0 = steht, 1 = liegt)
export function simAt(sim, t) {
  const f = sim.frames;
  const i = Math.max(0, Math.min(f.length - 1, Math.round(t / STEP_OUT)));
  const fr = f[i];
  const pins = {};
  for (const [id, p] of Object.entries(fr.pins)) {
    const tilt = p.fall < 0 || t < p.fall ? 0 : Math.min(1, (t - p.fall) / 0.28);
    pins[id] = { ...p, tilt: tilt * tilt * (3 - 2 * tilt) };
  }
  return { ball: fr.ball, pins };
}
