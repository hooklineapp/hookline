// Eigener Farbwähler (HSV): Fläche für Sättigung/Helligkeit, Farbton-Regler, Hex-Eingabe, Schnellfarben.
import { h, sheet } from './ui.js';
import { t } from './i18n.js';

const hex2rgb = (x) => { const n = parseInt(x.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; };
const rgb2hex = (r, g, b) => '#' + [r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
function rgb2hsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let hh = 0;
  if (d) hh = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(hh * 60 + 360) % 360, mx ? d / mx : 0, mx];
}
function hsv2rgb(hh, s, v) {
  const c = v * s, x = c * (1 - Math.abs((hh / 60) % 2 - 1)), m = v - c;
  const [r, g, b] = hh < 60 ? [c, x, 0] : hh < 120 ? [x, c, 0] : hh < 180 ? [0, c, x] : hh < 240 ? [0, x, c] : hh < 300 ? [x, 0, c] : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}
const QUICK = ['#4f46e5', '#7c3aed', '#db2777', '#e11d48', '#ea580c', '#d97706', '#65a30d', '#059669', '#0891b2', '#0284c7', '#475569', '#111827'];

// onPreview(hex) wird beim Ziehen aufgerufen; Rückgabe: gewählte Farbe oder null (Abbrechen)
export async function pickColor(initial, onPreview) {
  let [hh, s, v] = rgb2hsv(...hex2rgb(/^#[0-9a-f]{6}$/i.test(initial) ? initial : '#4f46e5'));
  const area = h('div.cp-area'), knob = h('i.cp-knob'), hue = h('input.cp-hue', { type: 'range', min: 0, max: 360, step: 1, value: Math.round(hh) });
  const prev = h('span.cp-prev'), hexIn = h('input.inp.cp-hex', { maxLength: 7, spellcheck: false });
  area.append(knob);
  const cur = () => rgb2hex(...hsv2rgb(hh, s, v));
  const draw = (fromHex) => {
    area.style.background = `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${hh} 100% 50%))`;
    knob.style.left = (s * 100) + '%'; knob.style.top = ((1 - v) * 100) + '%';
    const c = cur(); prev.style.background = c; knob.style.background = c;
    if (!fromHex) hexIn.value = c;
    onPreview?.(c);
  };
  const setFromPointer = (e) => {
    const r = area.getBoundingClientRect();
    s = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    v = Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height));
    draw();
  };
  area.addEventListener('pointerdown', (e) => { area.setPointerCapture(e.pointerId); setFromPointer(e); });
  area.addEventListener('pointermove', (e) => { if (e.buttons || e.pressure) setFromPointer(e); });
  hue.addEventListener('input', () => { hh = +hue.value; draw(); });
  hexIn.addEventListener('input', () => {
    const x = hexIn.value.trim(); const y = x.startsWith('#') ? x : '#' + x;
    if (/^#[0-9a-f]{6}$/i.test(y)) { [hh, s, v] = rgb2hsv(...hex2rgb(y)); hue.value = Math.round(hh); draw(true); }
  });
  const quick = h('div.cp-quick', null, QUICK.map(c => h('button', { style: { background: c }, 'aria-label': c, onclick: () => { [hh, s, v] = rgb2hsv(...hex2rgb(c)); hue.value = Math.round(hh); draw(); } })));
  const body = h('div.cp', null, area, hue, h('div.cp-row', null, prev, hexIn), quick);
  requestAnimationFrame(() => draw());
  const res = await sheet(t('o.pickColor'), body, [{ label: t('btn.cancel'), value: null }, { label: t('btn.apply'), value: 'ok', primary: true }]);
  return res ? cur() : null;
}
