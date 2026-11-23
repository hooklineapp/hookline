// Einstieg: Einstellungen, Sprache, Store, Tabs, Service Worker.
import * as S from './settings.js';
import { setLang, t } from './i18n.js';
import { initStore } from './store.js';
import { initLive, showLive, hideLive } from './views/live.js';
import { initHistory, showHistory } from './views/history.js';
import { initStats, showStats } from './views/stats.js';
import { initOptions, showOptions } from './views/options.js';

window.BT_VERSION = '1.2.0';
S.loadSettings();
setLang(S.get('lang'));
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
  navigator.serviceWorker.register('sw.js').catch(() => { });
}
