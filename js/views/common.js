// Wiederverwendbare Bausteine: Pin-Pad, Mini-Pins, Punktezettel, Kennzahlen.
import { h, sheet, fmt } from '../ui.js';
import { t } from '../i18n.js';
import * as S from '../settings.js';
import { PIN_IDS } from '../lane.js';
import { speedUnit } from '../analysis.js';

// Anordnung aus Spielersicht: hintere Reihe oben
const POS = { 7: [0, 0], 8: [0, 2], 9: [0, 4], 10: [0, 6], 4: [1, 1], 5: [1, 3], 6: [1, 5], 2: [2, 2], 3: [2, 4], 1: [3, 3] };

export function pinMini(before, after) {
  const b = new Set(before || PIN_IDS), a = after ? new Set(after) : null;
  const cells = [];
  for (let r = 0; r < 4; r++) for (let c = 0; c < 7; c++) {
    const id = Object.keys(POS).find(k => POS[k][0] === r && POS[k][1] === c);
    cells.push(h('i.' + (!id ? 'x' : !b.has(+id) ? 'x' : a && !a.has(+id) ? 'd' : 's')));
  }
  return h('span.pinmini', null, cells);
}

export function pinPadEl(before, standing, onchange, detail) {
  const b = new Set(before || PIN_IDS);
  const st = new Set(standing || []);
  const el = h('div.pinpad');
  const draw = () => {
    el.innerHTML = '';
    for (let r = 0; r < 4; r++) for (let c = 0; c < 7; c++) {
      const id = +Object.keys(POS).find(k => POS[k][0] === r && POS[k][1] === c);
      if (!id) { el.append(h('button.na')); continue; }
      const cls = !b.has(id) ? '.na' : st.has(id) ? '' : '.down';
      const dcls = detail?.[id]?.state?.startsWith('hidden') ? '.hidden' : '';
      el.append(h('button' + cls + dcls, {
        title: detail?.[id] ? `${detail[id].state} ${detail[id].ratio}` : '',
        onclick: () => { st.has(id) ? st.delete(id) : st.add(id); draw(); onchange?.([...st].sort((a, b) => a - b)); },
      }, id));
    }
  };
  draw();
  return el;
}

export async function pinPadSheet(before, standing, detail) {
  let cur = (standing || []).filter(p => (before || PIN_IDS).includes(p));
  const body = h('div', null, h('p.muted', null, t('h.editPinsHint')), pinPadEl(before, cur, (v) => { cur = v; }, detail),
    h('div.row', { style: { justifyContent: 'center' } },
      h('button', { onclick: (e) => { cur = []; e.target.closest('.sheet').querySelectorAll('.pinpad button:not(.na)').forEach(b => b.classList.add('down')); } }, 'X / Strike'),
      h('button', { onclick: (e) => { cur = [...(before || PIN_IDS)]; e.target.closest('.sheet').querySelectorAll('.pinpad button:not(.na)').forEach(b => b.classList.remove('down')); } }, '0 / Gutter')));
  const v = await sheet(t('h.editPins'), body, [{ label: t('btn.cancel'), value: null }, { label: t('btn.save'), value: 'ok', primary: true }]);
  return v ? cur : null;
}

export function scoreCard(game, curFrame) {
  const el = h('div.score');
  game.frames.forEach((fr, i) => {
    const slots = i < 9 ? 2 : 3;
    const marks = [...fr.marks];
    if (i < 9 && marks[0] === 'X') marks.splice(0, 1, '', 'X');
    const rl = h('div.rl', null, Array.from({ length: slots }, (_, k) => h('span' + (fr.split && k === 0 ? '.split' : ''), null, marks[k] ?? '')));
    el.append(h('div' + (curFrame === i + 1 ? '.cur' : ''), null, h('div.fn', null, i + 1), rl, h('div.tot', null, fr.score ?? '')));
  });
  return el;
}

export function speedStr(mps) {
  if (mps == null || !isFinite(mps)) return '–';
  return fmt(speedUnit(mps, S.get('units')), 1) + ' ' + (S.get('units') === 'mph' ? 'mph' : 'km/h');
}
export function distStr(m) {
  if (m == null || !isFinite(m)) return '–';
  return S.get('lengthUnit') === 'm' ? fmt(m, 1) + ' m' : fmt(m / 0.3048, 1) + ' ft';
}

export function metricList(an, shot) {
  if (!an) return [];
  const M = (k, v) => ({ k, v });
  const u = (v, d, suf) => v == null || !isFinite(v) ? '–' : fmt(v, d) + suf;
  return [
    M('m.speed', speedStr(an.speedAvg)),
    M('m.entryAngle', u(an.entryAngle, 1, '°')),
    M('m.entryBoard', fmt(an.entryBoard, 1)),
    M('m.boardArrows', fmt(an.boardArrows, 1)),
    M('m.breakpoint', an.breakpoint ? fmt(an.breakpoint.board, 1) + ' @ ' + distStr(an.breakpoint.y) : '–'),
    M('m.boardFoul', fmt(an.boardFoul, 1)),
    M('m.boardDots', fmt(an.boardDots, 1)),
    M('m.launchAngle', u(an.launchAngle, 1, '°')),
    M('m.hook', fmt(an.hookBoards, 1) + ' ' + t('m.boards')),
    M('m.speedRelease', speedStr(an.speedRelease)),
    M('m.speedImpact', speedStr(an.speedImpact)),
    M('m.travel', an.travelTime ? fmt(an.travelTime, 2) + ' s' : '–'),
    M('m.pocket', t('pocket.' + an.pocket) + (an.gutter ? ' · ' + t('m.gutter') : '')),
    M('m.pins', shot?.pinsAfter ? (shot.pinsBefore.length - shot.pinsAfter.length) + ' / ' + shot.pinsBefore.length : '–'),
  ];
}
