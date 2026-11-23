// Live-Ansicht: Kamera, Ecken setzen, Kugel antippen, Overlay, Wurf-Ereignisse.
import { h, $, toast, buzz, beep, fmt, icon, sheet } from '../ui.js';
import { t } from '../i18n.js';
import * as S from '../settings.js';
import { startCamera, stopStream } from '../camera.js';
import { Processor, estimateFps } from '../processor.js';
import { apply, cameraFromH } from '../vision/geometry.js';
import { LANE_W, HEADPIN_Y, PIT_Y, BOARD_W, PINS, PIN_IDS, ARROWS, xOfBoard, topLineY } from '../lane.js';
import { state, addShot, currentPosition, newGame, onStore, updateShot, gameShots, deleteShot } from '../store.js';
import { buildGame } from '../scoring.js';
import { miniLane } from '../replay.js';
import { pinPadSheet, speedStr, scoreCard, pinMini } from './common.js';
import { openShot } from './history.js';
import { mascot, setMood, mascotOn } from '../mascot.js';
import { recommend, applyChanges } from '../autotune.js';

const CAL_KEY = 'bt.calib.v1';
let root, stage, video, ov, octx, freeze, fctx, loupe, lctx, debugCv, hint, statusPill, framePill, bowlerPill, hud, shotCard, progress;
let proc = null, cam = null, active = false, mode = 'live'; // live | calib | ball
let corners = [], handles = [], calibrated = false, last = null, lastShot = null;
let fileMode = false, fileStop = false, paused = false, wake = null, drawPending = false;
let freezeBmp = null, pendingFps = 0, calBackup = null, pickLane = false, dock, calPanel;
let optCollect = null, welcomeOpen = false;
let wiz = null; // Einrichtungs-Assistent: { step, timer, preview, stable, target, busy }

export function initLive(el) {
  root = el;
  video = h('video', { playsinline: true, muted: true, autoplay: true });
  freeze = h('canvas.freeze');
  ov = h('canvas.ov');
  loupe = h('div.loupe', null, h('canvas', { width: 240, height: 240 }));
  debugCv = h('canvas.debugcv', { style: { display: 'none' } });
  hint = h('div.empty-hint', null, h('div', null, t('st.starting')));
  progress = h('div.progress', { style: { transform: 'scaleX(0)' } });
  stage = h('div.stage', null, video, freeze, ov, hint, loupe, debugCv, progress);
  statusPill = h('span.chip.status', null, h('i.dot'), h('span', null, ''));
  framePill = h('button.chip.game', { onclick: showGame }, '');
  bowlerPill = h('button.avatar', { onclick: () => document.dispatchEvent(new CustomEvent('bt:tab', { detail: 'options' })), 'aria-label': t('o.bowlers') }, '');
  hud = h('span.hud', null, '');
  const top = h('div.topbar', null, h('div.tb-left', null, statusPill, hud), framePill, bowlerPill);
  const dbtn = (id, ic, label, on) => h('button.dbtn', { id, onclick: on, 'aria-label': label }, icon(ic), h('span', null, label));
  dock = h('div.dock', null,
    dbtn('b-cal', 'corners', t('btn.setup'), () => startWizard()),
    dbtn('b-ball', 'ball', t('btn.ball'), () => mode === 'ball' ? endMode() : startBall()),
    h('button.fab', { id: 'b-run', onclick: togglePause, 'aria-label': t('btn.pause') }, icon('pause')),
    dbtn('b-game', 'plus', t('btn.newGame'), async () => { await newGame(); syncPins(); updateTop(); toast(t('btn.newGame')); }),
    dbtn('b-more', 'more', t('btn.more'), moreMenu));
  calPanel = h('div.calpanel', { style: { display: 'none' } });
  shotCard = h('div.shotcard', { style: { display: 'none' }, onclick: () => lastShot && openShot(lastShot) });
  root.append(stage, top, shotCard, dock, calPanel);
  octx = ov.getContext('2d'); fctx = freeze.getContext('2d'); lctx = loupe.firstChild.getContext('2d');
  stage.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('resize', () => { requestDraw(); placeHandles(); });
  onStore(() => updateTop());
  S.onChange((k) => {
    if (!proc) return;
    if (k === '*' || S.isEngineKey(k) || k === 'workW') proc.setOptions(S.engineOptions(), +S.get('workW'));
    if (['camRes', 'camFps', 'camPrefer', 'camDevice', 'camZoom', 'camShortExposure', 'camFocusFar', 'useWorker'].includes(k) && active && !fileMode) restart();
    if (k === 'topLine' && calibrated) toast(t('st.nocal'));
    debugCv.style.display = S.get('debug') ? 'block' : 'none';
    requestDraw();
  });
  try { corners = JSON.parse(localStorage.getItem(CAL_KEY) || '[]'); } catch { corners = []; }
}

async function ensureProc() {
  if (proc) return;
  proc = new Processor(onResult);
  await proc.init(S.get('useWorker'));
  proc.setOptions(S.engineOptions(), +S.get('workW'));
  syncBall(); syncPins();
  setInterval(updateHud, 500);
}
export function syncBall() { proc?.post({ type: 'ballColor', color: state.bowler?.ballColor || null }); }
export function syncPins() { proc?.post({ type: 'pinsBefore', pins: currentPosition().pinsBefore }); }

export async function showLive() {
  active = true;
  await ensureProc();
  updateTop();
  const q = new URLSearchParams(location.search);
  if (q.get('video') && !fileMode) { await openVideoUrl(q.get('video'), q); return; }
  if (!fileMode && !localStorage.getItem('bt.welcome') && !q.get('video')) showWelcome();
  if (!fileMode) await startCam();
  if (S.get('wakeLock') && navigator.wakeLock) try { wake = await navigator.wakeLock.request('screen'); } catch { /* */ }
}
export function hideLive() {
  active = false;
  if (!fileMode) { proc?.stop(); stopStream(cam?.stream); cam = null; }
  wake?.release?.(); wake = null;
}
async function restart() { proc.stop(); stopStream(cam?.stream); cam = null; if (S.get('useWorker') !== (proc.mode === 'worker')) { await proc.init(S.get('useWorker')); proc.setOptions(S.engineOptions(), +S.get('workW')); syncBall(); syncPins(); } await startCam(); }

async function startCam() {
  setStatus('st.starting', '');
  hint.style.display = 'grid'; hint.firstChild.textContent = t('st.starting');
  try {
    cam = await startCamera(video, { device: S.get('camDevice'), res: S.get('camRes'), fps: S.get('camFps'), prefer: S.get('camPrefer'),
      zoom: +S.get('camZoom'), shortExposure: S.get('camShortExposure'), focusFar: S.get('camFocusFar') });
    window.__camInfo = cam.info; window.__cams = cam.cams;
    hint.style.display = 'none';
    proc.attach(video, cam.track);
    if (corners.length === 4 && !calibrated) await calibrateNow();
    setStatus(calibrated ? 'st.idle' : 'st.nocal', calibrated ? 'ok' : 'warn');
    if (!calibrated && S.get('autoWizard') && !welcomeOpen && !sessionStorage.getItem('bt.skipWizard')) startWizard();
  } catch (e) {
    const msg = e.code === 'https' ? t('cam.https') : e.code === 'denied' ? t('cam.denied') : t('st.nocam') + (e.message ? ' (' + e.message + ')' : '');
    hint.style.display = 'grid'; hint.firstChild.textContent = msg + ' — ' + t('btn.file') + ' ↓';
    setStatus('st.nocam', 'bad');
  }
}

// ---------- Koordinaten ----------
function vidSize() {
  if (fileMode || cam) return [video.videoWidth || 16, video.videoHeight || 9];
  return [16, 9];
}
function viewRect() {
  const r = stage.getBoundingClientRect();
  const [vw, vh] = freezeBmp ? [freezeBmp.width, freezeBmp.height] : vidSize();
  const s = Math.min(r.width / vw, r.height / vh);
  return { x: (r.width - vw * s) / 2, y: (r.height - vh * s) / 2, w: vw * s, h: vh * s, sw: r.width, sh: r.height, left: r.left, top: r.top };
}
const toScreen = (nx, ny, R = viewRect()) => [R.x + nx * R.w, R.y + ny * R.h];
const toNorm = (cx, cy, R = viewRect()) => [(cx - R.left - R.x) / R.w, (cy - R.top - R.y) / R.h];

// ---------- Kalibrierung ----------
async function grabFrame() {
  if (video.readyState < 2) return null;
  return createImageBitmap(video);
}
async function doFreeze() {
  freezeBmp = await grabFrame();
  if (!freezeBmp) return false;
  freeze.width = freezeBmp.width; freeze.height = freezeBmp.height;
  fctx.drawImage(freezeBmp, 0, 0);
  stage.classList.add('frozen');
  return true;
}
function unfreeze() { stage.classList.remove('frozen'); freezeBmp?.close?.(); freezeBmp = null; }

async function startCalib() {
  endMode();
  mode = 'calib';
  calBackup = corners.length === 4 ? corners.map(c => [...c]) : null;
  if (S.get('freezeOnCalib')) await doFreeze();
  if (corners.length !== 4) corners = [];
  dock.style.display = 'none'; shotCard.classList.add('hidden');
  calbar(true);
  placeHandles();
  requestDraw();
}
function calbar(show) {
  if (!show) { calPanel.style.display = 'none'; calPanel.innerHTML = ''; return; }
  const pit = S.get('topLine') === 'pit';
  const names = [t('cal.p0'), t('cal.p1'), t(pit ? 'cal.p2pit' : 'cal.p2'), t(pit ? 'cal.p3pit' : 'cal.p3')];
  const n = corners.length;
  calPanel.innerHTML = '';
  const steps = h('div.steps', null, names.map((nm, i) => h('div.step' + (i < n ? '.done' : i === n && !pickLane ? '.cur' : ''), null, h('b', null, i < n ? '✓' : i + 1), h('span', null, nm))));
  const msg = pickLane ? t('cal.pick') : n < 4 ? t('cal.tap', { p: names[n] }) : t('cal.allSet');
  calPanel.append(
    h('div.cal-head', null, h('b', null, t('cal.title')), h('button.iconbtn', { onclick: cancelCalib, 'aria-label': t('btn.cancel') }, icon('close'))),
    steps, h('p.cal-msg', null, msg),
    h('div.cal-actions', null,
      h('button.pillbtn' + (pickLane ? '.on' : ''), { onclick: () => { pickLane = !pickLane; calbar(true); } }, icon('magic'), t('cal.auto')),
      h('button.pillbtn', { onclick: () => { corners = []; pickLane = false; placeHandles(); calbar(true); requestDraw(); }, disabled: !n }, icon('reset'), t('btn.reset')),
      h('button.pillbtn', { onclick: cancelCalib }, t('btn.cancel')),
      h('button.pillbtn.primary', { disabled: n !== 4, onclick: finishCalib }, icon('check'), t('btn.apply'))));
  calPanel.style.display = 'block';
}
function cancelCalib() {
  // vorherige Ecken wiederherstellen, die Kalibrierung bleibt wie sie war
  if (calBackup) corners = calBackup;
  calBackup = null; pickLane = false;
  endMode();
}
async function runAuto(target) {
  const src = freezeBmp ? await createImageBitmap(freezeBmp) : await grabFrame();
  if (!src) return;
  calPanel.classList.add('busy');
  const r = await proc.request(src, { auto: { target, yTop: topLineY(S.get('topLine')) } });
  calPanel.classList.remove('busy');
  pickLane = false;
  if (r.corners) { corners = r.corners; buzz(); toast(t('cal.autoOk'), 'ok'); }
  else toast(t('cal.autoFail'), 'bad');
  placeHandles(); calbar(true); requestDraw();
}
function placeHandles() {
  handles.forEach(x => x.remove()); handles = [];
  if (mode !== 'calib' && !(mode === 'wizard' && wiz?.step === 2)) return;
  const R = viewRect();
  corners.forEach((c, i) => {
    const [x, y] = toScreen(c[0], c[1], R);
    const el = h('div.handle', { style: { left: x + 'px', top: y + 'px' } }, h('span', null, i + 1));
    el.addEventListener('pointerdown', (e) => dragHandle(e, i));
    stage.append(el); handles.push(el);
  });
}
function dragHandle(e, i) {
  e.stopPropagation(); e.preventDefault();
  const el = handles[i];
  el.setPointerCapture(e.pointerId);
  const R = viewRect();
  const start = [e.clientX, e.clientY], c0 = [...corners[i]];
  const move = (ev) => {
    // feine Bewegung: halbe Geschwindigkeit für präzises Setzen
    const dx = (ev.clientX - start[0]) * 0.5 / R.w, dy = (ev.clientY - start[1]) * 0.5 / R.h;
    corners[i] = [Math.min(1, Math.max(0, c0[0] + dx)), Math.min(1, Math.max(0, c0[1] + dy))];
    const [x, y] = toScreen(...corners[i], R);
    el.style.left = x + 'px'; el.style.top = y + 'px';
    showLoupe(x, y); requestDraw();
  };
  const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); loupe.style.display = 'none'; };
  el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  showLoupe(...toScreen(...corners[i], R));
}
function showLoupe(x, y) {
  if (!S.get('loupe')) return;
  const src = freezeBmp ? freeze : video;
  const R = viewRect();
  const nx = (x - R.x) / R.w, ny = (y - R.y) / R.h;
  const [vw, vh] = freezeBmp ? [freeze.width, freeze.height] : vidSize();
  const zoom = 4, sz = 240 / zoom * (vw / R.w);
  lctx.imageSmoothingEnabled = false;
  lctx.fillStyle = '#000'; lctx.fillRect(0, 0, 240, 240);
  try { lctx.drawImage(src, nx * vw - sz / 2, ny * vh - sz / 2, sz, sz, 0, 0, 240, 240); } catch { /* */ }
  lctx.strokeStyle = '#ff0'; lctx.lineWidth = 1.5;
  lctx.beginPath(); lctx.moveTo(120, 100); lctx.lineTo(120, 140); lctx.moveTo(100, 120); lctx.lineTo(140, 120); lctx.stroke();
  loupe.style.display = 'block';
  loupe.style.left = Math.min(R.sw - 125, Math.max(5, x - 60)) + 'px';
  loupe.style.top = (y > 150 ? y - 150 : y + 30) + 'px';
}
async function finishCalib() {
  if (corners.length !== 4) { toast(t('cal.hint', { p: '4' })); return; }
  localStorage.setItem(CAL_KEY, JSON.stringify(corners));
  await calibrateNow(freezeBmp ? await createImageBitmap(freezeBmp) : null);
  calBackup = null; pickLane = false;
  endMode();
  if (fileMode && pendingFps) { const f = pendingFps; pendingFps = 0; video.currentTime = 0; await new Promise(r => { video.onseeked = r; }); runFile(f); }
}
async function calibrateNow(bmp) {
  bmp = bmp || await grabFrame();
  if (!bmp) return;
  const r = await proc.request(bmp, { calibrate: corners });
  if (r.type === 'calibrated') {
    calibrated = true; toast(t('cal.ok', { n: r.info.features }) + (r.info.snapped ? ' · ' + t('cal.snapped') : ''), 'ok');
    if (r.info.corners) { corners = r.info.corners.map(c => [...c]); try { localStorage.setItem(CAL_KEY, JSON.stringify(corners)); } catch { /* */ } } setStatus('st.idle', 'ok'); syncPins();
  } else toast(r.message || 'Fehler', 'bad');
}


// ---------- Einrichtungs-Assistent ----------
function startWizard() {
  endMode();
  mode = 'wizard';
  calBackup = corners.length === 4 ? corners.map(c => [...c]) : null;
  wiz = { step: 1, timer: 0, preview: null, stable: 0, target: null, busy: false };
  dock.style.display = 'none'; shotCard.classList.add('hidden');
  wizGo(1);
}
function wizGo(step) {
  if (!wiz) return;
  clearInterval(wiz.timer);
  wiz.step = step;
  handles.forEach(x => x.remove()); handles = [];
  if (step === 1) {
    unfreeze();
    wiz.stable = 0; wiz.preview = null;
    wiz.timer = setInterval(wizScan, 650);
    wizScan();
  }
  if (step === 2) placeHandles();
  if (step !== 2 && step !== 1) unfreeze();
  renderWizard(); requestDraw();
}
async function wizScan() {
  if (!wiz || wiz.step !== 1 || wiz.busy) return;
  const bmp = await grabFrame();
  if (!bmp || !wiz) return;
  wiz.busy = true;
  const r = await proc.request(bmp, { auto: { target: wiz.target, yTop: topLineY(S.get('topLine')) } });
  if (!wiz) return;
  wiz.busy = false;
  if (r.corners) {
    const prev = wiz.preview;
    const same = prev && r.corners.every((c, i) => Math.hypot(c[0] - prev[i][0], c[1] - prev[i][1]) < 0.025);
    wiz.stable = same ? wiz.stable + 1 : 1;
    wiz.preview = r.corners;
  } else { wiz.stable = 0; wiz.preview = null; }
  updateWizState(); requestDraw();
}
function renderWizard() {
  if (!wiz) return;
  const st = wiz.step;
  const dots = h('div.wiz-dots', null, [1, 2, 3, 4, 5].map(i => h('i' + (i < st ? '.done' : i === st ? '.on' : ''))));
  const moodOf = { 1: wiz.stable >= 2 ? 'happy' : 'look', 2: 'neutral', 3: 'look', 4: 'blink', 5: 'happy' };
  wiz.mascotEl = mascotOn() ? mascot(moodOf[st], { head: true, cls: 'm-wiz' }) : null;
  const head = h('div.cal-head', null, h('div.wiz-title', null, wiz.mascotEl, h('div', null, h('b', null, t('wiz.t' + st)), dots)),
    h('button.skip', { onclick: wizCancel }, t('wiz.later')));
  calPanel.innerHTML = '';
  calPanel.append(head);
  if (st === 1) {
    wiz.stateEl = h('div.lane-state', null, h('i.dot'), h('span'));
    wiz.nextEl = h('button.pillbtn.primary.big', { onclick: async () => { if (!wiz.preview) return; await doFreeze(); corners = wiz.preview.map(c => [...c]); wizGo(2); } }, icon('check'), t('wiz.next'));
    calPanel.append(h('p.cal-msg', null, t('wiz.m1')), wiz.stateEl,
      h('div.cal-actions', null,
        h('button.pillbtn', { onclick: () => { wizCancel(); startCalib(); } }, icon('hand'), t('btn.manual')), wiz.nextEl));
    updateWizState();
  } else if (st === 2) {
    calPanel.append(h('p.cal-msg', null, t('wiz.m2')),
      h('div.cal-actions', null,
        h('button.pillbtn', { onclick: () => wizGo(1) }, icon('reset'), t('wiz.again')),
        h('button.pillbtn.primary.big', { onclick: async () => {
          localStorage.setItem(CAL_KEY, JSON.stringify(corners));
          await calibrateNow(freezeBmp ? await createImageBitmap(freezeBmp) : null);
          calBackup = null;
          wizGo(3);
        } }, icon('check'), t('wiz.fits'))));
  } else if (st === 3) {
    renderOptimize();
    return;
  } else if (st === 4) {
    calPanel.append(h('p.cal-msg', null, t('wiz.m4')),
      h('div.cal-actions', null,
        h('button.pillbtn', { onclick: () => wizGo(5) }, t('wiz.skip'))));
  } else {
    const bc = state.bowler?.ballColor?.rgb;
    calPanel.append(h('p.cal-msg', null, t('wiz.m5')),
      h('div.lane-state.ok', null, h('i.dot'), t('wiz.ready'), bc ? h('span.swatch', { style: { background: `rgb(${bc})`, marginLeft: 'auto' } }) : null),
      h('div.cal-actions', null,
        h('button.pillbtn', { onclick: () => wizGo(4) }, icon('ball'), t('btn.ball')),
        h('button.pillbtn.primary.big', { onclick: () => {
          if (paused) togglePause();
          endMode(); setStatus('st.idle', 'ok'); buzz(40); toast(t('wiz.go'), 'ok');
          if (fileMode && pendingFps) { const f = pendingFps; pendingFps = 0; video.currentTime = 0; video.onseeked = () => { video.onseeked = null; runFile(f); }; }
        } }, icon('play'), t('btn.start'))));
  }
  calPanel.style.display = 'block';
}
function updateWizState() {
  if (!wiz || wiz.step !== 1 || !wiz.stateEl) return;
  const ok = wiz.stable >= 2;
  wiz.stateEl.className = 'lane-state' + (ok ? ' ok' : '');
  wiz.stateEl.lastChild.textContent = ok ? t('wiz.found') : wiz.preview ? t('wiz.hold') : t('wiz.search');
  wiz.nextEl.disabled = !wiz.preview;
  if (wiz.mascotEl) setMood(wiz.mascotEl, ok ? 'happy' : 'look');
}
function wizCancel() {
  if (calBackup) corners = calBackup;
  calBackup = null;
  endMode();
}

// ---------- Auto-Optimierung (Assistent-Schritt 3 und aus den Optionen) ----------
function renderOptimize() {
  const go = (to) => { optCollect = null; if (mode === 'wizard') wizGo(to); else endMode(); };
  const next = () => go(state.bowler?.ballColor ? 5 : 4);
  if (fileMode || !cam) {
    calPanel.append(h('p.cal-msg', null, t('opt.noCam')), h('div.cal-actions', null, h('button.pillbtn.primary.big', { onclick: next }, t('wiz.next'))));
    calPanel.style.display = 'block'; return;
  }
  const bar = h('div.optbar', null, h('i'));
  calPanel.append(h('p.cal-msg', null, t('opt.measuring')), bar, h('div.cal-actions', null, h('button.pillbtn', { onclick: next }, t('wiz.skip'))));
  calPanel.style.display = 'block';
  optCollect = { samples: [], ms: [], t0: performance.now() };
  const dur = 3500;
  const tick = () => {
    if (!optCollect) return;
    const k = (performance.now() - optCollect.t0) / dur;
    bar.firstChild.style.width = Math.min(100, k * 100) + '%';
    if (k < 1) { requestAnimationFrame(tick); return; }
    const camFps = proc?.stats?.cam || cam?.info?.fps || 30;
    const rec = recommend(optCollect.samples, optCollect.ms, camFps, { videoW: video.videoWidth });
    optCollect = null;
    showRecommendation(rec, next);
  };
  requestAnimationFrame(tick);
}
function showRecommendation(rec, next) {
  calPanel.querySelectorAll('.cal-msg, .optbar, .cal-actions').forEach(e => e.remove());
  if (wiz?.mascotEl) setMood(wiz.mascotEl, rec.notes.includes('good') ? 'happy' : 'neutral');
  const m = rec.measured;
  const facts = h('div.facts', null,
    h('div', null, h('small', null, t('opt.fCam')), h('b', null, m.camFps + ' fps')),
    h('div', null, h('small', null, t('opt.fCpu')), h('b', null, m.ms + ' ms')),
    h('div', null, h('small', null, t('opt.fLane')), h('b', null, m.lanePx + ' px')),
    h('div', null, h('small', null, t('opt.fShake')), h('b', null, m.shake < 0.15 ? t('opt.still') : m.shake < 1.5 ? t('opt.slight') : t('opt.strong'))));
  const ch = Object.entries(rec.changes);
  const list = ch.length ? h('ul.changes', null, ch.map(([k, v]) => h('li', null, t('opt.' + k), ': ', h('b', null, String(v) in { hand: 1, tripod: 1 } ? t('val.' + v) : String(v))))) : h('p.cal-msg', null, t('opt.nothing'));
  const notes = rec.notes.filter(x => x !== 'good').map(x => h('p.note', null, t('opt.n.' + x)));
  calPanel.append(facts, list, ...notes, h('div.cal-actions', null,
    h('button.pillbtn', { onclick: next }, t('opt.keep')),
    ch.length ? h('button.pillbtn.primary.big', { onclick: () => { applyChanges(rec.changes); toast(t('opt.applied'), 'ok'); next(); } }, icon('check'), t('opt.apply')) : h('button.pillbtn.primary.big', { onclick: next }, t('wiz.next'))));
}
export function startOptimize() {
  endMode();
  mode = 'optimize';
  dock.style.display = 'none'; shotCard.classList.add('hidden');
  calPanel.innerHTML = '';
  calPanel.append(h('div.cal-head', null, h('div.wiz-title', null, mascotOn() ? mascot('look', { head: true, cls: 'm-wiz' }) : null, h('b', null, t('wiz.t3'))), h('button.skip', { onclick: endMode }, t('btn.close'))));
  renderOptimize();
}

// ---------- Begrüßung (nur beim allerersten Start, überspringbar) ----------
function showWelcome() {
  welcomeOpen = true;
  const close = (setup) => {
    welcomeOpen = false; el.classList.add('out'); setTimeout(() => el.remove(), 220);
    try { localStorage.setItem('bt.welcome', '1'); } catch { /* */ }
    if (setup) startWizard(); else sessionStorage.setItem('bt.skipWizard', '1');
  };
  const el = h('div.welcome', null, h('div.welcome-card', null,
    mascotOn() ? mascot('happy', { cls: 'm-welcome' }) : null,
    h('h2', null, t('w.title')),
    h('ul', null, h('li', null, t('w.p1')), h('li', null, t('w.p2')), h('li', null, t('w.p3'))),
    h('div.cal-actions', null,
      h('button.pillbtn', { onclick: () => close(false) }, t('w.skip')),
      h('button.pillbtn.primary.big', { onclick: () => close(true) }, t('w.start')))));
  root.append(el);
}

// ---------- Kugelfarbe ----------
async function startBall() {
  endMode();
  mode = 'ball';
  $('#b-ball').classList.add('on');
  await doFreeze();
  dock.style.display = 'none'; shotCard.classList.add('hidden');
  calPanel.innerHTML = '';
  calPanel.append(h('div.cal-head', null, h('b', null, t('btn.ball')), h('button.iconbtn', { onclick: endMode, 'aria-label': t('btn.cancel') }, icon('close'))),
    h('p.cal-msg', null, t('ball.hint')), h('div.cal-actions', null, h('button.pillbtn', { onclick: endMode }, t('btn.cancel'))));
  calPanel.style.display = 'block';
}
async function sampleBall(nx, ny) {
  const src = freezeBmp ? await createImageBitmap(freezeBmp) : await grabFrame();
  if (!src) return;
  const r = await proc.request(src, { sample: { x: nx, y: ny, r: 0.006 } });
  if (r.color) {
    state.bowler.ballColor = r.color;
    const { saveBowler } = await import('../store.js');
    await saveBowler(state.bowler);
    syncBall();
    toast(t('ball.ok'), 'ok'); buzz();
    if (mode !== 'wizard') endMode();
  } else toast(t('ball.none'), 'bad');
}

function endMode() {
  if (wiz) { clearInterval(wiz.timer); wiz = null; }
  optCollect = null;
  mode = 'live';
  calbar(false);
  handles.forEach(x => x.remove()); handles = [];
  $('#b-ball')?.classList.remove('on');
  loupe.style.display = 'none';
  dock.style.display = ''; shotCard.classList.remove('hidden');
  unfreeze(); requestDraw();
}

function onPointerDown(e) {
  if (mode === 'wizard') {
    const n = toNorm(e.clientX, e.clientY);
    if (n[0] < 0 || n[0] > 1 || n[1] < 0 || n[1] > 1) return;
    if (wiz.step === 1) { wiz.target = n; wiz.stable = 0; wiz.preview = null; updateWizState(); requestDraw(); toast(t('wiz.targetSet')); }
    else if (wiz.step === 4) sampleBall(...n).then(() => { if (mode === 'wizard') wizGo(5); });
    return;
  }
  if (mode === 'calib' && pickLane) {
    const n = toNorm(e.clientX, e.clientY);
    if (n[0] >= 0 && n[0] <= 1 && n[1] >= 0 && n[1] <= 1) runAuto(n);
  } else if (mode === 'calib' && corners.length < 4) {
    const n = toNorm(e.clientX, e.clientY);
    if (n[0] < 0 || n[0] > 1 || n[1] < 0 || n[1] > 1) return;
    corners.push(n); placeHandles(); calbar(true); requestDraw();
    showLoupe(...toScreen(...n)); setTimeout(() => { loupe.style.display = 'none'; }, 700);
  } else if (mode === 'ball') {
    const n = toNorm(e.clientX, e.clientY);
    if (n[0] >= 0 && n[0] <= 1 && n[1] >= 0 && n[1] <= 1) sampleBall(...n);
  }
}

// ---------- Ergebnisse ----------
function onResult(m) {
  if (m.type === 'flushed') { for (const ev of m.events || []) handleEvent(ev); setStatus('st.idle', 'ok'); return; }
  if (m.type !== 'result') return;
  last = m;
  if (optCollect) { if (m.metrics) optCollect.samples.push(m.metrics); if (m.ms) optCollect.ms.push(m.ms); }
  if (m.state !== 'nocal') calibrated = true;
  for (const ev of m.events || []) handleEvent(ev);
  if (mode === 'live') {
    const key = !m.ok && S.get('trackMode') === 'hand' && m.lost > 3 ? ['st.lost', 'bad'] :
      m.state === 'roll' ? ['st.roll', 'run'] : m.state === 'settle' ? ['st.settle', 'run'] : m.state === 'cooldown' ? ['st.cooldown', ''] :
        m.state === 'nocal' ? ['st.nocal', 'warn'] : paused ? ['st.paused', ''] : ['st.idle', 'ok'];
    setStatus(...key);
  }
  if (m.debug) drawDebug(m.debug);
  requestDraw();
}
async function handleEvent(ev) {
  if (ev.type === 'start') { buzz(20); beep(660); }
  else if (ev.type === 'abort') { toast(t('shot.abort')); }
  else if (ev.type === 'shot') {
    buzz(60); beep(990, 0.12);
    if (!S.get('autoSave') && !confirm(t('btn.save') + '?')) return;
    const shot = await addShot(ev.shot, { source: fileMode ? 'file' : 'camera' });
    if (!shot.pinsAfter || S.get('confirmShots')) {
      const v = await pinPadSheet(shot.pinsBefore, shot.pinsAfter ?? shot.pinsBefore, shot.pinDetail);
      if (v) { shot.pinsAfter = v; shot.pinsManual = true; await updateShot(shot); }
    }
    lastShot = shot;
    syncPins(); showShotCard(shot); updateTop();
    toast(t('shot.saved'), 'ok');
  }
}

function showShotCard(shot) {
  const an = shot.an;
  shotCard.innerHTML = '';
  const cv = h('canvas.sc-lane');
  const knocked = shot.pinsAfter ? shot.pinsBefore.length - shot.pinsAfter.length : null;
  const pocket = an ? an.pocket : null;
  const stat = (label, val, unit) => h('div.sc-stat', null, h('small', null, label), h('b', null, val, unit ? h('i', null, unit) : null));
  const sp = an ? speedStr(an.speedAvg).split(' ') : ['–'];
  shotCard.append(
    h('div.sc-head', null,
      h('b', null, t('h.frameShort', { f: shot.frame, b: shot.ball })),
      pocket ? h('span.badge.' + pocket, null, t('pocket.' + pocket)) : null,
      knocked != null ? h('span.badge.pins', null, knocked === shot.pinsBefore.length ? (shot.ball === 1 ? 'Strike' : 'Spare') : knocked + ' ' + (knocked === 1 ? 'Pin' : t('m.pins'))) : null,
      h('span.spacer'),
      h('button.iconbtn', { onclick: (e) => { e.stopPropagation(); shotCard.classList.add('closed'); }, 'aria-label': t('btn.close') }, icon('close'))),
    cv,
    h('div.sc-stats', null,
      stat(t('m.speed'), sp[0], sp[1]),
      stat(t('m.angleShort'), an && an.entryAngle != null ? fmt(an.entryAngle, 1) : '–', '°'),
      stat(t('m.boardShort'), an ? fmt(an.entryBoard, 1) : '–'),
      stat(t('m.breakpoint'), an?.breakpoint ? fmt(an.breakpoint.board, 1) : '–')),
    h('div.sc-foot', null,
      pinMini(shot.pinsBefore, shot.pinsAfter),
      h('span.spacer'),
      h('button.pillbtn.sm', { onclick: async (e) => { e.stopPropagation(); const v = await pinPadSheet(shot.pinsBefore, shot.pinsAfter ?? shot.pinsBefore, shot.pinDetail); if (v) { shot.pinsAfter = v; shot.pinsManual = true; await updateShot(shot); syncPins(); showShotCard(shot); updateTop(); } } }, icon('pins'), t('m.pins')),
      h('button.pillbtn.sm', { onclick: async (e) => { e.stopPropagation(); await deleteShot(shot); lastShot = null; shotCard.style.display = 'none'; syncPins(); updateTop(); toast(t('btn.undo')); } }, icon('undo'), t('btn.undo'))));
  shotCard.classList.remove('closed');
  shotCard.style.display = '';
  requestAnimationFrame(() => miniLane(cv, an, { exag: 3, pinsBefore: shot.pinsBefore, pinsAfter: shot.pinsAfter, ballColor: state.bowler?.ballColor?.rgb ? `rgb(${state.bowler.ballColor.rgb})` : null }));
}

function setStatus(key, cls) {
  statusPill.className = 'chip status ' + cls;
  statusPill.lastChild.textContent = t(key);
}
function updateTop() {
  if (!framePill) return;
  const pos = currentPosition();
  const g = buildGame(gameShots());
  framePill.innerHTML = '';
  framePill.append(h('small', null, t('h.game', { n: state.game })), h('b', null, t('h.frameShort', { f: pos.frame, b: pos.ball })), g.total ? h('span.score-badge', null, g.total) : '');
  bowlerPill.innerHTML = '';
  const bc = state.bowler?.ballColor?.rgb;
  const name = state.bowler?.name || '?';
  bowlerPill.style.setProperty('--ring', bc ? `rgb(${bc})` : 'var(--line)');
  bowlerPill.append(name.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase());
  bowlerPill.title = name;
}
function showGame() {
  const g = buildGame(gameShots());
  import('../ui.js').then(({ sheet }) => sheet(t('h.game', { n: state.game }), scoreCard(g, currentPosition().frame)));
}
function updateHud() {
  if (!S.get('showHud') || !proc) { hud.textContent = ''; return; }
  const s = proc.stats;
  const q = last ? Math.round((last.quality || 0) * 100) : 0;
  hud.textContent = `${t('btn.camera')} ${s.cam} · ${s.proc} fps · ${fmt(s.ms, 0)} ms · ${q}% · ${s.source}`;
  hud.title = s.cam > s.proc + 5 ? t('misc.lowFps') : '';
}
function togglePause() {
  paused = !paused;
  proc?.setPaused(paused);
  const b = $('#b-run'); b.innerHTML = ''; b.append(icon(paused ? 'play' : 'pause')); b.classList.toggle('paused', paused);
  if (fileMode) { fileStop = paused; }
  setStatus(paused ? 'st.paused' : 'st.idle', paused ? '' : 'ok');
}
async function moreMenu() {
  const item = (val, ic, label, sub) => ({ value: val, label, icon: ic, sub });
  const v = await sheet(t('btn.more'), null, [], { menu: [
    item('file', 'video', t('btn.file'), t('file.short')),
    item('game', 'pins', t('h.scorecard')),
    item('fs', 'expand', t('btn.fullscreen')),
  ] });
  if (v === 'file') pickFile(); else if (v === 'fs') toggleFullscreen(); else if (v === 'game') showGame();
}
function toggleFullscreen() {
  const d = document;
  if (d.fullscreenElement || d.webkitFullscreenElement) (d.exitFullscreen || d.webkitExitFullscreen).call(d);
  else { const el = d.documentElement; (el.requestFullscreen || el.webkitRequestFullscreen)?.call(el)?.catch?.(() => { }); try { screen.orientation?.lock?.('landscape').catch(() => { }); } catch { /* */ } }
}

// ---------- Videodatei ----------
function pickFile() {
  const inp = h('input', { type: 'file', accept: 'video/*' });
  inp.onchange = () => { const f = inp.files[0]; if (f) openVideoUrl(URL.createObjectURL(f), new URLSearchParams()); };
  inp.click();
}
async function openVideoUrl(url, q) {
  fileMode = true; fileStop = false;
  proc.stop(); stopStream(cam?.stream); cam = null;
  video.srcObject = null; video.autoplay = false; video.removeAttribute('autoplay'); video.src = url; video.muted = true;
  await new Promise((r, j) => { video.onloadeddata = r; video.onerror = () => j(new Error('Video')); }).catch(e => toast(e.message, 'bad'));
  hint.style.display = 'none';
  toast(t('file.hint'));
  const fps = +(q.get('fps') || 0) || await estimateFps(video);
  video.pause(); await new Promise(r => setTimeout(r, 50)); video.pause();
  video.currentTime = 0.001;
  await new Promise(r => { video.onseeked = r; });
  // Sollwerte-Datei (Test): Ecken übernehmen
  if (q.get('gt')) {
    try {
      const gt = await (await fetch(url.replace(/\.mp4$/, '.json'))).json();
      const c = gt.frames_gt[0].corners;
      corners = [c.foul_left, c.foul_right, c.head_left, c.head_right].map(([u, v]) => [u / gt.width, v / gt.height]);
      if (q.get('color') !== 'none') {
        const f = gt.frames_gt.find(f => f.ball && f.ball.y > 4.5);
        if (f) {
          video.currentTime = (f.i + 0.5) / gt.fps; await new Promise(r => { video.onseeked = r; });
          const bmp = await createImageBitmap(video);
          await proc.request(await createImageBitmap(video), { calibrate: corners });
          const r = await proc.request(bmp, { sample: { x: f.ball.u / gt.width, y: f.ball.v / gt.height, r: 0.006 } });
          if (r.color) { state.bowler.ballColor = r.color; syncBall(); }
          video.currentTime = 0; await new Promise(r => { video.onseeked = r; });
        }
      }
    } catch (e) { console.warn('GT', e); }
  }
  if (q.get('corners')) corners = JSON.parse(q.get('corners'));
  if (corners.length === 4) await calibrateNow();
  else { pendingFps = fps; S.get('autoWizard') ? startWizard() : await startCalib(); return; }
  await runFile(fps);
}
async function runFile(fps) {
  fileStop = false;
  window.__fileDone = false;
  await proc.runFile(video, fps, (i, n) => { progress.style.transform = `scaleX(${i / n})`; }, () => fileStop || !active);
  window.__fileDone = true;
  toast(t('file.done'), 'ok');
}

// ---------- Overlay ----------
function requestDraw() {
  if (drawPending) return;
  drawPending = true;
  requestAnimationFrame(() => { drawPending = false; draw(); });
}
function draw() {
  const R = viewRect();
  const dpr = window.devicePixelRatio || 1;
  if (ov.width !== Math.round(R.sw * dpr) || ov.height !== Math.round(R.sh * dpr)) { ov.width = Math.round(R.sw * dpr); ov.height = Math.round(R.sh * dpr); }
  const c = octx;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, R.sw, R.sh);
  const S2 = (nx, ny) => toScreen(nx, ny, R);
  if (mode === 'wizard' && wiz?.step === 1 && wiz.preview) {
    const ok = wiz.stable >= 2, q = wiz.preview;
    c.fillStyle = ok ? 'rgba(16,185,129,.18)' : 'rgba(245,158,11,.14)';
    c.strokeStyle = ok ? '#10b981' : '#f59e0b'; c.lineWidth = 3;
    c.beginPath(); [0, 1, 3, 2].forEach((i, k) => { const p = S2(...q[i]); k ? c.lineTo(...p) : c.moveTo(...p); }); c.closePath(); c.fill(); c.stroke();
    return;
  }
  if (mode === 'calib' || (mode === 'wizard' && wiz?.step === 2)) {
    if (corners.length >= 2) {
      const order = [0, 1, 3, 2].filter(i => i < corners.length);
      c.strokeStyle = '#2f6fed'; c.lineWidth = 2; c.setLineDash([6, 4]);
      c.beginPath(); order.forEach((i, k) => { const p = S2(...corners[i]); k ? c.lineTo(...p) : c.moveTo(...p); });
      if (corners.length === 4) c.closePath();
      c.stroke(); c.setLineDash([]);
    }
    return;
  }
  if (!last || !last.H || !calibrated) return;
  const H = last.H;
  const P = (X, Y) => { const p = apply(H, X, Y); return S2(p[0], p[1]); };
  const line = (pts, col, w = 2) => { c.strokeStyle = col; c.lineWidth = w; c.beginPath(); pts.forEach((p, i) => i ? c.lineTo(...p) : c.moveTo(...p)); c.stroke(); };
  const yT = topLineY(S.get('topLine'));
  if (S.get('showLane')) {
    const col = last.ok ? 'rgba(47,111,237,.9)' : 'rgba(220,38,38,.9)';
    line([P(0, 0), P(LANE_W, 0), P(LANE_W, PIT_Y), P(0, PIT_Y), P(0, 0)], col, 2);
    line([P(0, yT), P(LANE_W, yT)], 'rgba(47,111,237,.5)', 1);
  }
  if (S.get('showBoards')) {
    for (let b = 5; b < 39; b += 5) line([P(b * BOARD_W, 0), P(b * BOARD_W, HEADPIN_Y - 0.6)], 'rgba(255,255,255,.35)', 1);
    c.fillStyle = 'rgba(255,200,0,.9)';
    for (const a of ARROWS) { const p = P(xOfBoard(a.b), a.y); c.beginPath(); c.arc(p[0], p[1], 3, 0, 7); c.fill(); }
  }
  if (S.get('showPins')) {
    const [vw, vh] = vidSize();
    let camM = null;
    try { camM = cameraFromH(scaleH(H, vw, vh), vw, vh, last.f * vw); } catch { /* */ }
    for (const id of PIN_IDS) {
      const [X, Y] = PINS[id];
      const b = P(X, Y);
      let top = null;
      if (camM) { const p = camM.P(X, Y, 0.38); top = S2(p[0] / vw, p[1] / vh); }
      c.strokeStyle = 'rgba(255,255,255,.85)'; c.lineWidth = 1.5;
      if (top) { c.beginPath(); c.moveTo(...b); c.lineTo(...top); c.stroke(); }
      c.fillStyle = '#c0392b'; c.beginPath(); c.arc(b[0], b[1], 2, 0, 7); c.fill();
    }
  }
  if (S.get('showCands') && last.cands) {
    c.strokeStyle = '#ffcc00'; c.lineWidth = 1.5;
    for (const [u, v] of last.cands) { const p = S2(u, v); c.strokeRect(p[0] - 6, p[1] - 6, 12, 12); }
  }
  if (S.get('showTrail') && last.trail && last.trail.length) {
    line(last.trail.map(([u, v]) => S2(u, v)), 'rgba(228,87,46,.95)', 3);
  }
  if (last.ball) {
    const p = S2(last.ball.u, last.ball.v);
    c.strokeStyle = '#fff'; c.lineWidth = 2.5; c.beginPath(); c.arc(p[0], p[1], 10, 0, 7); c.stroke();
    c.strokeStyle = '#e4572e'; c.lineWidth = 1.5; c.beginPath(); c.arc(p[0], p[1], 10, 0, 7); c.stroke();
  }
}
function scaleH(H, vw, vh) {
  const M = new Float64Array([vw, 0, 0, 0, vh, 0, 0, 0, 1]);
  const o = new Float64Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) o[i * 3 + j] = M[i * 3] * H[j] + M[i * 3 + 1] * H[3 + j] + M[i * 3 + 2] * H[6 + j];
  return o;
}
function drawDebug(d) {
  if (debugCv.width !== d.nx || debugCv.height !== d.ny) { debugCv.width = d.nx; debugCv.height = d.ny; }
  const x = debugCv.getContext('2d');
  const img = x.createImageData(d.nx, d.ny);
  const pal = [[0, 0, 0], [70, 70, 80], [255, 255, 255], [255, 120, 40]];
  for (let j = 0; j < d.ny; j++) for (let i = 0; i < d.nx; i++) {
    const k = j * d.nx + i, o = ((d.ny - 1 - j) * d.nx + i) * 4, c = pal[d.mask[k]];
    img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 255;
  }
  x.putImageData(img, 0, 0);
}
export function getLastShot() { return lastShot; }
