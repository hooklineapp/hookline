// Einstieg: Einstellungen, Sprache, Store, Tabs, Service Worker.
import * as S from './settings.js';
import { setLang, t } from './i18n.js';
import { initStore } from './store.js';
import { initLive, showLive, hideLive } from './views/live.js';
import { initHistory, showHistory } from './views/history.js';
import { initStats, showStats } from './views/stats.js';
import { initOptions, showOptions } from './views/options.js';

window.BT_VERSION = '1.14.1';
S.loadSettings();
{ const lk = new URLSearchParams(location.search).get('look'); if (lk) { const [st, ac, th] = lk.split(','); if (st) S.set('uiStyle', st); if (ac && /^[0-9a-f]{6}$/i.test(ac)) S.set('accentColor', '#' + ac); if (th) S.set('theme', th); } }
setLang(S.get('lang'));
// Design: Glas/Flat und Hell/Dunkel/Automatisch
const mqDark = window.matchMedia ? matchMedia('(prefers-color-scheme: dark)') : null;
function applyTheme() {
  const th = S.get('theme');
  const dark = th === 'dark' || (th === 'auto' && mqDark?.matches);
  const root = document.documentElement;
  root.dataset.theme = dark ? 'dark' : 'light';
  root.dataset.style = S.get('uiStyle') || 'glass';
  // freie Akzentfarbe (außer im Pin-Design, dort ist Rot fest)
  const hex = /^#[0-9a-f]{6}$/i.test(S.get('accentColor') || '') ? S.get('accentColor') : '#4f46e5';
  const st = root.style;
  if ((S.get('uiStyle') || 'glass') === 'pin') { for (const v of ['--acc', '--acc2', '--acc-soft', '--grad']) st.removeProperty(v); }
  else {
    const n = parseInt(hex.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
    const mix = (c, t, k) => Math.round(c + (t - c) * k);
    const to = (rr, gg, bb) => '#' + [rr, gg, bb].map(x => x.toString(16).padStart(2, '0')).join('');
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    const light = to(mix(r, 255, .45), mix(g, 255, .45), mix(b, 255, .45));
    const acc = dark && lum < 0.45 ? light : hex;
    st.setProperty('--acc', acc);
    st.setProperty('--acc2', to(mix(r, 255, .25), mix(g, 255, .25), mix(b, 255, .25)));
    st.setProperty('--acc-soft', dark ? `rgba(${r},${g},${b},.18)` : to(mix(r, 255, .88), mix(g, 255, .88), mix(b, 255, .88)));
    st.setProperty('--grad', `linear-gradient(135deg, ${acc} 0%, ${to(mix(r, 255, .3), mix(g, 255, .3), mix(b, 255, .3))} 100%)`);
    root.dataset.accentDark = lum > 0.72 ? '1' : '';
  }
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', dark ? '#0b0e15' : '#f3f4f8');
}
applyTheme();
mqDark?.addEventListener?.('change', applyTheme);
S.onChange((k) => { if (k === 'theme' || k === 'uiStyle' || k === 'accentColor' || k === '*') applyTheme(); });
document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });

const views = { live: [showLive, hideLive], history: [showHistory], stats: [showStats], options: [showOptions] };
let cur = null;
async function tab(name) {
  if (cur === name) { if (name !== 'live') views[name][0](); return; }
  if (cur && views[cur][1]) views[cur][1]();
  cur = name;
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'v-' + name));
  try { history.replaceState(null, '', location.pathname + location.search + '#' + name); } catch { /* */ }
  await views[name][0]();
}
document.querySelectorAll('#tabs button').forEach(b => b.addEventListener('click', () => tab(b.dataset.tab)));
document.addEventListener('bt:tab', (e) => tab(e.detail));
window.addEventListener('hashchange', () => { const n = location.hash.slice(1); if (views[n]) tab(n); });
document.addEventListener('visibilitychange', () => {
  if (cur !== 'live') return;
  if (document.hidden) hideLive(); else showLive();
});

(async () => {
  await initStore();
  initLive(document.getElementById('v-live'));
  initHistory(document.getElementById('v-history'));
  initStats(document.getElementById('v-stats'));
  initOptions(document.getElementById('v-options'));
  const start = (location.hash || '#live').slice(1);
  await tab(views[start] ? start : 'live');
})();

if ('serviceWorker' in navigator && location.protocol === 'https:' && !/[?&]nosw/.test(location.search)) {
  navigator.serviceWorker.register('sw.js?v=' + window.BT_VERSION, { updateViaCache: 'none' }).catch(() => { });
}
// leise prüfen, ob es eine neuere Fassung gibt -> nur ein kleiner Punkt am Optionen-Tab
setTimeout(async () => {
  const { checkUpdate } = await import('./update.js');
  const u = await checkUpdate();
  if (u.available) document.querySelector('#tabs [data-tab="options"]')?.classList.add('has-update');
}, 3000);
