// Auswertung einer Kugelbahn: Glättung, Geschwindigkeit, Bretter, Winkel, Breakpoint.
import { HEADPIN_Y, FT, BOARD_W, boardOf } from './lane.js';
import { solve } from './vision/geometry.js';

// Whittaker-Glätter auf festem Raster (zweite Differenzen)
function whittaker(grid, obsY, obsV, lambda, obsW) {
  const n = grid.length, step = grid[1] - grid[0];
  const A = Array.from({ length: n }, () => new Array(n).fill(0));
  const b = new Array(n).fill(0);
  for (let k = 0; k < obsY.length; k++) {
    const f = (obsY[k] - grid[0]) / step;
    let i = Math.floor(f); const a = f - i;
    if (i < 0) { i = 0; } if (i >= n - 1) { i = n - 2; }
    const w0 = 1 - Math.min(1, Math.max(0, a)), w1 = 1 - w0, ww = obsW ? obsW[k] : 1;
    A[i][i] += ww * w0 * w0; A[i][i + 1] += ww * w0 * w1; A[i + 1][i] += ww * w0 * w1; A[i + 1][i + 1] += ww * w1 * w1;
    b[i] += ww * w0 * obsV[k]; b[i + 1] += ww * w1 * obsV[k];
  }
  for (let i = 0; i + 2 < n; i++) { // D2^T D2
    const c = [1, -2, 1];
    for (let p = 0; p < 3; p++) for (let q = 0; q < 3; q++) A[i + p][i + q] += lambda * c[p] * c[q];
  }
  for (let i = 0; i < n; i++) A[i][i] += 1e-9;
  return solve(A, b);
}

function linfit(xs, ys) {
  const n = xs.length; let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i]; }
  const d = n * sxx - sx * sx; if (Math.abs(d) < 1e-12) return [sy / n, 0];
  const b = (n * sxy - sx * sy) / d; return [(sy - b * sx) / n, b];
}
// Querfehler wächst mit dem Abstand zur Kamera (≈ 4,5 m hinter der Foul-Linie): Gewicht ~ 1/Abstand²
const pw = (y) => { const d = Math.max(3, y + 4.5); return 100 / (d * d); };
function quadfit(xs, ys, ws) {
  const S = [0, 0, 0, 0, 0], T = [0, 0, 0];
  for (let i = 0; i < xs.length; i++) {
    const w = ws ? ws[i] : 1;
    let p = w; for (let k = 0; k < 5; k++) { S[k] += p; if (k < 3) T[k] += p * ys[i]; p *= xs[i]; }
  }
  return solve([[S[0], S[1], S[2]], [S[1], S[2], S[3]], [S[2], S[3], S[4]]], T);
}

export function interpX(path, y) {
  if (!path.length) return NaN;
  if (y <= path[0][0]) return path[0][1];
  for (let i = 1; i < path.length; i++) if (path[i][0] >= y) {
    const [y0, x0] = path[i - 1], [y1, x1] = path[i];
    return x0 + (x1 - x0) * (y - y0) / (y1 - y0 || 1);
  }
  return path[path.length - 1][1];
}
function slopeAt(path, y, half = 0.6) {
  return (interpX(path, y + half) - interpX(path, y - half)) / (2 * half);
}

// points: [[t(s), x, y]]
export function analyzeShot(points, opt = {}) {
  const hand = opt.hand || 'R';
  const lambda = opt.smooth ?? 40;
  const pts = points.filter(p => p[2] > -0.5 && p[2] < HEADPIN_Y + 0.6).sort((a, b) => a[0] - b[0]);
  if (pts.length < 5) return null;
  const xs = pts.map(p => p[1]), ys = pts.map(p => p[2]);
  // Tempo nur aus dem gut aufgelösten Bereich (fernes Bahnende hat wenige Pixel pro Meter)
  const sp = pts.filter(p => p[2] <= (opt.speedMaxY ?? 15.5));
  const spP = sp.length >= 8 && sp[sp.length - 1][2] - sp[0][2] > 6 ? sp : pts;
  const ts = spP.map(p => p[0]), tys = spP.map(p => p[2]);
  const yMin = Math.min(...ys), yMax = Math.max(...ys);
  // Geschwindigkeit
  const [, vlin] = linfit(ts, tys);
  const q = spP.length >= 8 ? quadfit(ts.map(t => t - ts[0]), tys) : null;
  let tAt = (y) => (y - linfit(ts, tys)[0]) / vlin;
  let vAt = () => vlin;
  // physikalisch plausible Verzögerung (Reibung): c = -a/2, a höchstens maxDecel m/s²
  if (q && q[1] > 0) {
    const cMin = -(opt.maxDecel ?? 0.8) / 2;
    if (q[2] < cMin || q[2] > 0) {
      q[2] = Math.min(0, Math.max(cMin, q[2]));
      const tt = ts.map(t => t - ts[0]);
      const [a0, b0] = linfit(tt, tys.map((y, i) => y - q[2] * tt[i] * tt[i]));
      q[0] = a0; q[1] = b0;
    }
  }
  if (q && q[2] < 0 && q[1] > 0) { // gebremste Bewegung
    const [a, b, c] = q;
    // frühere der beiden Lösungen (Kugel wird langsamer, Parabel kehrt später um)
    tAt = (y) => { const D = b * b - 4 * c * (a - y); if (D < 0) return NaN; const r1 = (-b + Math.sqrt(D)) / (2 * c), r2 = (-b - Math.sqrt(D)) / (2 * c); return ts[0] + Math.min(...[r1, r2].filter(v => v > -5)); };
    vAt = (y) => { const t = tAt(y) - ts[0]; return isNaN(t) ? vlin : b + 2 * c * t; };
  }
  const t0 = tAt(0), t1 = tAt(HEADPIN_Y);
  const travel = t1 - t0;
  const speedAvg = isFinite(travel) && travel > 0.5 ? HEADPIN_Y / travel : vlin;
  // Bahn glätten
  const step = 0.5 * FT;
  const g0 = Math.max(0, Math.floor(yMin / step) * step), g1 = Math.min(HEADPIN_Y + 0.3, Math.ceil(yMax / step) * step);
  const grid = []; for (let y = g0; y <= g1 + 1e-6; y += step) grid.push(y);
  let path;
  if (grid.length >= 4) {
    let ww = ys.map(pw);
    let z = whittaker(grid, ys, xs, lambda, ww);
    // Ausreißer (Pins, Hand, Schatten) entfernen und neu glätten
    for (let it = 0; it < 2; it++) {
      const res = ys.map((y, k) => Math.abs(xs[k] - interpX(grid.map((g, i) => [g, z[i]]), y)));
      const med = [...res].sort((a, b) => a - b)[res.length >> 1];
      const lim = Math.max(0.04, 4 * med);
      const nw = ww.map((w, k) => res[k] > lim ? 0 : w);
      if (nw.every((w, k) => w === ww[k])) break;
      ww = nw; z = whittaker(grid, ys, xs, lambda, ww);
    }
    path = grid.map((y, i) => [y, z[i]]);
    var dropped = ww.map((w, k) => w === 0 ? k : -1).filter(k => k >= 0);
  } else path = pts.map(p => [p[2], p[1]]);
  // linear bis Foul-Linie und Kopfpin verlängern
  const extrap = { start: false, end: false };
  if (path[0][0] > 0.05) {
    const s = slopeAt(path, path[0][0] + 1.2, 1.0);
    const [y0, x0] = path[0];
    const pre = []; for (let y = 0; y < y0; y += step) pre.push([y, x0 - s * (y0 - y)]);
    path = pre.concat(path); extrap.start = true;
  }
  const last = path[path.length - 1];
  if (last[0] < HEADPIN_Y) {
    const s = slopeAt(path, last[0] - 1.0, 0.8);
    for (let y = last[0] + step; y <= HEADPIN_Y + 1e-6; y += step) path.push([y, last[1] + s * (y - last[0])]);
    if (path[path.length - 1][0] < HEADPIN_Y) path.push([HEADPIN_Y, last[1] + s * (HEADPIN_Y - last[0])]);
    extrap.end = true;
  }
  const B = (y) => boardOf(interpX(path, y), hand);
  const dB = (y, h) => -(hand === 'L' ? -1 : 1) * slopeAt(path, y, h) / BOARD_W; // Brett pro Meter
  // Breakpoint: kleinstes Brett zwischen 6 m und 17,5 m, Richtungswechsel nötig
  let bp = null, minB = Infinity, minY = 0;
  for (const [y] of path) if (y >= 6 && y <= HEADPIN_Y - 0.6) { const b = B(y); if (b < minB) { minB = b; minY = y; } }
  if (isFinite(minB) && minY > 6.2 && minY < HEADPIN_Y - 0.9) bp = { y: minY, board: minB };
  const deg = (r) => r * 180 / Math.PI;
  let entryAngle = deg(Math.atan(dB(HEADPIN_Y - 0.5, 0.5) * BOARD_W));
  // genauer: quadratische Anpassung x(y) an die Rohpunkte der letzten Meter, Steigung am Kopfpin
  const drop = new Set(typeof dropped !== 'undefined' ? dropped : []);
  const tail = pts.filter((p, k) => !drop.has(k) && p[2] >= Math.max(yMax - 5, HEADPIN_Y - 6.5));
  if (tail.length >= 6 && yMax > HEADPIN_Y - 3) {
    const q2 = quadfit(tail.map(p => p[2] - HEADPIN_Y), tail.map(p => p[1]), tail.map(p => pw(p[2])));
    if (q2) {
      const slope = q2[1]; // dx/dy bei y = Kopfpin
      entryAngle = deg(Math.atan(-(hand === 'L' ? -1 : 1) * slope));
    }
  }
  const launchAngle = -deg(Math.atan(dB(Math.min(2.5, HEADPIN_Y), 2.0) * BOARD_W));
  const entryBoard = B(HEADPIN_Y);
  const pMin = opt.pocketMin ?? 16, pMax = opt.pocketMax ?? 19;
  let pocket = 'miss';
  if (entryBoard >= pMin && entryBoard <= pMax) pocket = 'pocket';
  else if (entryBoard >= 40 - pMax && entryBoard <= 40 - pMin) pocket = 'brooklyn';
  else if (entryBoard > pMax && entryBoard < 40 - pMax) pocket = 'head';
  const gutter = Math.min(...path.map(p => p[1])) < -0.02 || Math.max(...path.map(p => p[1])) > 1.0541 + 0.02;
  // Hook Factor: größte seitliche Beschleunigung (Bretter/s²) im Hook-Bereich: a_x ≈ x''(y)·v²
  let hookFactor = null;
  if (path.length > 8) {
    let mx = 0;
    for (let k = 4; k < path.length - 4; k++) {
      const [y0, x0] = path[k - 4], [y1, x1] = path[k], [y2, x2] = path[k + 4];
      if (y1 < 6 || y1 > HEADPIN_Y - 0.5) continue;
      const h1 = y1 - y0, h2 = y2 - y1;
      const xpp = 2 * ((x2 - x1) / h2 - (x1 - x0) / h1) / (h1 + h2);
      const v = vAt(y1);
      mx = Math.max(mx, Math.abs(xpp) * v * v / BOARD_W);
    }
    hookFactor = mx;
  }
  const speedRelease = vAt(Math.max(0, yMin)), speedImpact = vAt(Math.min(HEADPIN_Y, yMax));
  return {
    hookFactor, speedLoss: speedRelease - speedImpact,
    speedAvg, speedRelease, speedImpact,
    travelTime: isFinite(travel) ? travel : null,
    // Werte weit außerhalb der gesehenen Strecke nicht raten
    boardFoul: yMin <= 2.5 ? B(0) : null, boardArrows: yMin <= 15 * FT + 1.5 ? B(15 * FT) : null, boardDots: yMin <= 7 * FT + 1 ? B(7 * FT) : null,
    breakpoint: bp, entryBoard, entryAngle, launchAngle: yMin <= 3 ? launchAngle : null,
    hookBoards: bp ? entryBoard - bp.board : 0,
    pocket, gutter, path: path.map(([y, x]) => [+y.toFixed(3), +x.toFixed(4)]),
    coverage: [yMin, yMax], extrap, n: pts.length,
  };
}

export function speedUnit(mps, unit) {
  if (unit === 'mph') return mps * 2.23694;
  if (unit === 'fps') return mps / FT;
  return mps * 3.6;
}
