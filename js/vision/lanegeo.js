// Bild-Beleg für eine erkannte Bahn: Neben beiden Seitenkanten muss eine Rinne zu sehen sein (Helligkeitssprung
// zwischen Bahn und Rinne). Anlauf oder Nachbarflächen, die das Netz manchmal für eine Bahn hält, haben keine.
import { homography, apply } from './geometry.js';
import { LANE_W, HEADPIN_Y, GUTTER_W } from '../lane.js';

function px(g, w, h, x, y) { x = Math.round(x); y = Math.round(y); return x >= 0 && y >= 0 && x < w && y < h ? g[y * w + x] : NaN; }

// gray: Graustufen (w x h), corners: normiert [FoulL, FoulR, KopfL, KopfR]
// Ergebnis: { gutterL, gutterR } = Anteil der Stellen entlang der Kante (25 Stück) mit deutlichem Unterschied Bahn | Rinne
export function laneEvidence(gray, w, h, corners, yTop = HEADPIN_Y, trace) {
  const P = corners.map(([u, v]) => [u * w, v * h]);
  const H = homography([[0, 0], [LANE_W, 0], [0, yTop], [LANE_W, yTop]], P);
  if (!H) return null;
  const out = {};
  for (const [side, X, dir] of [['L', 0, -1], ['R', LANE_W, 1]]) {
    let n = 0, gut = 0;
    for (let k = 0; k <= 24; k++) {
      const Y = 1 + (yTop - 4) * k / 24;
      const inn = apply(H, X - dir * 0.12, Y), outG = apply(H, X + dir * GUTTER_W * 0.5, Y);
      const a = px(gray, w, h, inn[0], inn[1]), b = px(gray, w, h, outG[0], outG[1]);
      if (isNaN(a) || isNaN(b)) continue;
      n++; const okG = Math.abs(a - b) > 18; if (okG) gut++;
      trace?.push([outG[0] / w, outG[1] / h, okG ? 1 : 0]);
    }
    out['gutter' + side] = n ? gut / n : 0;
  }
  return out;
}

// Obere Linie am Horizont ausrichten. Die Seitenkanten treffen sich im Fluchtpunkt V auf dem Horizont; der Horizont hat
// im Bild die Neigung horizonDeg (Lagesensor des Handys). Die Foul-Linie trifft den Horizont im Quer-Fluchtpunkt Q.
// Die obere Linie ist in Wirklichkeit parallel zur Foul-Linie, muss im Bild also ebenfalls durch Q laufen:
// Gerade durch Q und die Mitte der bisherigen oberen Linie; die oberen Ecken neu als Schnitt mit den Seitenkanten.
// corners normiert [FoulL, FoulR, KopfL, KopfR]; horizonDeg in Bildkoordinaten (y nach unten). Ergebnis: neue Ecken oder null.
export function topFromHorizon(corners, w, h, horizonDeg) {
  const P = corners.map(([u, v]) => [u * w, v * h]);
  const cr = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const ln = (p, q) => cr([p[0], p[1], 1], [q[0], q[1], 1]);
  const V = cr(ln(P[0], P[2]), ln(P[1], P[3])); if (Math.abs(V[2]) < 1e-9) return null;
  const v = [V[0] / V[2], V[1] / V[2]], r = horizonDeg * Math.PI / 180;
  if (v[1] > Math.min(P[2][1], P[3][1])) return null;               // Fluchtpunkt muss über der Bahn liegen
  const hz = ln(v, [v[0] + Math.cos(r) * 1000, v[1] + Math.sin(r) * 1000]);
  const Q = cr(ln(P[0], P[1]), hz);
  const m = [(P[2][0] + P[3][0]) / 2, (P[2][1] + P[3][1]) / 2];
  const top = Math.abs(Q[2]) < 1e-9 ? cr([m[0], m[1], 1], [Q[0], Q[1], 0]) : ln(m, [Q[0] / Q[2], Q[1] / Q[2]]);
  const L = cr(ln(P[0], P[2]), top), R = cr(ln(P[1], P[3]), top);
  if (Math.abs(L[2]) < 1e-9 || Math.abs(R[2]) < 1e-9) return null;
  return [corners[0], corners[1], [L[0] / L[2] / w, L[1] / L[2] / h], [R[0] / R[2] / w, R[1] / R[2] / h]];
}
