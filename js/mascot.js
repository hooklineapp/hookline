// Maskottchen (ohne Namen): der Pin aus dem Logo, Variante B (große ovale Augen ohne Pupille, kein Mund).
// Stimmungen ändern nur Augen (und beim Staunen einen kleinen Mund).
import * as S from './settings.js';

const PIN = 'M268 140C318 140 352 176 352 229C352 281 319 302 313 346C306 421 403 521 403 650C403 760 370 838 349 870Q342 882 329 882H207Q194 882 187 870C166 838 133 760 133 650C133 521 230 421 223 346C217 302 184 281 184 229C184 176 218 140 268 140Z';
const ONE = 'M293 584V716H261V627L231 643V611L267 584Z';
const K = 'var(--mascot-ink, #111)';
const eye = (cx, cy, rx, ry) => `<ellipse class="m-eye" cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${K}"/>`;
const FACES = {
  neutral: eye(237, 226, 18, 30) + eye(299, 226, 18, 30),
  happy: `<path d="M218 232Q237 208 256 232M280 232Q299 208 318 232" fill="none" stroke="${K}" stroke-width="11" stroke-linecap="round"/>`,
  look: eye(248, 226, 18, 30) + eye(310, 226, 18, 30),
  blink: eye(237, 226, 18, 30) + `<path d="M282 232H316" stroke="${K}" stroke-width="11" stroke-linecap="round"/>`,
  wow: eye(237, 222, 20, 34) + eye(299, 222, 20, 34) + `<ellipse cx="268" cy="272" rx="10" ry="13" fill="${K}"/>`,
  worried: eye(237, 232, 16, 22) + eye(299, 232, 16, 22) + `<path d="M218 196L254 206M318 196L282 206" stroke="${K}" stroke-width="10" stroke-linecap="round"/>`,
  sleep: `<path d="M220 232H254M282 232H316" stroke="${K}" stroke-width="11" stroke-linecap="round"/>`,
};
let n = 0;

// Ganzer Pin oder nur Kopf (head: true) als SVG-Element
export function mascot(mood = 'neutral', opts = {}) {
  const id = 'mp' + (n++);
  const vb = opts.head ? '150 116 236 236' : '110 110 316 800';
  const wrap = document.createElement('span');
  wrap.className = 'mascot' + (opts.head ? ' head' : '') + (opts.cls ? ' ' + opts.cls : '') + (mood === 'neutral' || mood === 'look' ? ' idle' : '');
  wrap.innerHTML = `<svg viewBox="${vb}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <defs><clipPath id="${id}"><path d="${PIN}"/></clipPath></defs>
    <path d="${PIN}" fill="var(--mascot-body, #fff)"/>
    <g clip-path="url(#${id})" fill="#e3202f"><rect x="120" y="322" width="300" height="30"/><rect x="120" y="398" width="300" height="34"/></g>
    <path d="${PIN}" fill="none" stroke="${K}" stroke-width="22" stroke-linejoin="round"/>
    ${opts.head ? '' : `<path d="${ONE}" fill="${K}"/>`}
    <g class="m-face">${FACES[mood] || FACES.neutral}</g>
  </svg>`;
  return wrap;
}
export function setMood(el, mood) {
  const g = el?.querySelector('.m-face'); if (!g) return;
  g.innerHTML = FACES[mood] || FACES.neutral;
  el.classList.toggle('idle', mood === 'neutral' || mood === 'look');
}
export const mascotOn = () => S.get('mascot') !== false;
