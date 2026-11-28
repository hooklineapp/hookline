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

export function sheet(title, body, actions = [], opts = {}) {
  return new Promise((resolve) => {
    const close = (v) => { wrap.classList.remove('open'); setTimeout(() => wrap.remove(), 180); resolve(v); };
    const wrap = h('div.sheet-wrap', { onclick: (e) => { if (e.target === wrap) close(null); } },
      h('div.sheet', null,
        h('div.sheet-head', null, h('b', null, title), h('button.icon', { onclick: () => close(null), 'aria-label': t('btn.close') }, '✕')),
        h('div.sheet-body', null, body, opts.menu ? h('div.menu', null, opts.menu.map(m => h('button.menuitem', { onclick: () => close(m.value) },
          m.icon ? icon(m.icon) : null, h('span', null, m.label), m.sub ? h('small', null, m.sub) : null))) : null),
        actions.length ? h('div.sheet-actions', null, actions.map(a =>
          h('button' + (a.primary ? '.primary' : '') + (a.danger ? '.danger' : ''), { onclick: () => close(a.value) }, a.label))) : null));
    wrap._close = close;   // closeSheets(): offene Dialoge beim Ansichtswechsel schließen
    document.body.append(wrap);
    requestAnimationFrame(() => wrap.classList.add('open'));
  });
}
export function closeSheets() { document.querySelectorAll('.sheet-wrap').forEach(w => w._close?.(null)); }
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

// Linien-Icons (24er Raster, currentColor)
const ICONS = {
  corners: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  ball: '<circle cx="12" cy="12" r="8.5"/><circle cx="10" cy="9" r="1.2" class="f"/><circle cx="13.5" cy="8.3" r="1.2" class="f"/><circle cx="12.6" cy="11.8" r="1.3" class="f"/>',
  play: '<path d="M8 5.5v13l11-6.5z" class="f"/>',
  pause: '<rect x="6.5" y="5.5" width="4" height="13" rx="1" class="f"/><rect x="13.5" y="5.5" width="4" height="13" rx="1" class="f"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  more: '<circle cx="5.5" cy="12" r="1.6" class="f"/><circle cx="12" cy="12" r="1.6" class="f"/><circle cx="18.5" cy="12" r="1.6" class="f"/>',
  video: '<rect x="3" y="6" width="13" height="12" rx="2.5"/><path d="M16 10.5l5-3v9l-5-3z"/>',
  expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/><path d="M9 9l-4-4M15 9l4-4M9 15l-4 4M15 15l4 4"/>',
  magic: '<path d="M5 19L15 9M14 4v3M19 9h-3M17.5 5.5l-2 2M8 4l.8 1.7L10.5 6.5 8.8 7.3 8 9l-.8-1.7L5.5 6.5l1.7-.8z"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 010 12h-3"/>',
  pins: '<path d="M12 3c1.4 0 2 1.2 2 2.6 0 1.6-1 2.4-1 4 0 2 2.2 3.4 2.2 6.4 0 2.6-1.4 5-3.2 5s-3.2-2.4-3.2-5c0-3 2.2-4.4 2.2-6.4 0-1.6-1-2.4-1-4C10 4.2 10.6 3 12 3z"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  swapv: '<path d="M8 4v16M4 8l4-4 4 4M16 20V4M12 16l4 4 4-4"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  reset: '<path d="M4 4v6h6"/><path d="M5.5 15a7 7 0 102-8.5L4 10"/>',
  lanes: '<path d="M7 20 9.5 4M17 20 14.5 4M12 20v-3M12 13.5v-3M12 7V4"/>',
  hand: '<path d="M8 12V6.5a1.5 1.5 0 013 0V11M11 10.5V5a1.5 1.5 0 013 0v5.5M14 10.5V7a1.5 1.5 0 013 0v6c0 4-2.5 7-6 7-2.6 0-4-1.4-5.2-3.4L4 13.5a1.5 1.5 0 012.6-1.5L8 14"/>',
};
export function icon(name, cls = '') {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('class', 'ic ' + cls); s.setAttribute('aria-hidden', 'true');
  s.innerHTML = ICONS[name] || '';
  return s;
}
