// Optionen: alle Einstellungen aus dem Schema, Spieler, Daten, Info.
import { h, toast, confirmBox, sheet } from '../ui.js';
import { t, has, setLang } from '../i18n.js';
import * as S from '../settings.js';
import * as db from '../db.js';
import { state, setBowler, saveBowler, deleteBowler, newSession } from '../store.js';
import { listCameras, scoreCamera } from '../camera.js';
import { icon } from '../ui.js';

let root;
export function initOptions(el) { root = el; }

export async function showOptions(keepLook) {
  if (!keepLook) lookOpen = false;
  root.innerHTML = '';
  root.append(h('h2', null, t('o.title')));
  const ex = !!S.get('expertMode');
  root.append(h('div.mode-switch', null, h('small', null, t('o.expertHint')),
    h('div.seg', null,
      h('button' + (!ex ? '.on' : ''), { onclick: () => { S.set('expertMode', false); showOptions(); } }, t('o.normal')),
      h('button' + (ex ? '.on' : ''), { onclick: () => { S.set('expertMode', true); showOptions(); } }, t('o.expert')))));
  root.append(presetsCard());
  root.append(profilesCard());
  root.append(await bowlersCard());
  for (const g of S.GROUPS) { const el = await groupEl(g, ex); if (el) root.append(el); }
  root.append(await dataCard());
  root.append(aboutCard());
  root.append(lookCard());
}

async function bowlersCard() {
  const d = h('details.grp', { open: true }, h('summary', null, t('o.bowlers')));
  for (const b of state.bowlers) {
    const c = b.ballColor?.rgb;
    d.append(h('div.opt', null,
      h('label', null, h('input', { type: 'radio', name: 'bowler', checked: b.id === state.bowler?.id, onchange: async () => { await setBowler(b.id); const { syncBall, syncPins } = await import('./live.js'); syncBall(); syncPins(); showOptions(); } }),
        ' ', h('b', null, b.name), ' · ', b.hand === 'L' ? t('o.handL') : t('o.handR'), ' ',
        c ? h('span.swatch', { style: { background: `rgb(${c})` } }) : h('small.muted', null, t('o.ballColor') + ': ' + t('o.noColor'))),
      h('button', { onclick: () => editBowler(b) }, t('btn.edit'))));
  }
  d.append(h('div.opt', null, h('span'), h('div.row', null,
    h('button', { onclick: () => editBowler({ id: db.uid(), name: '', hand: 'R', ballColor: null, created: Date.now() }, true) }, '+ ' + t('o.newBowler')),
    h('button', { onclick: async () => { await newSession(); toast(t('btn.newSession'), 'ok'); } }, t('btn.newSession')))));
  return d;
}
async function editBowler(b, isNew) {
  const name = h('input.inp', { value: b.name, placeholder: t('o.name') });
  const hand = h('select.inp', null, h('option', { value: 'R', selected: b.hand !== 'L' }, t('o.handR')), h('option', { value: 'L', selected: b.hand === 'L' }, t('o.handL')));
  const acts = [{ label: t('btn.cancel'), value: null }];
  if (!isNew && state.bowlers.length > 1) acts.push({ label: t('btn.delete'), value: 'del', danger: true });
  if (!isNew && b.ballColor) acts.push({ label: t('o.ballColor') + ' ✕', value: 'clr' });
  acts.push({ label: t('btn.save'), value: 'ok', primary: true });
  const v = await sheet(isNew ? t('o.newBowler') : b.name, h('div', null, h('label', null, t('o.name')), name, h('br'), h('label', null, t('o.hand')), hand), acts);
  if (v === 'ok') { b.name = name.value.trim() || t('bowler.default'); b.hand = hand.value; await saveBowler(b); if (isNew) await setBowler(b.id); }
  else if (v === 'del' && await confirmBox(b.name + ' ' + t('btn.delete') + '?')) await deleteBowler(b.id);
  else if (v === 'clr') { b.ballColor = null; await saveBowler(b); }
  const { syncBall } = await import('./live.js'); syncBall();
  showOptions();
}

async function groupEl(g, expert) {
  const items = S.SCHEMA.filter(x => x.group === g && !x.hidden && !x.look && (expert || x.basic));
  if (!items.length) return null;
  const d = h('details.grp', { open: g === 'general' && !expert }, h('summary', null, t('g.' + g)));
  let cams = [];
  if (g === 'camera') { try { cams = await listCameras(); } catch { /* */ } }
  for (const s of items) d.append(control(s, cams));
  if (g === 'camera' && window.__camInfo) {
    const i = window.__camInfo;
    d.append(h('div.opt', null, h('small.muted', null, t('o.camInfo', { info: t('cam.info', { w: i.w, h: i.h, fps: i.fps, label: i.label }) }))));
  }
  d.append(h('div.opt', null, h('span'), h('button', { onclick: async () => { if (await confirmBox(t('o.resetGroup') + ': ' + t('g.' + g) + '?', false)) { S.resetAll(g); showOptions(); } } }, t('o.resetGroup'))));
  return d;
}

function control(s, cams) {
  const v = S.get(s.key);
  const label = h('label', { for: 'o-' + s.key }, t('opt.' + s.key));
  let ctl;
  if (s.type === 'bool') {
    ctl = h('label.switch', null, h('input', { id: 'o-' + s.key, type: 'checkbox', checked: !!v, onchange: (e) => S.set(s.key, e.target.checked) }), h('i'));
  } else if (s.type === 'select') {
    ctl = h('select', { id: 'o-' + s.key, onchange: (e) => { S.set(s.key, e.target.value); if (s.key === 'lang') { setLang(e.target.value); location.reload(); } } },
      s.options.map(o => h('option', { value: o, selected: String(v) === o }, has('val.' + o) ? t('val.' + o) : o)));
  } else if (s.type === 'range') {
    const val = h('span.val', null, v);
    ctl = h('div.row', null, h('input', { id: 'o-' + s.key, type: 'range', min: s.min, max: s.max, step: s.step, value: v,
      oninput: (e) => { val.textContent = e.target.value; }, onchange: (e) => S.set(s.key, +e.target.value) }), val);
  } else if (s.type === 'camera') {
    const ranked = cams.map((c, i) => ({ c, s: scoreCamera(c.label, i) }));
    ctl = h('select', { id: 'o-' + s.key, onchange: (e) => S.set(s.key, e.target.value) },
      h('option', { value: '' }, t('val.auto')),
      ranked.map(({ c }, i) => h('option', { value: c.deviceId, selected: c.deviceId === v }, c.label || ('Kamera ' + (i + 1)))));
  }
  const hint = has('opt.' + s.key + '.h') ? h('div.hint', null, t('opt.' + s.key + '.h')) : null;
  return h('div.opt', null, label, ctl, hint);
}

async function dataCard() {
  const shots = await db.list('shots'), sessions = await db.list('sessions');
  const d = h('details.grp', null, h('summary', null, t('o.data')));
  d.append(h('div.opt', null, h('span', null, t('o.storage', { n: shots.length, s: sessions.length }))));
  d.append(h('div.opt', null, h('span', null, t('btn.export') + ' / ' + t('btn.import')), h('div.row', null,
    h('button', { onclick: exportData }, t('btn.export')),
    h('button', { onclick: importData }, t('btn.import')))));
  d.append(h('div.opt', null, h('span', null, t('opt.lang') + ' + ' + t('o.title')), h('div.row', null,
    h('button', { onclick: () => download('hookline-optionen.json', JSON.stringify(S.exportSettings(), null, 1)) }, t('btn.export')),
    h('button', { onclick: () => pickJson((o) => { S.importSettings(o); showOptions(); }) }, t('btn.import')))));
  d.append(h('div.opt', null, h('span'), h('button.danger', { onclick: async () => { if (await confirmBox(t('o.clearConfirm'))) { await db.clearAll(); location.reload(); } } }, t('o.clearAll'))));
  return d;
}
function aboutCard() {
  const status = h('span.muted', { style: { fontSize: '13px' } }, '');
  const btn = h('button', { onclick: async () => {
    btn.disabled = true; status.textContent = t('u.checking');
    const { checkUpdate, applyUpdate } = await import('../update.js');
    const u = await checkUpdate();
    btn.disabled = false;
    if (u.offline) { status.textContent = t('u.offline'); return; }
    if (!u.available) { status.textContent = t('u.current'); return; }
    status.textContent = t('u.available', { v: u.latest });
    btn.textContent = t('u.install'); btn.classList.add('primary');
    btn.onclick = async () => { btn.disabled = true; status.textContent = t('u.installing'); await applyUpdate(); };
  } }, t('u.check'));
  const hasUpd = document.querySelector('#tabs [data-tab="options"]')?.classList.contains('has-update');
  return h('details.grp', { open: hasUpd }, h('summary', null, t('o.about'), hasUpd ? h('span.upd-dot') : null),
    h('div.opt', null, h('span', null, t('u.title'), h('br'), status), btn),
    h('div.opt', null, h('span', null, t('o.install')), h('span')),
    h('div.opt', null, h('div.hint', null, t('o.installHint'))),
    h('div.opt', null, h('span', null, t('misc.version')), h('span.muted', null, window.BT_VERSION || '')));
}
function download(name, text) {
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'application/json' })), download: name });
  document.body.append(a); a.click(); a.remove();
}
function pickJson(cb) {
  const i = h('input', { type: 'file', accept: 'application/json,.json' });
  i.onchange = async () => { try { cb(JSON.parse(await i.files[0].text())); } catch (e) { toast(String(e.message || e), 'bad'); } };
  i.click();
}
async function exportData() {
  const data = await db.exportAll();
  const name = 'hookline-' + new Date().toISOString().slice(0, 10) + '.json';
  const text = JSON.stringify(data);
  const file = new File([text], name, { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] })) { try { await navigator.share({ files: [file], title: name }); return; } catch { /* abgebrochen */ } }
  download(name, text); toast(t('o.exported'), 'ok');
}
function importData() {
  pickJson(async (o) => { const n = await db.importAll(o); toast(t('o.imported', { n }), 'ok'); location.reload(); });
}

function presetsCard() {
  const cur = S.get('preset') || 'recommended';
  const d = h('div.card', null,
    h('div.row', { style: { marginBottom: '8px' } }, h('b', { style: { flex: 1 } }, t('o.presets')),
      h('button', { onclick: () => { document.dispatchEvent(new CustomEvent('bt:tab', { detail: 'live' })); setTimeout(async () => { const { startOptimize } = await import('./live.js'); startOptimize(); }, 700); } }, t('o.optimize'))),
    h('p.muted', { style: { margin: '0 0 10px', fontSize: '13px' } }, t('o.presetsHint')),
    h('div.presets', null, Object.keys(S.PRESETS).map(k => h('button.preset' + (k === cur ? '.on' : ''), {
      onclick: () => { S.applyPreset(k); toast(t('o.presetSet', { p: t('p.' + k) }), 'ok'); showOptions(); },
    }, h('b', null, t('p.' + k)), h('small', null, t('p.' + k + '.h'))))));
  return d;
}
function profilesCard() {
  const list = S.listProfiles();
  const name = h('input.inp', { placeholder: t('o.profileName'), style: { flex: 1 } });
  const rows = list.length ? list.map(p => h('div.profile-row', null, h('span', null, p.name),
    h('button', { onclick: () => { S.loadProfile(p.name); toast(t('o.profileLoaded'), 'ok'); showOptions(); } }, t('o.load')),
    h('button', { onclick: async () => { if (await confirmBox(p.name + ' ' + t('btn.delete') + '?')) { S.deleteProfile(p.name); showOptions(); } }, 'aria-label': t('btn.delete') }, '✕'))) : [h('p.muted', { style: { margin: '4px 0', fontSize: '13px' } }, t('o.noProfiles'))];
  return h('details.grp', null, h('summary', null, t('o.profiles')),
    h('div', { style: { padding: '4px 16px 12px' } }, rows,
      h('div.row', { style: { marginTop: '10px' } }, name,
        h('button.primary', { onclick: () => { const n = name.value.trim(); if (!n) { name.focus(); return; } S.saveProfile(n); toast(t('o.profileSaved'), 'ok'); showOptions(); } }, t('btn.save')))));
}

function lookCard() {
  const th = S.get('theme'), st = S.get('uiStyle');
  const pick = (key, vals, cur, label) => h('div.choice', null, vals.map(v => h('button' + (v === cur ? '.on' : ''), { onclick: () => { S.set(key, v); showOptions(true); } }, label(v))));
  const color = h('input', { type: 'color', value: S.get('accentColor') || '#4f46e5', style: { position: 'absolute', opacity: 0, width: '1px', height: '1px', pointerEvents: 'none' },
    oninput: (e) => S.set('accentColor', e.target.value), onchange: () => showOptions(true) });
  const colorBtn = h('button.colorbtn', { onclick: () => color.click() }, h('span.swatch', { style: { background: S.get('accentColor') || '#4f46e5' } }), t('o.pickColor'), color);
  const d = h('details.grp', { open: !!lookOpen, ontoggle: (e) => { lookOpen = e.target.open; } }, h('summary', null, t('o.look')),
    h('div.opt', null, h('label', null, t('opt.theme')), pick('theme', ['auto', 'light', 'dark'], th, v => t('val.' + v))),
    h('div.opt.col', null, h('label', null, t('opt.uiStyle')), pick('uiStyle', ['glass', 'flat', 'soft', 'sport', 'pin'], st, v => t('val.' + v)), h('div.hint', null, t('d.' + st))),
    h('div.opt', null, h('label', null, t('o.accent')), st === 'pin' ? h('small.muted', null, t('o.pinRed')) :
      h('div.row', null, colorBtn, h('button', { onclick: () => { S.set('accentColor', '#4f46e5'); showOptions(true); } }, t('o.resetGroup')))),
    h('div.opt', null, h('label', null, t('opt.mascot')),
      h('label.switch', null, h('input', { type: 'checkbox', checked: S.get('mascot') !== false, onchange: (e) => S.set('mascot', e.target.checked) }), h('i'))));
  return d;
}
let lookOpen = false;
