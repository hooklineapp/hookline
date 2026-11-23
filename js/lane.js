// Bahn-Geometrie (Meter). X = quer, 0 = linke Bahnkante (Blick vom Spieler), Y = ab Foul-Linie.
export const FT = 0.3048;
export const LANE_W = 1.0541;            // 41,5 Zoll, 39 Bretter
export const BOARDS = 39;
export const BOARD_W = LANE_W / BOARDS;
export const HEADPIN_Y = 18.288;          // 60 ft
export const PIT_Y = HEADPIN_Y + 0.8684;  // Bahnende (Grubenkante)
export const GUTTER_W = 0.235;
export const BALL_R = 0.1085;
export const PIN_H = 0.381;
export const PIN_D = 0.121;
export const ROW = 0.26396;
export const ARROWS_Y = 15 * FT;
export const DOTS_Y = 7 * FT;

const C = LANE_W / 2;
// Pin-Nummer -> [x, y]
export const PINS = {
  1: [C, HEADPIN_Y],
  2: [C - 0.1524, HEADPIN_Y + ROW], 3: [C + 0.1524, HEADPIN_Y + ROW],
  4: [C - 0.3048, HEADPIN_Y + 2 * ROW], 5: [C, HEADPIN_Y + 2 * ROW], 6: [C + 0.3048, HEADPIN_Y + 2 * ROW],
  7: [C - 0.4572, HEADPIN_Y + 3 * ROW], 8: [C - 0.1524, HEADPIN_Y + 3 * ROW],
  9: [C + 0.1524, HEADPIN_Y + 3 * ROW], 10: [C + 0.4572, HEADPIN_Y + 3 * ROW],
};
export const PIN_IDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

// Brett (kontinuierlich, Brettmitte = ganzzahlig) aus X; Rechtshänder zählen von rechts.
export function boardOf(x, hand = 'R') {
  return hand === 'L' ? x / BOARD_W + 0.5 : (LANE_W - x) / BOARD_W + 0.5;
}
export function xOfBoard(b, hand = 'R') {
  return hand === 'L' ? (b - 0.5) * BOARD_W : LANE_W - (b - 0.5) * BOARD_W;
}
// Pfeile: Bretter 5..35, Spitzen in V-Form 12..16 ft
export const ARROWS = [5, 10, 15, 20, 25, 30, 35].map(b => ({ b, y: (16 - Math.abs(b - 20) / 5) * FT }));
export const DOTS = [3, 5, 8, 11, 14, 26, 29, 32, 35, 37].map(b => ({ b, y: DOTS_Y }));

// obere Kalibrierlinie
export function topLineY(mode) { return mode === 'pit' ? PIT_Y : HEADPIN_Y; }
