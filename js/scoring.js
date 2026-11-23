// Punktezettel (10 Frames, 10. Frame mit Bonuswürfen) und Split-Erkennung.
import { PINS, PIN_IDS } from './lane.js';

const ADJ = {};
for (const a of PIN_IDS) ADJ[a] = PIN_IDS.filter(b => b !== a &&
  Math.hypot(PINS[a][0] - PINS[b][0], PINS[a][1] - PINS[b][1]) < 0.31);

export function isSplit(standing) {
  const s = new Set(standing);
  if (s.has(1) || s.size < 2) return false;
  const seen = new Set(); let comps = 0;
  for (const p of s) {
    if (seen.has(p)) continue;
    comps++; const st = [p]; seen.add(p);
    while (st.length) { const q = st.pop(); for (const r of ADJ[q]) if (s.has(r) && !seen.has(r)) { seen.add(r); st.push(r); } }
  }
  return comps >= 2;
}

// Bestimmt Frame/Wurf für den nächsten Wurf aus den bisherigen Würfen eines Spiels.
// shots: [{pinsBefore:[], pinsAfter:[]}] in Reihenfolge
export function nextPosition(shots) {
  const g = buildGame(shots);
  if (g.complete) return { newGame: true, frame: 1, ball: 1, pinsBefore: [...PIN_IDS] };
  return { newGame: false, frame: g.cur.frame, ball: g.cur.ball, pinsBefore: g.cur.pinsBefore };
}

export function buildGame(shots) {
  const frames = Array.from({ length: 10 }, (_, i) => ({ n: i + 1, rolls: [], marks: [], split: false, score: null }));
  const rolls = [];
  let f = 0, ball = 1, standing = [...PIN_IDS];
  let complete = false;
  for (const s of shots) {
    if (f > 9) break;
    const before = new Set(standing);
    const after = (s.pinsAfter || []).filter(p => before.has(p));
    const knocked = before.size - after.length;
    const fr = frames[f];
    fr.rolls.push(knocked); rolls.push(knocked);
    if (ball === 1 && after.length && isSplit(after)) fr.split = true;
    if (f < 9) {
      if (ball === 1 && after.length === 0) { fr.marks.push('X'); f++; ball = 1; standing = [...PIN_IDS]; }
      else if (ball === 1) { fr.marks.push(knocked ? String(knocked) : '-'); ball = 2; standing = after; }
      else { fr.marks.push(after.length === 0 ? '/' : (knocked ? String(knocked) : '-')); f++; ball = 1; standing = [...PIN_IDS]; }
    } else { // 10. Frame
      const r = fr.rolls; const k = r.length;
      const prevFull = k === 1 || (k === 2 && r[0] === 10) || (k === 3 && (r[0] === 10 && r[1] === 10 || r[0] + r[1] === 10));
      const freshRack = before.size === 10;
      if (after.length === 0) fr.marks.push(freshRack ? 'X' : '/');
      else fr.marks.push(knocked ? String(knocked) : '-');
      void prevFull;
      if (k === 1) { standing = after.length === 0 ? [...PIN_IDS] : after; ball = 2; }
      else if (k === 2) {
        if (r[0] === 10 || r[0] + r[1] === 10) { standing = after.length === 0 ? [...PIN_IDS] : after; ball = 3; }
        else { complete = true; f = 10; }
      } else { complete = true; f = 10; }
    }
  }
  // Wertung
  let total = 0, idx = 0;
  for (let i = 0; i < 10; i++) {
    const fr = frames[i];
    if (!fr.rolls.length) break;
    if (i < 9) {
      if (fr.rolls[0] === 10) {
        if (rolls.length > idx + 2) { total += 10 + rolls[idx + 1] + rolls[idx + 2]; fr.score = total; }
        idx += 1;
      } else if (fr.rolls.length === 2) {
        const sum = fr.rolls[0] + fr.rolls[1];
        if (sum === 10) { if (rolls.length > idx + 2) { total += 10 + rolls[idx + 2]; fr.score = total; } }
        else { total += sum; fr.score = total; }
        idx += 2;
      } else break;
      if (fr.score === null) break;
    } else if (complete) { total += fr.rolls.reduce((a, b) => a + b, 0); fr.score = total; }
  }
  // maximal möglich (für Anzeige)
  return { frames, complete, total, cur: { frame: Math.min(f, 9) + 1, ball, pinsBefore: standing } };
}

export function gameStats(shots) {
  const g = buildGame(shots);
  let strikes = 0, strikeChances = 0, spares = 0, spareChances = 0, splits = 0, opens = 0;
  g.frames.forEach((fr, i) => {
    if (!fr.rolls.length) return;
    strikeChances++;
    if (fr.rolls[0] === 10) strikes++;
    else if (fr.rolls.length >= 2) { spareChances++; if (fr.rolls[0] + fr.rolls[1] === 10) spares++; else opens++; }
    if (fr.split) splits++;
    void i;
  });
  return { ...g, strikes, strikeChances, spares, spareChances, splits, opens };
}
