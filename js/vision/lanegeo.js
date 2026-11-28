// Bild-Beleg für eine erkannte Bahn: Neben beiden Seitenkanten muss eine Rinne zu sehen sein (Helligkeitssprung
// zwischen Bahn und Rinne). Anlauf oder Nachbarflächen, die das Netz manchmal für eine Bahn hält, haben keine.
import { homography, apply } from './geometry.js';
import { LANE_W, HEADPIN_Y, GUTTER_W } from '../lane.js';

function px(g, w, h, x, y) { x = Math.round(x); y = Math.round(y); return x >= 0 && y >= 0 && x < w && y < h ? g[y * w + x] : NaN; }

// gray: Graustufen (w x h), corners: normiert [FoulL, FoulR, KopfL, KopfR]
// Ergebnis: { gutterL, gutterR } = Anteil der Stellen entlang der Kante (25 Stück) mit deutlichem Unterschied Bahn | Rinne
export function laneEvidence(gray, w, h, corners, yTop = HEADPIN_Y) {
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
      n++; if (Math.abs(a - b) > 18) gut++;
    }
    out['gutter' + side] = n ? gut / n : 0;
  }
  return out;
}
