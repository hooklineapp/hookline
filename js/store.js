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
  state.game = state.shots.length ? Math.max(...state.shots.map(x => x.game || 1)) : 1;
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
export const gameShots = (g = state.game) => state.shots.filter(s => (s.game || 1) === g);
export function currentPosition() { return nextPosition(gameShots()); }

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
  const shot = {
    id: db.uid(), sessionId: state.session.id, bowlerId: state.bowler.id, hand: state.bowler.hand,
    t: Date.now(), game: state.game, frame: pos.frame, ball: pos.ball,
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
  if (shot.sessionId === state.session?.id) await relinkGame(shot.game);
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
  if (shot.sessionId === state.session?.id) await relinkGame(shot.game);
  emit('shot');
}
export const allPins = () => [...PIN_IDS];
export { emit };
