// Kleine DOM-Helfer: h(), Toast, Bottom-Sheet, Bestätigung.
import { t } from './i18n.js';
import * as S from './settings.js';

export function h(tag, attrs, ...kids) {
  const [name, ...cls] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (cls.length) el.className = cls.join(' ');
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && k !== 'list' && k !== 'type') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}
export const $ = (s, r = document) => r.querySelector(s);

let toastTimer = 0;
export function toast(msg, kind = '') {
  let el = $('#toast');
  if (!el) { el = h('div#toast'); el.id = 'toast'; document.body.append(el); }
  el.textContent = msg; el.className = 'show ' + kind;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.className = ''; }, 2200);
}

export function sheet(title, body, actions = []) {
  return new Promise((resolve) => {
    const close = (v) => { wrap.classList.remove('open'); setTimeout(() => wrap.remove(), 180); resolve(v); };
    const wrap = h('div.sheet-wrap', { onclick: (e) => { if (e.target === wrap) close(null); } },
      h('div.sheet', null,
        h('div.sheet-head', null, h('b', null, title), h('button.icon', { onclick: () => close(null), 'aria-label': t('btn.close') }, '✕')),
        h('div.sheet-body', null, body),
        actions.length ? h('div.sheet-actions', null, actions.map(a =>
          h('button' + (a.primary ? '.primary' : '') + (a.danger ? '.danger' : ''), { onclick: () => close(a.value) }, a.label))) : null));
    document.body.append(wrap);
    requestAnimationFrame(() => wrap.classList.add('open'));
  });
}
export async function confirmBox(msg, danger = true) {
  const v = await sheet(msg, null, [{ label: t('btn.cancel'), value: false }, { label: t('btn.ok'), value: true, primary: !danger, danger }]);
  return !!v;
}

export function buzz(ms = 30) { if (S.get('haptics') && navigator.vibrate) try { navigator.vibrate(ms); } catch { /* */ } }
let actx = null;
export function beep(f = 880, d = 0.08) {
  if (!S.get('sound')) return;
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const o = actx.createOscillator(), g = actx.createGain();
    o.frequency.value = f; g.gain.value = 0.08; o.connect(g); g.connect(actx.destination);
    o.start(); o.stop(actx.currentTime + d);
  } catch { /* */ }
}

export function fmt(v, d = 1) { return v == null || !isFinite(v) ? '–' : (+v).toFixed(d); }
