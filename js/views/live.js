// Live-Ansicht: Kamera, Ecken setzen, Kugel antippen, Overlay, Wurf-Ereignisse.
import { h, $, toast, buzz, beep, fmt } from '../ui.js';
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

const CAL_KEY = 'bt.calib.v1';
let root, stage, video, ov, octx, freeze, fctx, loupe, lctx, debugCv, hint, statusPill, framePill, bowlerPill, hud, shotCard, progress;
let proc = null, cam = null, active = false, mode = 'live'; // live | calib | ball
let corners = [], handles = [], calibrated = false, last = null, lastShot = null;
let fileMode = false, fileStop = false, paused = false, wake = null, drawPending = false;
let freezeBmp = null, pendingFps = 0;

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
  statusPill = h('span.pill', null, h('i.dot'), h('span', null, ''));
  framePill = h('span.pill.framepill.btn', { onclick: showGame }, '');
  bowlerPill = h('span.pill.btn', { onclick: () => document.dispatchEvent(new CustomEvent('bt:tab', { detail: 'options' })) }, '');
  hud = h('span.hud', null, '');
  const top = h('div.topbar', null, statusPill, framePill, bowlerPill, h('span.spacer'), hud);
  const btn = (id, label, on) => h('button', { id, onclick: on }, label);
  const controls = h('div.controls', null,
    btn('b-cal', t('btn.calib'), () => mode === 'calib' ? finishCalib() : startCalib()),
    btn('b-ball', t('btn.ball'), () => mode === 'ball' ? endMode() : startBall()),
    btn('b-run', t('btn.pause'), togglePause),
    btn('b-game', t('btn.newGame'), async () => { await newGame(); syncPins(); updateTop(); toast(t('btn.newGame')); }),
    btn('b-file', t('btn.file'), pickFile),
    btn('b-fs', '⛶', toggleFullscreen));
  shotCard = h('div.shotcard', { style: { display: 'none' }, onclick: () => lastShot && openShot(lastShot) });
  root.append(stage, top, controls, shotCard);
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
  } catch (e) {
    const msg = e.code === 'https' ? t('cam.https') : e.code === 'denied' ? t('cam.denied') : t('st.nocam') + ' (' + (e.message || e) + ')';
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
  $('#b-cal').classList.add('on'); $('#b-cal').textContent = t('btn.done');
  if (S.get('freezeOnCalib')) await doFreeze();
  if (corners.length !== 4) corners = [];
  calbar(true);
  setStatus('st.nocal', 'warn');
  placeHandles();
  requestDraw();
}
function calbar(show) {
  let el = $('.calbar', root);
  if (!show) { el?.remove(); return; }
  if (!el) { el = h('div.calbar'); root.append(el); }
  const pit = S.get('topLine') === 'pit';
  const names = [t('cal.p0'), t('cal.p1'), t(pit ? 'cal.p2pit' : 'cal.p2'), t(pit ? 'cal.p3pit' : 'cal.p3')];
  el.innerHTML = '';
  el.append(corners.length < 4 ? t('cal.hint', { p: (corners.length + 1) + ' = ' + names[corners.length] }) : t('cal.allSet'),
    h('div.row', { style: { justifyContent: 'center', marginTop: '6px' } },
      h('button', { onclick: () => { corners = []; placeHandles(); calbar(true); requestDraw(); } }, t('btn.reset')),
      h('button', { onclick: () => { endMode(); } }, t('btn.cancel')),
      h('button.primary', { disabled: corners.length !== 4, onclick: finishCalib }, t('btn.done'))));
}
function placeHandles() {
  handles.forEach(x => x.remove()); handles = [];
  if (mode !== 'calib') return;
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

// ---------- Kugelfarbe ----------
async function startBall() {
  endMode();
  mode = 'ball';
  $('#b-ball').classList.add('on');
  await doFreeze();
  const el = h('div.calbar', null, t('ball.hint'), h('div.row', { style: { justifyContent: 'center', marginTop: '6px' } }, h('button', { onclick: endMode }, t('btn.cancel'))));
  root.append(el);
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
    endMode();
  } else toast(t('ball.none'), 'bad');
}

function endMode() {
  mode = 'live';
  calbar(false); $('.calbar', root)?.remove();
  handles.forEach(x => x.remove()); handles = [];
  $('#b-cal')?.classList.remove('on'); if ($('#b-cal')) $('#b-cal').textContent = t('btn.calib');
  $('#b-ball')?.classList.remove('on');
  loupe.style.display = 'none';
  unfreeze(); requestDraw();
}

function onPointerDown(e) {
  if (mode === 'calib' && corners.length < 4) {
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
  const cv = h('canvas');
  const knocked = shot.pinsAfter ? shot.pinsBefore.length - shot.pinsAfter.length : '–';
  shotCard.append(cv, h('div.metrics', null,
    h('div', null, h('small', null, t('m.speed')), h('b', null, an ? speedStr(an.speedAvg) : '–')),
    h('div', null, h('small', null, t('m.entryAngle')), h('b', null, an && an.entryAngle != null ? fmt(an.entryAngle, 1) + '°' : '–')),
    h('div', null, h('small', null, t('m.entryBoard')), h('b', null, an ? fmt(an.entryBoard, 1) : '–')),
    h('div', null, h('small', null, t('m.boardArrows')), h('b', null, an ? fmt(an.boardArrows, 1) : '–')),
    h('div', null, h('small', null, t('m.breakpoint')), h('b', null, an?.breakpoint ? fmt(an.breakpoint.board, 1) : '–')),
    h('div', null, h('small', null, t('m.pins')), h('b', null, knocked, ' ', pinMini(shot.pinsBefore, shot.pinsAfter)))),
  h('div.row', { style: { gridColumn: '1 / -1', justifyContent: 'flex-end', gap: '6px' } },
    h('button', { onclick: async (e) => { e.stopPropagation(); const v = await pinPadSheet(shot.pinsBefore, shot.pinsAfter ?? shot.pinsBefore, shot.pinDetail); if (v) { shot.pinsAfter = v; shot.pinsManual = true; await updateShot(shot); syncPins(); showShotCard(shot); updateTop(); } } }, t('h.editPins')),
    h('button', { onclick: async (e) => { e.stopPropagation(); await deleteShot(shot); lastShot = null; shotCard.style.display = 'none'; syncPins(); updateTop(); toast(t('btn.undo')); } }, '↶ ' + t('btn.undo'))));
  shotCard.style.display = 'grid';
  requestAnimationFrame(() => miniLane(cv, an, { exag: 5, pinsBefore: shot.pinsBefore, pinsAfter: shot.pinsAfter }));
}

function setStatus(key, cls) {
  statusPill.className = 'pill ' + cls;
  statusPill.lastChild.textContent = t(key);
}
function updateTop() {
  if (!framePill) return;
  const pos = currentPosition();
  const g = buildGame(gameShots());
  framePill.innerHTML = '';
  framePill.append(t('h.game', { n: state.game }), ' · ', h('b', null, t('h.frame', { f: pos.frame })), ' · ', t('h.ball', { b: pos.ball }), g.total ? ' · ' + g.total : '');
  bowlerPill.innerHTML = '';
  const bc = state.bowler?.ballColor?.rgb;
  bowlerPill.append(bc ? h('span.swatch', { style: { background: `rgb(${bc})`, width: '14px', height: '14px' } }) : '', ' ', state.bowler?.name || '');
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
  $('#b-run').textContent = paused ? t('btn.start') : t('btn.pause');
  if (fileMode) { fileStop = paused; }
  setStatus(paused ? 'st.paused' : 'st.idle', paused ? '' : 'ok');
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
  else { pendingFps = fps; await startCalib(); return; }
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
  if (mode === 'calib') {
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
