// App-Zustand: Spieler, aktuelle Session, Spiele, Würfe speichern.
import * as db from './db.js';
import * as S from './settings.js';
import { analyzeShot } from './analysis.js';
import { buildGame, nextPosition } from './scoring.js';
import { PIN_IDS } from './lane.js';
import { t } from './i18n.js';

export const state = { bowlers: [], bowler: null, session: null, shots: [], game: 1 };
const subs = new Set();
export const onStore = (f) => (subs.add(f), () => subs.delete(f));
const emit = (what) => subs.forEach(f => f(what));

export async function initStore() {
  state.bowlers = await db.list('bowlers');
  if (!state.bowlers.length) {
    const b = { id: db.uid(), name: t('bowler.default'), hand: 'R', ballColor: null, created: Date.now() };
    await db.put('bowlers', b); state.bowlers = [b];
  }
  const bid = await db.kvGet('bowler');
  state.bowler = state.bowlers.find(b => b.id === bid) || state.bowlers[0];
  const sid = await db.kvGet('session');
  const s = sid && await db.getOne('sessions', sid);
  if (s && Date.now() - s.date < 12 * 3600e3 && s.bowlerId === state.bowler.id) await setSession(s);
  emit('init');
}

export async function setBowler(id) {
  state.bowler = state.bowlers.find(b => b.id === id) || state.bowler;
  await db.kvSet('bowler', state.bowler.id);
  state.session = null; state.shots = []; state.game = 1;
  await db.kvSet('session', null);
  emit('bowler');
}
export async function saveBowler(b) {
  await db.put('bowlers', b);
  state.bowlers = await db.list('bowlers');
  if (state.bowler?.id === b.id) state.bowler = b;
  emit('bowler');
}
export async function deleteBowler(id) {
  await db.del('bowlers', id);
  state.bowlers = await db.list('bowlers');
  if (state.bowler?.id === id) await setBowler(state.bowlers[0]?.id);
  emit('bowler');
}

async function setSession(s) {
  state.session = s;
  state.shots = s ? await db.shotsOf(s.id) : [];
  const gs = state.shots.filter(x => !x.single);
  state.game = gs.length ? Math.max(...gs.map(x => x.game || 1)) : 1;
  const g = gameShots();
  if (g.length && buildGame(g).complete) state.game++;
}
export async function newSession() {
  const s = { id: db.uid(), date: Date.now(), bowlerId: state.bowler.id, lane: '', notes: '' };
  await db.put('sessions', s); await db.kvSet('session', s.id);
  await setSession(s); emit('session');
  return s;
}
export async function newGame() {
  if (!state.session) await newSession();
  if (gameShots().length) state.game++;
  emit('game');
}
export const gameShots = (g = state.game) => state.shots.filter(s => !s.single && (s.game || 1) === g);
export const singleMode = () => S.get('scoreMode') !== 'game';
// Einzelwürfe: jeder Wurf steht für sich. Bleiben nach einem 1. Wurf Pins stehen, kann der nächste Wurf der
// 2. Wurf darauf sein (Spare-Versuch) und wird angehängt – außer die Pins vor dem Wurf zeigen etwas anderes
// (state.rackOverride, gesetzt direkt beim Wurfbeginn aus dem Kamerabild).
export function singlePosition() {
  const singles = state.shots.filter(s => s.single).sort((a, b) => a.t - b.t);
  const last = singles[singles.length - 1];
  const n1 = singles.filter(s => s.ball === 1).length;
  if (state.rackOverride) return { newGame: false, single: true, frame: n1 + 1, ball: 1, pinsBefore: [...state.rackOverride] };
  if (last && last.ball === 1 && last.pinsAfter?.length && Date.now() - last.t < 15 * 60e3)
    return { newGame: false, single: true, frame: last.frame, ball: 2, pinsBefore: [...last.pinsAfter], pairOf: last.id };
  return { newGame: false, single: true, frame: n1 + 1, ball: 1, pinsBefore: [...PIN_IDS] };
}
export function currentPosition() { return singleMode() ? singlePosition() : nextPosition(gameShots()); }

export function analyze(shot, bowler = state.bowler) {
  return analyzeShot(shot.points || [], {
    hand: shot.hand || bowler?.hand || 'R', smooth: +S.get('smooth'),
    pocketMin: +S.get('pocketMin'), pocketMax: +S.get('pocketMax'),
  });
}

// Wurf aus der Auswertung übernehmen
export async function addShot(es, extra = {}) {
  if (!state.session) await newSession();
  let pos = currentPosition();
  if (pos.newGame) { state.game++; pos = currentPosition(); }
  state.rackOverride = null;
  const shot = {
    id: db.uid(), sessionId: state.session.id, bowlerId: state.bowler.id, hand: state.bowler.hand,
    t: Date.now(), game: pos.single ? null : state.game, frame: pos.frame, ball: pos.ball,
    ...(pos.single ? { single: true, pairOf: pos.pairOf || null } : {}),
    pinsBefore: pos.pinsBefore, pinsAfter: es.pinsAfter ? es.pinsAfter.filter(p => pos.pinsBefore.includes(p)) : null,
    pinDetail: es.pinDetail || null, pinsManual: false, pinTrack: es.pinTrack || null,
    points: es.points || [], itrack: es.itrack || [], tStart: es.tStart, tImpact: es.tImpact, cam: es.cam || null,
    source: extra.source || 'camera',
  };
  shot.an = analyze(shot);
  await db.put('shots', shot);
  state.shots.push(shot);
  emit('shot');
  return shot;
}
export async function updateShot(shot) {
  shot.an = analyze(shot);
  await db.put('shots', shot);
  const i = state.shots.findIndex(s => s.id === shot.id);
  if (i >= 0) state.shots[i] = shot;
  // Folgewürfe im Spiel: pinsBefore neu ableiten
  if (shot.sessionId === state.session?.id && !shot.single) await relinkGame(shot.game);
  emit('shot');
}
async function relinkGame(g) {
  const shots = gameShots(g);
  const done = [];
  for (const s of shots) {
    const pos = nextPosition(done);
    if (!pos.newGame) {
      const changed = String(s.pinsBefore) !== String(pos.pinsBefore) || s.frame !== pos.frame || s.ball !== pos.ball;
      s.pinsBefore = pos.pinsBefore; s.frame = pos.frame; s.ball = pos.ball;
      if (s.pinsAfter) s.pinsAfter = s.pinsAfter.filter(p => pos.pinsBefore.includes(p));
      if (changed) await db.put('shots', s);
    }
    done.push(s);
  }
}
export async function deleteShot(shot) {
  await db.del('shots', shot.id);
  state.shots = state.shots.filter(s => s.id !== shot.id);
  if (shot.sessionId === state.session?.id && !shot.single) await relinkGame(shot.game);
  emit('shot');
}
// Ein ganzes Spiel einer Session löschen; spätere Spiele rücken nach (Spiel 3 wird Spiel 2 usw.)
export async function deleteGame(sessionId, game) {
  const all = await db.shotsOf(sessionId);
  for (const s of all) {
    if (s.single) continue;
    const g = s.game || 1;
    if (g === game) await db.del('shots', s.id);
    else if (g > game) { s.game = g - 1; await db.put('shots', s); }
  }
  if (sessionId === state.session?.id) {
    state.shots = (await db.shotsOf(sessionId));
    if (state.game > game) state.game--;
    state.game = Math.max(1, state.game);
  }
  emit('shot');
}
export const allPins = () => [...PIN_IDS];
export { emit };
