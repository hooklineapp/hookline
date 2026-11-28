// Verlauf: Sessions -> Spiele/Würfe -> Wurf mit Replay, Kennzahlen, Pin-Korrektur.
import { h, sheet, confirmBox, toast, fmt } from '../ui.js';
import { t, getLang } from '../i18n.js';
import * as S from '../settings.js';
import * as db from '../db.js';
import { state, analyze, updateShot, deleteShot, deleteGame } from '../store.js';
import { buildGame, gameStats } from '../scoring.js';
import { Replay, miniLane } from '../replay.js';
import { pinMini, pinPadEl, scoreCard, metricList, speedStr } from './common.js';

let root, stack = [];

export function initHistory(el) { root = el; }
export async function showHistory() { if (!stack.length) stack = [{ v: 'sessions' }]; await render(); }

function go(v) { stack.push(v); render(); }
function back() { stack.pop(); if (!stack.length) stack = [{ v: 'sessions' }]; render(); }
export function openSession(sid) {
  stack = [{ v: 'sessions' }, { v: 'session', id: sid }];
  document.dispatchEvent(new CustomEvent('bt:tab', { detail: 'history' }));
}
export async function openShot(shot) {
  stack = [{ v: 'sessions' }, { v: 'session', id: shot.sessionId }, { v: 'shot', id: shot.id, sid: shot.sessionId }];
  document.dispatchEvent(new CustomEvent('bt:tab', { detail: 'history' }));
}

async function render() {
  const top = stack[stack.length - 1];
  root.innerHTML = '';
  if (top.v === 'sessions') await renderSessions();
  else if (top.v === 'session') await renderSession(top.id);
  else if (top.v === 'shot') await renderShot(top.id, top.sid);
}

const dateStr = (ms) => new Date(ms).toLocaleString(getLang() === 'de' ? 'de-DE' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' });

async function renderSessions() {
  const sessions = (await db.list('sessions')).sort((a, b) => b.date - a.date);
  const bowlers = Object.fromEntries((await db.list('bowlers')).map(b => [b.id, b]));
  root.append(h('h2', null, t('h.sessions')));
  if (!sessions.length) { root.append(h('p.muted', null, t('h.empty'))); return; }
  const list = h('div.list');
  for (const s of sessions) {
    const shots = await db.shotsOf(s.id);
    if (!shots.length && s.id !== state.session?.id) continue;
    const gshots = shots.filter(x => !x.single);
    const games = [...new Set(gshots.map(x => x.game || 1))];
    const scores = games.map(g => buildGame(gshots.filter(x => (x.game || 1) === g))).filter(g => g.complete).map(g => g.total);
    list.append(h('div.item', { onclick: () => go({ v: 'session', id: s.id }) },
      h('div.grow', null, h('b', null, dateStr(s.date)), h('br'),
        h('small', null, (bowlers[s.bowlerId]?.name || '?') + ' · ' + t(shots.length === 1 ? 'h.shots1' : 'h.shots', { n: shots.length }) + (games.length ? ' · ' + t(games.length === 1 ? 'h.games1' : 'h.games', { n: games.length }) : '') +
          (scores.length ? ' · Ø ' + fmt(scores.reduce((a, b) => a + b, 0) / scores.length, 0) : ''))),
      s.id === state.session?.id ? h('span.chip.ok', null, t('h.active')) : null, '›'));
  }
  root.append(list);
}

async function renderSession(id) {
  const s = await db.getOne('sessions', id);
  if (!s) { back(); return; }
  const shots = await db.shotsOf(id);
  root.append(h('button.back', { onclick: back }, '‹ ' + t('h.sessions')), h('h2', null, dateStr(s.date)));
  const delBtn = h('div.row', { style: { justifyContent: 'center', marginTop: '22px' } },
    h('button.skip', { onclick: async () => { if (await confirmBox(t('h.deleteSession'))) { await db.deleteSession(id); if (state.session?.id === id) { state.session = null; state.shots = []; } back(); } } }, t('h.deleteSession').replace('?', '')));
  // Zeile für einen Wurf (Einzelwürfe und Spiele)
  const shotRow = (sh, label, indent) => {
    const an = sh.an || analyze(sh);
    const cv = h('canvas', { style: { width: '26px', height: '70px', borderRadius: '4px' } });
    const row = h('div.item' + (indent ? '.pair' : ''), { onclick: () => go({ v: 'shot', id: sh.id, sid: id }) }, cv,
      h('div.grow', null, h('b', null, label), h('br'),
        h('small', null, an ? `${speedStr(an.speedAvg)} · ${fmt(an.entryAngle, 1)}° · ${t('m.entryBoard')} ${fmt(an.entryBoard, 1)}` : t('misc.noData'))),
      sh.pinsAfter ? pinMini(sh.pinsBefore, sh.pinsAfter) : h('span.chip', { title: t('m.pins') + ': ?' }, '?'), sh.pinsManual ? h('span.chip', null, '✎') : null);   // ? = Pins nicht gemessen
    requestAnimationFrame(() => miniLane(cv, an, { exag: 6, pinsBefore: sh.pinsBefore, pinsAfter: sh.pinsAfter }));
    return row;
  };
  const singles = shots.filter(x => x.single).sort((a, b) => a.t - b.t);
  if (singles.length) {
    root.append(h('h3', null, t('single.list')));
    const list = h('div.list', { style: { marginTop: '8px' } });
    const timeOf = (x) => new Date(x.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    for (const sh of singles) {
      const second = sh.ball === 2;
      const label = (second ? '↳ ' + t('single.pair') : timeOf(sh)) + (sh.pinsBefore.length < 10 ? ' · ' + t('single.on', { p: sh.pinsBefore.join(', ') }) : '');
      list.append(shotRow(sh, label, second));
    }
    root.append(list);
  }
  const gshots = shots.filter(x => !x.single);
  const games = [...new Set(gshots.map(x => x.game || 1))].sort((a, b) => a - b);
  for (const g of games) {
    const gs = gshots.filter(x => (x.game || 1) === g);
    const st = gameStats(gs);
    root.append(h('div.row', { style: { alignItems: 'center' } }, h('h3', null, t('h.game', { n: g }) + (st.complete ? ' · ' + st.total : '')), h('span.spacer'),
      h('button.skip', { onclick: async () => { if (await confirmBox(t('h.deleteGame', { n: g }))) { await deleteGame(id, g); render(); } } }, t('h.deleteGameBtn'))), scoreCard(st));
    const list = h('div.list', { style: { marginTop: '8px' } });
    for (const sh of gs) list.append(shotRow(sh, t('h.frame', { f: sh.frame }) + ' · ' + t('h.ball', { b: sh.ball })));
    root.append(list);
  }
  if (!shots.length) root.append(h('p.muted', null, t('h.empty')));
  root.append(delBtn);
}

async function renderShot(id, sid) {
  const shot = await db.getOne('shots', id);
  if (!shot) { back(); return; }
  const bowler = await db.getOne('bowlers', shot.bowlerId);
  const an = analyze(shot, bowler);
  const all = await db.shotsOf(sid);
  const idx = all.findIndex(s => s.id === id);
  const n = +S.get('compareN');
  const cmp = all.slice(Math.max(0, idx - n), idx).map(s => s.an || analyze(s, bowler));
  root.append(h('div.row', null, h('button.back', { onclick: back }, '‹ ' + (shot.single ? t('h.sessions') : t('h.game', { n: shot.game }))), h('span.spacer'),
    idx > 0 ? h('button', { onclick: () => { stack[stack.length - 1] = { v: 'shot', id: all[idx - 1].id, sid }; render(); } }, '‹') : null,
    idx < all.length - 1 ? h('button', { onclick: () => { stack[stack.length - 1] = { v: 'shot', id: all[idx + 1].id, sid }; render(); } }, '›') : null));
  root.append(h('h2', null, shot.single ? (shot.ball === 2 ? t('single.pair') : t('single.label')) + (shot.pinsBefore.length < 10 ? ' · ' + t('single.on', { p: shot.pinsBefore.join(', ') }) : '') : `${t('h.frame', { f: shot.frame })} · ${t('h.ball', { b: shot.ball })}`, an?.extrap?.start || an?.extrap?.end ? h('span.chip.warn', { style: { marginLeft: '8px' } }, t('m.extrap')) : null));
  // Replay
  let modeSel = S.get('replayMode');
  const box = h('div.replay');
  const canvases = [];
  const players = [];
  const bc = bowler?.ballColor?.rgb ? `rgb(${bowler.ballColor.rgb})` : null;
  const build = () => {
    box.innerHTML = ''; players.length = 0; canvases.length = 0;
    box.className = 'replay' + (modeSel === 'split' ? ' split' : '');
    const modes = modeSel === 'split' ? ['top', 'camera'] : [modeSel];
    for (const m of modes) {
      const cv = h('canvas'); box.append(cv); canvases.push(cv);
      const r = new Replay(cv);
      Object.assign(r, { mode: m === 'camera' && !shot.cam ? 'top' : m, exag: +S.get('replayWidth'), speed: +S.get('replaySpeed'), cmp, ballColor: bc, pinSim: !!S.get('pinSim'), pin3d: S.get('pin3d') !== false, pinZoom: !!S.get('pinZoom'), simLabel: t('h.simLabel'), mixLabel: t('h.mixLabel') });
      players.push(r);
    }
  };
  build();
  const seek = h('input', { type: 'range', min: 0, max: 1000, value: 1000, oninput: (e) => players.forEach(p => { p.pause(); p.seek(e.target.value / 1000); }) });
  const playBtn = h('button.primary', { onclick: () => { players.forEach(p => p.play()); } }, '▶');
  const speedSel = h('select', { onchange: (e) => players.forEach(p => { p.speed = +e.target.value; }) },
    ['0.25', '0.5', '1', '2'].map(v => h('option', { value: v, selected: v === S.get('replaySpeed') }, v + '×')));
  const seg = h('div.seg', null, ['top', 'camera', 'split'].map(m => h('button' + (m === modeSel ? '.on' : ''), {
    onclick: (e) => { modeSel = m; seg.querySelectorAll('button').forEach(b => b.classList.remove('on')); e.target.classList.add('on'); build(); init(); },
  }, t(m === 'top' ? 'h.top' : m === 'camera' ? 'h.camera' : 'val.split'))));
  const init = () => requestAnimationFrame(() => players.forEach((p, i) => {
    p.set(shot, an, { p: 0 });
    p.onprogress = i === 0 ? (v) => { seek.value = Math.round(v * 1000); } : null;
    p.play();
  }));
  // Vergleichslinien: dünne graue Linien = die Würfe davor in dieser Session (aus allen Spielen); ein-/ausschaltbar
  let cmpOn = cmp.length > 0;
  const cmpLabel = () => (cmpOn ? '✓ ' : '') + t('h.cmpToggle', { n: cmp.length });
  const cmpBtn = cmp.length ? h('button.cmptoggle' + (cmpOn ? '.on' : ''), { onclick: () => { cmpOn = !cmpOn; cmpBtn.classList.toggle('on', cmpOn); cmpBtn.textContent = cmpLabel(); players.forEach(p => { p.cmp = cmpOn ? cmp : []; p.draw?.(); }); legend.style.opacity = cmpOn ? '1' : '.5'; } }, cmpLabel()) : null;
  const legend = h('div.hint', { style: { margin: '6px 2px 0' } }, cmp.length ? t(cmp.length === 1 ? 'h.cmpLegend1' : 'h.cmpLegend', { n: cmp.length }) : t('h.cmpNone'));
  root.append(h('div.row', { style: { marginBottom: '8px', flexWrap: 'wrap', gap: '8px' } }, seg, cmpBtn), box, legend, h('div.card.rctl', null, playBtn, seek, speedSel));
  init();
  // Kennzahlen
  const mt = h('div.mtable', null, metricList(an, shot).map(m => h('div', null, h('small', null, t(m.k)), h('b', null, m.v))));
  root.append(h('div.card', null, mt));
  // Pins
  let cur = shot.pinsAfter ? [...shot.pinsAfter] : [...shot.pinsBefore];
  const pad = pinPadEl(shot.pinsBefore, cur, (v) => { cur = v; }, shot.pinDetail);
  root.append(h('div.card', null, h('div.row', null, h('b', { style: { flex: 1 } }, t('h.editPins')),
    h('button.primary', { onclick: async () => { shot.pinsAfter = cur; shot.pinsManual = true; await updateShot(shot); toast(t('btn.save'), 'ok'); render(); } }, t('btn.save'))),
  h('p.muted', { style: { margin: '4px 0' } }, t('h.editPinsHint')), pad));
  root.append(h('div.row', { style: { justifyContent: 'flex-end', marginTop: '8px' } },
    h('button.danger', { onclick: async () => { if (await confirmBox(t('h.deleteShot'))) { await deleteShot(shot); back(); } } }, t('btn.delete'))));
  void sheet;
}
