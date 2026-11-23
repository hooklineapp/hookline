// Pin-Simulation für das Replay (keine Messung!): einfache 2D-Physik von oben (Kugel + 10 Pins als Scheiben,
// elastische Stöße, Reibung). Ergebnis wird an die gemessenen stehenden Pins angepasst.
import { PINS, PIN_IDS, HEADPIN_Y, PIT_Y, LANE_W, BALL_R, GUTTER_W } from './lane.js';
import { interpX } from './analysis.js';

const PIN_R = 0.06, M_BALL = 7.0, M_PIN = 1.55, E_PP = 0.55, E_BP = 0.65;
const HIT_V = 0.6;          // ab dieser Geschwindigkeit (m/s) fällt ein Pin
const DT = 0.0015, DUR = 1.4, STEP_OUT = 0.01;

// seeded Zufall, damit das gleiche Replay gleich aussieht
function rng(seed) { let s = seed >>> 0 || 1; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }

export function simulatePins(shot, an) {
  if (!an || !an.path?.length) return null;
  const before = new Set(shot.pinsBefore || PIN_IDS);
  const after = shot.pinsAfter ? new Set(shot.pinsAfter) : null;
  const rnd = rng(Math.round((an.entryBoard || 17) * 1000) + (shot.t || 0) % 100000);
  // Kugel kurz vor den Pins starten, Richtung aus dem Laufweg
  const y0 = HEADPIN_Y - 0.45;
  const x0 = interpX(an.path, y0), x1 = interpX(an.path, HEADPIN_Y);
  const dir = Math.atan2(x1 - x0, HEADPIN_Y - y0);
  const v = Math.max(3, an.speedImpact || an.speedAvg || 7.5);
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
    const k = 0.18 * Math.abs(rv);
    b.vx += (rnd() - 0.5) * k; b.vy += (rnd() - 0.5) * k * 0.5;
    return true;
  };
  for (let t = 0; t <= DUR + 1e-9; t += DT) {
    // Kugel
    ball.x += ball.vx * DT; ball.y += ball.vy * DT;
    for (const p of bodies) {
      if (p.static) continue;
      if (collide(ball, p, E_BP) && p.fall < 0 && Math.hypot(p.vx, p.vy) > HIT_V) { p.fall = t; p.fdir = Math.atan2(p.vx, p.vy); }
    }
    for (let i = 0; i < bodies.length; i++) for (let k = i + 1; k < bodies.length; k++) {
      const a = bodies[i], b = bodies[k];
      if (a.static || b.static) continue;
      if (collide(a, b, E_PP)) {
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
    if (t >= tOut - 1e-9) {
      frames.push({ t, ball: { x: ball.x, y: ball.y, pit: !!ball.pit },
        pins: Object.fromEntries(bodies.map(p => [p.id, { x: p.x, y: p.y, fall: p.fall, fdir: p.fdir, pit: !!p.pit }])) });
      tOut += STEP_OUT;
    }
  }
  // Pins, die laut Messung gefallen sind, in der Simulation aber nicht: spät durch Nachbarschaft umfallen lassen
  if (after) {
    const last = frames[frames.length - 1];
    for (const id of Object.keys(pins)) {
      if (after.has(+id)) continue;
      if (last.pins[id].fall >= 0) continue;
      const tf = 0.25 + rnd() * 0.35, fd = (rnd() - 0.5) * 2.4;
      for (const fr of frames) if (fr.t >= tf) { fr.pins[id].fall = tf; fr.pins[id].fdir = fd; }
    }
  }
  return { frames, dur: DUR, simulated: true };
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
