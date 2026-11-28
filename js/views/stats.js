// Statistik über Sessions: Kacheln, Tempo-/Winkelverlauf, Brett-Verteilung, alle Laufwege.
import { h, fmt } from '../ui.js';
import { t } from '../i18n.js';
import * as db from '../db.js';
import { state, analyze } from '../store.js';
import { buildGame, gameStats } from '../scoring.js';
import { speedUnit } from '../analysis.js';
import * as S from '../settings.js';
import { Replay } from '../replay.js';
import { PIN_IDS } from '../lane.js';

let root, period = 'all', bowlerId = null;
export function initStats(el) { root = el; }

export async function showStats() {
  bowlerId = bowlerId || state.bowler?.id;
  const bowlers = await db.list('bowlers');
  const sessions = await db.list('sessions');
  const since = period === '7' ? Date.now() - 7 * 864e5 : period === '30' ? Date.now() - 30 * 864e5 : 0;
  const sel = sessions.filter(s => s.date >= since && (!bowlerId || s.bowlerId === bowlerId));
  let shots = [];
  const games = [];
  for (const s of sel) {
    const ss = await db.shotsOf(s.id);
    shots = shots.concat(ss);
    const gs = ss.filter(x => !x.single);
    for (const g of [...new Set(gs.map(x => x.game || 1))]) games.push(gameStats(gs.filter(x => (x.game || 1) === g)));
  }
  shots.sort((a, b) => a.t - b.t);
  const bow = bowlers.find(b => b.id === bowlerId);
  const ans = shots.map(s => s.an || analyze(s, bow)).filter(Boolean);
  root.innerHTML = '';
  const seg = (vals, cur, on) => h('div.seg', null, vals.map(([v, l]) => h('button' + (v === cur ? '.on' : ''), { onclick: () => on(v) }, l)));
  root.append(h('h2', null, t('s.title')),
    h('div.row.wrap', { style: { marginBottom: '10px' } },
      h('select.inp', { style: { width: 'auto' }, onchange: (e) => { bowlerId = e.target.value; showStats(); } },
        bowlers.map(b => h('option', { value: b.id, selected: b.id === bowlerId }, b.name))),
      seg([['7', t('s.p7')], ['30', t('s.p30')], ['all', t('s.pAll')]], period, (v) => { period = v; showStats(); })));
  if (!shots.length) { root.append(h('p.muted', null, t('misc.noData'))); return; }
  const done = games.filter(g => g.complete);
  const sum = (a, f) => a.reduce((x, y) => x + f(y), 0);
  const avg = (a, f) => { const v = a.map(f).filter(x => x != null && isFinite(x)); return v.length ? v.reduce((x, y) => x + y, 0) / v.length : NaN; };
  // Einzelwürfe zählen mit: Strike = 1. Wurf aufs volle Dreieck räumt ab; Spare = 2. Wurf räumt den Rest ab
  const sg = shots.filter(x => x.single && x.pinsAfter);
  const s1 = sg.filter(x => x.ball === 1 && x.pinsBefore.length === 10), s2 = sg.filter(x => x.ball === 2);
  const strikes = sum(games, g => g.strikes) + s1.filter(x => !x.pinsAfter.length).length, sc = sum(games, g => g.strikeChances) + s1.length;
  const spares = sum(games, g => g.spares) + s2.filter(x => !x.pinsAfter.length).length, spc = sum(games, g => g.spareChances) + s2.length;
  const first = shots.filter(s => s.ball === 1 && s.pinsAfter && s.pinsBefore.length === 10);
  const unit = S.get('units') === 'mph' ? 'mph' : 'km/h';
  const tile = (l, v) => h('div.tile', null, h('small', null, l), h('b', null, v));
  root.append(h('div.tiles', null,
    tile(t('s.avgScore'), done.length ? fmt(avg(done, g => g.total), 1) : '–'),
    tile(t('s.bestGame'), done.length ? Math.max(...done.map(g => g.total)) : '–'),
    tile(t('s.games'), done.length + (games.length > done.length ? ' (+' + (games.length - done.length) + ')' : '')),
    tile(t('s.shots'), shots.length),
    tile(t('s.strike'), sc ? fmt(100 * strikes / sc, 0) + ' %' : '–'),
    tile(t('s.spare'), spc ? fmt(100 * spares / spc, 0) + ' %' : '–'),
    tile(t('s.firstBall'), first.length ? fmt(avg(first, s => 10 - s.pinsAfter.length), 2) : '–'),
    tile(t('s.splits'), sum(games, g => g.splits)),
    tile(t('s.pocket'), ans.length ? fmt(100 * ans.filter(a => a.pocket === 'pocket').length / ans.length, 0) + ' %' : '–'),
    tile(t('m.speed'), fmt(speedUnit(avg(ans, a => a.speedAvg), S.get('units')), 1) + ' ' + unit),
    tile(t('m.entryAngle'), fmt(avg(ans, a => a.entryAngle), 1) + '°'),
    tile(t('m.entryBoard'), fmt(avg(ans, a => a.entryBoard), 1)),
    tile(t('m.boardArrows'), fmt(avg(ans, a => a.boardArrows), 1)),
    tile(t('m.breakpoint'), fmt(avg(ans.filter(a => a.breakpoint), a => a.breakpoint.board), 1)),
  ));
  root.append(h('h3', null, t('s.speedChart')), h('div.card', null, lineChart(ans.map(a => speedUnit(a.speedAvg, S.get('units'))), unit)));
  root.append(h('h3', null, t('s.angleChart')), h('div.card', null, lineChart(ans.map(a => a.entryAngle), '°', [4, 7])));
  root.append(h('h3', null, t('s.entryHist')), h('div.card', null, histChart(ans.map(a => a.entryBoard), 5, 30, +S.get('pocketMin'), +S.get('pocketMax'))));
  const cv = h('canvas', { style: { width: '100%', height: '60vh', display: 'block' } });
  root.append(h('h3', null, t('s.paths')), h('div.card', null, cv));
  requestAnimationFrame(() => {
    const r = new Replay(cv); r.exag = +S.get('replayWidth'); r.cmp = ans.slice(0, -1);
    r.set({ points: [], pinsBefore: PIN_IDS, pinsAfter: null, tStart: 0, tImpact: 1 }, ans[ans.length - 1], { p: 0.999 });
  });
  void buildGame;
}

function lineChart(vals, unit, band) {
  const W = 600, H = 150, p = 28;
  const v = vals.filter(x => isFinite(x));
  if (v.length < 1) return h('p.muted', null, t('misc.noData'));
  let lo = Math.min(...v), hi = Math.max(...v);
  if (band) { lo = Math.min(lo, band[0]); hi = Math.max(hi, band[1]); }
  if (hi - lo < 1e-6) { hi += 1; lo -= 1; }
  const pad = (hi - lo) * 0.1; lo -= pad; hi += pad;
  const X = (i) => p + (W - p - 8) * (vals.length < 2 ? 0.5 : i / (vals.length - 1));
  const Y = (y) => H - 18 - (H - 26) * (y - lo) / (hi - lo);
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('class', 'chart');
  const add = (tag, a) => { const e = document.createElementNS(ns, tag); for (const k in a) e.setAttribute(k, a[k]); svg.append(e); return e; };
  if (band) add('rect', { x: p, y: Y(band[1]), width: W - p - 8, height: Y(band[0]) - Y(band[1]), fill: '#e8f6ee' });
  for (const g of [lo + pad, (lo + hi) / 2, hi - pad]) {
    add('line', { x1: p, x2: W - 8, y1: Y(g), y2: Y(g), stroke: '#e4e7ec' });
    add('text', { x: 2, y: Y(g) + 4, 'font-size': 11, fill: '#6b7280' }).textContent = g.toFixed(1);
  }
  const d = vals.map((y, i) => isFinite(y) ? `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(y).toFixed(1)}` : '').join('');
  add('path', { d, fill: 'none', stroke: '#4f46e5', 'stroke-width': 2 });
  vals.forEach((y, i) => { if (isFinite(y)) add('circle', { cx: X(i), cy: Y(y), r: 2.5, fill: '#4f46e5' }); });
  add('text', { x: W - 8, y: H - 4, 'font-size': 11, fill: '#6b7280', 'text-anchor': 'end' }).textContent = unit;
  return svg;
}

function histChart(vals, lo, hi, pMin, pMax) {
  const W = 600, H = 150, bins = [];
  for (let b = lo; b <= hi; b++) bins.push(0);
  for (const v of vals) { const i = Math.round(v) - lo; if (i >= 0 && i < bins.length) bins[i]++; }
  const mx = Math.max(1, ...bins), bw = (W - 20) / bins.length;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('class', 'chart');
  const add = (tag, a) => { const e = document.createElementNS(ns, tag); for (const k in a) e.setAttribute(k, a[k]); svg.append(e); return e; };
  bins.forEach((c, i) => {
    const b = lo + i, hh = (H - 30) * c / mx;
    add('rect', { x: 10 + i * bw + 1, y: H - 18 - hh, width: bw - 2, height: hh, rx: 2, fill: b >= pMin && b <= pMax ? '#10b981' : '#4f46e5' });
    if (b % 5 === 0) add('text', { x: 10 + i * bw + bw / 2, y: H - 4, 'font-size': 11, fill: '#6b7280', 'text-anchor': 'middle' }).textContent = b;
  });
  return svg;
}
