// Live-Ansicht: Kamera, Ecken setzen, Kugel antippen, Overlay, Wurf-Ereignisse.
import { h, $, toast, buzz, beep, fmt, icon, sheet, confirmBox } from '../ui.js';
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
import { openShot, openSession } from './history.js';
import { mascot, setMood, mascotOn } from '../mascot.js';
import { recommend, applyChanges } from '../autotune.js';
import { lanes, activeLane, setActiveLane, saveLane, touchLane, deleteLane } from '../lanes.js';
import { relocate, grayOf, RW } from '../vision/relocate.js';

const CAL_KEY = 'bt.calib.v1';
let root, stage, video, ov, octx, freeze, fctx, loupe, lctx, debugCv, hint, statusPill, framePill, bowlerPill, hud, shotCard, progress;
let proc = null, cam = null, active = false, mode = 'live'; // live | calib | ball
let corners = [], handles = [], calibrated = false, last = null, lastShot = null;
let fileMode = false, fileStop = false, paused = false, wake = null, drawPending = false;
let quietUntil = 0, calPos = null;   // calPos: frei gezogene Höhe des Ecken-Menüs (px)   // kurz nach dem Kamerastart keine Signale (Fehlstarts beim Einpendeln)
let fileStart = 0;   // Video: Auswertung ab dem Bild, auf dem die Ecken geprüft wurden
let freezeBmp = null, pendingFps = 0, calBackup = null, pickLane = false, dock, calPanel, calTop = true, calSideManual = false;
let optCollect = null, welcomeOpen = false;
let lastCal = null, laneKeep = false;   // letzte Einrichtung (Referenzbild + Ecken) für Bahn-Profile
let selCorner = -1;   // gewählte Ecke zum Verschieben (Touchpad-artig von überall)
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
    dbtn('b-cal', 'corners', t('btn.setup'), () => startCalib()),
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
// Videos zeigen oft eine andere Kugel (fremde Aufnahmen): dort nur eine im Video angetippte Farbe verwenden
let fileBallColor = null;
export function syncBall() { proc?.post({ type: 'ballColor', color: (fileMode ? fileBallColor : state.bowler?.ballColor) || null }); }
export function syncPins() { proc?.post({ type: 'pinsBefore', pins: currentPosition().pinsBefore }); }

export async function showLive() {
  active = true;
  await ensureProc();
  updateTop();
  const q = new URLSearchParams(location.search);
  if (q.get('video') && !fileMode) { await openVideoUrl(q.get('video'), q); return; }
  // Kamera-Erlaubnis erst nach der Begrüßung anfragen (Kontext zuerst erklären)
  if (!fileMode && !localStorage.getItem('bt.welcome') && !q.get('video')) { await showWelcome(); if (!active) return; }
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
    proc.attach(video, cam.track); quietUntil = performance.now() + 6000;
    if (!calibrated && !(await autoFindLane()) && corners.length === 4 && !calibrated) await calibrateNow();
    setStatus(calibrated ? 'st.idle' : 'st.nocal', calibrated ? 'ok' : 'warn');
    if (!calibrated && S.get('autoWizard') && !welcomeOpen && !sessionStorage.getItem('bt.skipWizard')) startCalib();
  } catch (e) {
    const msg = e.code === 'https' ? t('cam.https') : e.code === 'denied' ? t('cam.denied') : t('st.nocam') + (e.message ? ' (' + e.message + ')' : '');
    hint.style.display = 'grid'; hint.firstChild.innerHTML = '';
    hint.firstChild.append(h('p', null, msg), h('div.cal-actions', { style: { justifyContent: 'center' } },
      h('button.pillbtn', { onclick: () => startCam() }, t('btn.retry')),
      h('button.pillbtn.primary', { onclick: pickFile }, icon('video'), t('file.short'))));
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
  mode = 'calib'; selCorner = -1; calSideManual = false; calTop = true; calPos = null;
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
  const steps = h('div.steps', null, names.map((nm, i) => h((n === 4 ? 'button' : 'div') + '.step' + (i < n ? '.done' : i === n && !pickLane ? '.cur' : '') + (n === 4 && i === selCorner ? '.sel' : ''),
    n === 4 ? { type: 'button', onclick: () => { selCorner = selCorner === i ? -1 : i; placeHandles(); calbar(true); } } : null,
    h('b', null, i < n ? (n === 4 && i === selCorner ? i + 1 : '✓') : i + 1), h('span', null, nm))));
  const msg = pickLane ? t('cal.pick') : n < 4 ? t('cal.tapAny', { n: n + 1 }) : selCorner >= 0 ? t('cal.moveSel', { p: names[selCorner] }) : t('cal.moveAny');
  calPanel.append(
    h('div.cal-head', null, h('b', null, t('cal.title')),
      h('span.cal-hbtns', null,
        h('button.iconbtn', { onclick: () => { calSideManual = true; setCalSide(!calTop); }, 'aria-label': t('cal.swap'), title: t('cal.swap') }, icon('swapv')),
        h('button.iconbtn', { onclick: cancelCalib, 'aria-label': t('btn.cancel') }, icon('close')))),
    steps, h('p.cal-msg', null, msg),
    h('div.cal-actions', null,
      h('button.pillbtn' + (pickLane ? '.on' : ''), { onclick: () => { if (pickLane) { pickLane = false; calbar(true); } else runAuto(null); } }, icon('magic'), t('cal.auto')),
      n === 4 ? h('button.pillbtn', { onclick: runSnap }, icon('corners'), t('cal.snap')) : null,
      !fileMode ? h('button.pillbtn', { onclick: lanesSheet }, icon('lanes'), t('lane.title')) : null,
      h('button.pillbtn', { onclick: () => { corners = []; pickLane = false; selCorner = -1; placeHandles(); calbar(true); requestDraw(); }, disabled: !n }, icon('reset'), t('btn.reset')),
      h('button.pillbtn', { onclick: cancelCalib }, t('btn.cancel')),
      h('button.pillbtn.primary', { disabled: n !== 4, onclick: finishCalib }, icon('check'), t('btn.apply'))));
  calPanel.style.display = 'block';
  calPanel.querySelector('.cal-head').addEventListener('pointerdown', dragPanel);
  if (calPos != null) placePanel(calPos); else { setCalSide(calTop); autoCalSide(); }
}
// Menü am Kopf frei nach oben/unten ziehen
function placePanel(y) {
  const P = calPanel.offsetParent || root, maxY = Math.max(0, P.clientHeight - calPanel.offsetHeight - 4);
  calPos = Math.max(4, Math.min(maxY, y));
  calPanel.style.top = calPos + 'px'; calPanel.style.bottom = 'auto';
  stage.parentElement?.classList.toggle('cal-top', calPos < 60);
  fitCalStage();
}
function dragPanel(e) {
  if (e.target.closest('button')) return;
  e.preventDefault(); calSideManual = true;
  const el = e.currentTarget, y0 = e.clientY, top0 = calPanel.offsetTop;
  el.setPointerCapture(e.pointerId); calPanel.classList.add('drag');
  const move = (ev) => placePanel(top0 + ev.clientY - y0);
  const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); calPanel.classList.remove('drag'); };
  el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
}
// Menü oben oder unten – nie über den Ecken, die man gerade setzt oder schiebt
function setCalSide(top) { calTop = top; calPos = null; calPanel.style.top = ''; calPanel.style.bottom = ''; calPanel.classList.toggle('top', top); stage.parentElement?.classList.toggle('cal-top', top && mode === 'calib'); fitCalStage(); }
function autoCalSide(pt) {
  if (calPanel.style.display === 'none') return;
  if (!calSideManual) {
    const { nTop, nBot } = coveredCorners(pt);
    if (calTop && nTop > nBot) setCalSide(false);
    else if (!calTop && nBot > nTop) setCalSide(true);
  }
  fitCalStage();
}
// Wie viele Ecken lägen unter dem Menü oben bzw. unten? (gerechnet mit der vollen Bildfläche, ohne Einrückung)
function coveredCorners(pt) {
  const P = (stage.parentElement || stage).getBoundingClientRect(), [vw, vh] = freezeBmp ? [freezeBmp.width, freezeBmp.height] : vidSize();
  const s = Math.min(P.width / vw, P.height / vh), y0 = (P.height - vh * s) / 2, H = calPanel.getBoundingClientRect().height + 14;   // Griff ~14 px
  const pts = corners.map(c => P.top + y0 + c[1] * vh * s);
  if (pt) pts.push(pt);
  return { nTop: pts.filter(y => y < P.top + H).length, nBot: pts.filter(y => y > P.bottom - H).length };
}
// Verdeckt das Menü auf beiden Seiten Ecken (Hochformat-Video), das Bild neben dem Menü etwas kleiner zeigen
function fitCalStage() {
  let top = '', bottom = '';
  if (mode === 'calib' && calPanel.style.display !== 'none' && calPos == null && corners.length) {
    const { nTop, nBot } = coveredCorners();
    if (calTop ? nTop : nBot) {
      const P = (stage.parentElement || stage).getBoundingClientRect(), pr = calPanel.getBoundingClientRect();
      if (calTop) top = Math.round(pr.bottom - P.top + 6) + 'px'; else bottom = Math.round(P.bottom - pr.top + 6) + 'px';
    }
  }
  if (stage.style.top === top && stage.style.bottom === bottom) return;
  stage.style.top = top; stage.style.bottom = bottom;
  placeHandles(); requestDraw();
}
function cancelCalib() {
  // vorherige Ecken wiederherstellen, die Kalibrierung bleibt wie sie war
  if (calBackup) corners = calBackup;
  calBackup = null; pickLane = false; laneKeep = false;
  endMode();
}
// grob gesetzte Ecken an die Bahnkanten und die Foul-Linie ziehen (sichtbar, vor dem Übernehmen)
async function runSnap() {
  if (corners.length !== 4) return;
  const src = freezeBmp ? await createImageBitmap(freezeBmp) : await grabFrame();
  if (!src) return;
  calPanel.classList.add('busy');
  const r = await proc.request(src, { snap: { corners: orderCorners(corners), yTop: topLineY(S.get('topLine')) } });
  calPanel.classList.remove('busy');
  if (r.corners) { corners = r.corners; selCorner = -1; buzz(); toast(t('cal.snapOk'), 'ok'); }
  else toast(t('cal.snapFail'), 'bad');
  placeHandles(); calbar(true); requestDraw();
}
async function runAuto(target) {
  calPanel.classList.add('busy');
  // Video: mehrere Bilder der ersten Sekunden prüfen (der Spieler verdeckt anfangs oft Foul-Linie und Anlauf)
  const r = fileMode && !target && video.duration > 1 ? await autoMulti() : await autoOne(target);
  calPanel.classList.remove('busy');
  if (!r) return;
  pickLane = false;
  if (r.t != null) { fileStart = r.t; if (freezeBmp) { unfreeze(); await doFreeze(); } }
  if (r.corners) { corners = r.ordered ? r.corners : orderCorners(r.corners); selCorner = -1; buzz(); toast(t('cal.autoOk'), 'ok'); }
  else if (!target) { pickLane = true; toast(t('cal.pick')); }   // Modell unsicher: Bahn antippen lassen
  else toast(t('cal.autoFail'), 'bad');
  placeHandles(); calbar(true); requestDraw();
}
async function autoOne(target, src) {
  src = src || (freezeBmp ? await createImageBitmap(freezeBmp) : await grabFrame());
  if (!src) return null;
  return proc.request(src, { auto: { target, yTop: topLineY(S.get('topLine')) } });
}
// Bahn auf bis zu 13 Bildern (0–6 s) suchen; es gewinnt die Gruppe gleicher Ergebnisse auf den meisten Bildern,
// daraus je Ecke der Median: eine Ecke, die nur auf manchen Bildern auf den Spieler rutscht, fällt heraus
async function autoMulti() {
  const t0 = video.currentTime, found = [];
  let last = -1;
  const seek = (t) => new Promise(res => { video.onseeked = () => { video.onseeked = null; res(); }; video.currentTime = t; });
  for (let i = 0; i < 13; i++) {
    const tt = Math.min(t0 + i * 0.5, video.duration - 0.1);
    if (tt <= last) break;
    last = tt;
    if (i || Math.abs(video.currentTime - tt) > 0.01) await seek(tt);
    const bmp = await grabFrame();
    const r = bmp && await proc.request(bmp, { auto: { yTop: topLineY(S.get('topLine')) } });
    if (r?.corners) found.push({ t: tt, r, c: r.ordered ? r.corners : orderCorners(r.corners) });
    if (tt >= video.duration - 0.1) break;
  }
  if (!found.length) { if (Math.abs(video.currentTime - t0) > 0.01) await seek(t0); return { error: 'pick' }; }
  const S2 = found.map(a => found.map(b => quadIoU(a.c, b.c)));
  const sup = S2.map(row => row.filter(v => v > 0.6).length - 1);
  let best = 0;
  found.forEach((_, i) => { if (sup[i] > sup[best] || (sup[i] === sup[best] && S2[i].reduce((x, y) => x + y) > S2[best].reduce((x, y) => x + y))) best = i; });
  const grp = found.filter((_, j) => S2[best][j] > 0.6).map(a => a.c);
  const med = (xs) => { const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const c = [0, 1, 2, 3].map(k => [med(grp.map(q => q[k][0])), med(grp.map(q => q[k][1]))]);
  // Ab dem frühesten Bild der Gruppe auswerten und dieses Bild zeigen (schwenkt die Kamera, passen die Ecken nur dort)
  const tStart = Math.min(...found.filter((_, j) => S2[best][j] > 0.6).map(a => a.t));
  if (Math.abs(video.currentTime - tStart) > 0.01) await seek(tStart);
  return { ...found[best].r, corners: c, ordered: true, t: tStart };
}
// Überlappung zweier Bahn-Vierecke (normiert, FoulL, FoulR, KopfL, KopfR) auf einem 96er-Raster
function quadIoU(a, b) {
  const inside = (q, x, y) => { let s = 0; for (let i = 0; i < 4; i++) { const p = q[i], n = q[(i + 1) % 4], z = (n[0] - p[0]) * (y - p[1]) - (n[1] - p[1]) * (x - p[0]); if (z) { if (s && Math.sign(z) !== s) return false; s = Math.sign(z); } } return true; };
  const A = [a[0], a[1], a[3], a[2]], B = [b[0], b[1], b[3], b[2]];
  let i = 0, u = 0;
  for (let y = 0.5; y < 96; y++) for (let x = 0.5; x < 96; x++) { const ia = inside(A, x / 96, y / 96), ib = inside(B, x / 96, y / 96); if (ia && ib) i++; if (ia || ib) u++; }
  return u ? i / u : 0;
}
function placeHandles() {
  handles.forEach(x => x.remove()); handles = [];
  if (mode !== 'calib' && !(mode === 'wizard' && wiz?.step === 2)) return;
  const R = viewRect();
  corners.forEach((c, i) => {
    const [x, y] = toScreen(c[0], c[1], R);
    const el = h('div.handle' + (i === selCorner ? '.sel' : ''), { style: { left: x + 'px', top: y + 'px' } }, h('span', null, i + 1));
    el.addEventListener('pointerdown', (e) => dragHandle(e, i));
    stage.append(el); handles.push(el);
  });
}
function dragHandle(e, i, from) {
  e.stopPropagation(); e.preventDefault();
  if (selCorner !== i) { selCorner = i; handles.forEach((x, k) => x.classList.toggle('sel', k === i)); if (mode === 'calib') calbar(true); }
  const el = handles[i];
  const cap = from || el;
  cap.setPointerCapture(e.pointerId);
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
  const up = () => { if (mode === 'calib') autoCalSide(); cap.removeEventListener('pointermove', move); cap.removeEventListener('pointerup', up); cap.removeEventListener('pointercancel', up); loupe.style.display = 'none'; };
  cap.addEventListener('pointermove', move); cap.addEventListener('pointerup', up); cap.addEventListener('pointercancel', up);
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
  // Bahnkanten zu den anderen Ecken zur Orientierung (gleiche Linien wie im großen Bild)
  if (corners.length >= 2) {
    const k = 240 / sz, L = (c) => [120 + (c[0] - nx) * vw * k, 120 + (c[1] - ny) * vh * k];
    const edges = corners.length === 4 ? [[0, 1], [1, 3], [3, 2], [2, 0]] : corners.slice(1).map((_, i) => [i, i + 1]);
    lctx.setLineDash([]); lctx.lineCap = 'round';
    for (const [col, lw] of [['rgba(0,0,0,.55)', 4], ['#4f8cff', 2]]) {
      lctx.strokeStyle = col; lctx.lineWidth = lw; lctx.beginPath();
      for (const [i, j] of edges) { const A = L(corners[i]), B = L(corners[j]); lctx.moveTo(A[0], A[1]); lctx.lineTo(B[0], B[1]); }
      lctx.stroke();
    }
  }
  lctx.strokeStyle = '#ff0'; lctx.lineWidth = 1.5;
  lctx.beginPath(); lctx.moveTo(120, 100); lctx.lineTo(120, 140); lctx.moveTo(100, 120); lctx.lineTo(140, 120); lctx.stroke();
  loupe.style.display = 'block';
  loupe.style.left = Math.min(R.sw - 125, Math.max(5, x - 60)) + 'px';
  loupe.style.top = (y > 150 ? y - 150 : y + 30) + 'px';
}
async function finishCalib() {
  if (corners.length !== 4) { toast(t('cal.hint', { p: '4' })); return; }
  // nur umsortieren, wenn die Reihenfolge nicht stimmen kann (Auto/Modell und nummerierte Griffe sind schon geordnet;
  // bei sehr schräger Sicht hält die Form-Regel sonst eine Bahnkante für die Foul-Linie)
  if (!cornersPlausible(corners)) corners = orderCorners(corners);
  if (!fileMode) localStorage.setItem(CAL_KEY, JSON.stringify(corners));
  await calibrateNow(freezeBmp ? await createImageBitmap(freezeBmp) : null);
  calBackup = null; pickLane = false;
  endMode();
  if (fileMode && pendingFps) { const f = pendingFps; pendingFps = 0; video.currentTime = fileStart; await new Promise(r => { video.onseeked = r; }); runFile(f); }
}
// Ecken in die feste Reihenfolge bringen: Foul-Linie (unten im Bild) links/rechts, dann Kopfpins links/rechts.
// Verhindert eine über Kreuz eingemessene Bahn, wenn die Ecken in anderer Reihenfolge getippt wurden.
// Ecken in beliebiger Reihenfolge: Rollen aus der Form bestimmen (Foul-Linie links/rechts, Kopfpin-Linie links/rechts).
// Die vier Punkte werden zum Viereck geordnet; die beiden längeren gegenüberliegenden Seiten sind die Bahnkanten,
// von den kurzen Seiten ist die breitere die Foul-Linie (näher an der Kamera). Links/rechts aus der Blickrichtung.
// FoulL, FoulR, KopfL, KopfR: Viereck ohne Überkreuzung, Foul-Linie tiefer im Bild als die Kopfpin-Linie,
// links liegt links (an beiden Enden)
function cornersPlausible(c) {
  if (!c || c.length !== 4) return false;
  const [vw, vh] = vidSize(), p = c.map(([x, y]) => [x * vw, y * vh]);
  const q = [p[0], p[1], p[3], p[2]];
  let s = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4], d = q[(i + 2) % 4];
    const z = (b[0] - a[0]) * (d[1] - b[1]) - (b[1] - a[1]) * (d[0] - b[0]);
    if (!z) return false;
    if (s && Math.sign(z) !== s) return false;
    s = Math.sign(z);
  }
  return (p[0][1] + p[1][1]) / 2 > (p[2][1] + p[3][1]) / 2 && p[0][0] < p[1][0] && p[2][0] < p[3][0];
}
function orderCorners(c) {
  if (!c || c.length !== 4) return c;
  const [vw, vh] = vidSize(), px = c.map(([x, y]) => [x * vw, y * vh]);
  const cx = px.reduce((s, p) => s + p[0], 0) / 4, cy = px.reduce((s, p) => s + p[1], 0) / 4;
  const ord = [0, 1, 2, 3].sort((i, j) => Math.atan2(px[i][1] - cy, px[i][0] - cx) - Math.atan2(px[j][1] - cy, px[j][0] - cx));
  const L = (i, j) => Math.hypot(px[ord[i]][0] - px[ord[j]][0], px[ord[i]][1] - px[ord[j]][1]);
  // Seitenpaare: (0-1, 2-3) oder (1-2, 3-0). Querlinien (Foul, Kopfpin) sind im Bild meist paralleler und kürzer als die
  // Bahnkanten, die auf den Fluchtpunkt zulaufen. Beides zusammen gewichtet (an 3450 Blender- und Videobildern fehlerfrei,
  // nur Länge: 37 Fehler – z. B. ferne, kurz wirkende Bahnen oder seitliche Blickwinkel)
  const ang = (a, b, c2, d) => {
    const u = [px[ord[b]][0] - px[ord[a]][0], px[ord[b]][1] - px[ord[a]][1]], v = [px[ord[d]][0] - px[ord[c2]][0], px[ord[d]][1] - px[ord[c2]][1]];
    return Math.acos(Math.min(1, Math.abs(u[0] * v[0] + u[1] * v[1]) / (Math.hypot(...u) * Math.hypot(...v) || 1))) * 180 / Math.PI;
  };
  const angA = ang(0, 1, 3, 2), angB = ang(1, 2, 0, 3);
  const pairA = L(0, 1) + L(2, 3), pairB = L(1, 2) + L(3, 0);
  const aIsCross = (angA - angB) + 40 * Math.log(pairA / pairB) < 0;
  const short = aIsCross ? [[0, 1], [2, 3]] : [[1, 2], [3, 0]];
  const len = (s) => L(s[0], s[1]), meanY = (s) => (px[ord[s[0]]][1] + px[ord[s[1]]][1]) / 2;
  let [foul, top] = short;
  const lf = len(foul), lt = len(top);
  if (lt > lf * 1.05 || (Math.abs(lt - lf) <= lf * 0.05 && meanY(top) > meanY(foul))) [foul, top] = [top, foul];
  const mid = (s) => [(px[ord[s[0]]][0] + px[ord[s[1]]][0]) / 2, (px[ord[s[0]]][1] + px[ord[s[1]]][1]) / 2];
  const mf = mid(foul), mt = mid(top), up = [mt[0] - mf[0], mt[1] - mf[1]];
  // links: negatives Kreuzprodukt (Bildkoordinaten, y nach unten)
  const lr = (s, m) => { const [i, j] = s.map(k => ord[k]); const cr = (q) => up[0] * (px[q][1] - m[1]) - up[1] * (px[q][0] - m[0]); return cr(i) < cr(j) ? [i, j] : [j, i]; };
  const [fl, fr] = lr(foul, mf), [tl, tr] = lr(top, mt);
  return [fl, fr, tl, tr].map(i => [...c[i]]);
}
async function calibrateNow(bmp) {
  bmp = bmp || await grabFrame();
  if (!bmp) return;
  const thumb = fileMode ? null : thumbOf(bmp);   // vor dem Senden: das Bild geht an die Auswertung
  const r = await proc.request(bmp, { calibrate: corners });
  if (r.type === 'calibrated') {
    if (window.__evlog) window.__evlog.push('kal t' + video.currentTime.toFixed(2) + ' start' + fileStart + ' ' + JSON.stringify(r.info.corners));
    calibrated = true; toast(t('cal.ok', { n: r.info.features }) + (r.info.snapped ? ' · ' + t('cal.snapped') : ''), 'ok');
    if (r.info.corners) { corners = r.info.corners.map(c => [...c]); if (!fileMode) try { localStorage.setItem(CAL_KEY, JSON.stringify(corners)); } catch { /* */ } } setStatus('st.idle', 'ok'); syncPins();
    if (thumb) { lastCal = { img: thumb, corners: corners.map(c => [...c]) }; laneAfterCal(); }
  } else toast(r.message || 'Fehler', 'bad');
}

// ---------- Bahn-Profile ----------
function thumbOf(src) {
  const sw = src.width || src.videoWidth, sh = src.height || src.videoHeight;
  const c = h('canvas', { width: RW, height: Math.round(RW * sh / sw) });
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.72);
}
const imgOf = (url) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
async function grayUrl(url) { const i = await imgOf(url); return grayOf(i, i.naturalWidth, i.naturalHeight); }
async function matchLane(p, B) { try { return relocate(await grayUrl(p.img), B, p.corners); } catch { return { ok: false }; } }
const sure = (r) => r.ok && r.q >= 0.4 && r.plane >= 15;
// Nach jeder Einrichtung: gehört sie zur aktiven Bahn (gleiche Szene), wird das Profil aufgefrischt, sonst ist keine Bahn aktiv
async function laneAfterCal() {
  const a = activeLane(), cal = lastCal;
  const keep = laneKeep;
  laneKeep = false;
  if (!a || !cal) return;
  const same = keep || (await matchLane(a, await grayUrl(cal.img))).ok;
  if (same) touchLane(a.id, { img: cal.img, corners: cal.corners }); else setActiveLane(null);
}
// Beim Kamerastart: passende gespeicherte Bahn im Bild suchen
async function autoFindLane() {
  const L = lanes();
  if (fileMode || !L.length) return false;
  let bmp = null;
  for (let i = 0; i < 20 && !(bmp = await grabFrame()); i++) await new Promise(r => setTimeout(r, 100));
  if (!bmp) return false;
  const B = grayOf(bmp, bmp.width, bmp.height), act = activeLane()?.id;
  let best = null;
  for (const p of [...L].sort((x, y) => (y.id === act) - (x.id === act)).slice(0, 10)) {
    const r = await matchLane(p, B);
    if (sure(r) && (!best || r.count > best.r.count)) best = { p, r };
  }
  if (!best) { bmp.close?.(); return false; }
  corners = best.r.corners.map(c => [...c]); setActiveLane(best.p.id); laneKeep = true;
  await calibrateNow(bmp);
  if (calibrated) toast(t('lane.found', { n: best.p.name }), 'ok');
  return calibrated;
}
async function loadLane(p) {
  const bmp = await grabFrame();
  if (!bmp) return;
  const r = await matchLane(p, grayOf(bmp, bmp.width, bmp.height));
  if (window.__evlog) window.__evlog.push('lane ' + p.name + ' ' + JSON.stringify({ ok: r.ok, q: r.q, plane: r.plane, why: r.why }));
  setActiveLane(p.id); touchLane(p.id);
  if (sure(r)) {
    endMode(); corners = r.corners.map(c => [...c]); laneKeep = true;
    await calibrateNow(bmp);
    toast(t('lane.loaded', { n: p.name }), 'ok');
  } else {
    // unsicher: Ecken als Vorschlag zeigen, Nutzer prüft und übernimmt
    bmp.close?.();
    await startCalib();
    corners = (r.ok ? r.corners : p.corners).map(c => [...c]); laneKeep = !!r.ok;
    placeHandles(); calbar(true); requestDraw();
    toast(t(r.ok ? 'lane.check' : 'lane.moved', { n: p.name }), r.ok ? '' : 'warn');
  }
}
async function saveLaneFlow() {
  if (!calibrated || !lastCal || fileMode) { toast(t('lane.nocal'), 'warn'); return; }
  const a = activeLane();
  const inp = h('input.inp', { value: a?.name || t('lane.def', { n: lanes().length + 1 }), placeholder: t('lane.name'), 'aria-label': t('lane.name') });
  setTimeout(() => { inp.focus(); inp.select(); }, 250);
  const v = await sheet(t('lane.save'), h('div', null, inp), [{ label: t('btn.cancel'), value: null }, { label: t('btn.save'), value: 'ok', primary: true }]);
  const name = inp.value.trim();
  if (v !== 'ok' || !name) return;
  const l = saveLane({ id: a && a.name === name ? a.id : undefined, name, img: lastCal.img, corners: lastCal.corners });
  if (!l) { toast(t('lane.full'), 'bad'); return; }
  setActiveLane(l.id); toast(t('lane.saved', { n: l.name }), 'ok');
}
async function lanesSheet() {
  const L = lanes(), act = activeLane()?.id;
  let pick = null;
  const closeS = () => [...document.querySelectorAll('.sheet-wrap')].pop()?.querySelector('.sheet-head button')?.click();
  const day = (ms) => new Date(ms).toLocaleDateString(undefined, { day: '2-digit', month: '2-digit', year: '2-digit' });
  const body = h('div.lanelist', null, L.length ? L.map(l => h('div.lanerow' + (l.id === act ? '.on' : ''), null,
    h('button.lanepick', { type: 'button', onclick: () => { pick = { load: l }; closeS(); } },
      h('img', { src: l.img, alt: '' }),
      h('span', null, h('b', null, l.name), h('small', null, (l.id === act ? t('lane.active') + ' · ' : '') + t('lane.used', { d: day(l.used || l.created) })))),
    h('button.iconbtn', { type: 'button', 'aria-label': t('btn.delete'), title: t('btn.delete'), onclick: () => { pick = { del: l }; closeS(); } }, icon('close'))))
    : h('p.muted', null, t('lane.none')));
  const v = await sheet(t('lane.title'), body, fileMode ? [] : [{ label: t('lane.save'), value: 'save', primary: true }]);
  if (v === 'save') return saveLaneFlow();
  if (pick?.load) return loadLane(pick.load);
  if (pick?.del) { if (await confirmBox(t('lane.del', { n: pick.del.name }))) deleteLane(pick.del.id); return lanesSheet(); }
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
          if (fileMode && pendingFps) { const f = pendingFps; pendingFps = 0; video.currentTime = fileStart; video.onseeked = () => { video.onseeked = null; runFile(f); }; }
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
  let done;
  const p = new Promise(r => { done = r; });
  const close = (setup) => {
    welcomeOpen = false; el.classList.add('out'); setTimeout(() => el.remove(), 220);
    try { localStorage.setItem('bt.welcome', '1'); } catch { /* */ }
    if (!setup) sessionStorage.setItem('bt.skipWizard', '1');
    done(setup);
  };
  const el = h('div.welcome', null, h('div.welcome-card', null,
    mascotOn() ? mascot('happy', { cls: 'm-welcome' }) : null,
    h('h2', null, t('w.title')),
    h('ul', null, h('li', null, t('w.p1')), h('li', null, t('w.p2')), h('li', null, t('w.p3'))),
    h('div.cal-actions', null,
      h('button.pillbtn', { onclick: () => close(false) }, t('w.skip')),
      h('button.pillbtn.primary.big', { onclick: () => close(true) }, t('w.start')))));
  root.append(el);
  return p;
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
    if (fileMode) fileBallColor = r.color;   // nur für dieses Video, die Kugel des Spielers bleibt
    else {
      state.bowler.ballColor = r.color;
      const { saveBowler } = await import('../store.js');
      await saveBowler(state.bowler);
    }
    syncBall();
    toast(t('ball.ok'), 'ok'); buzz();
    if (mode !== 'wizard') endMode();
  } else toast(t('ball.none'), 'bad');
}

function endMode() {
  if (wiz) { clearInterval(wiz.timer); wiz = null; }
  optCollect = null;
  mode = 'live';
  calbar(false); stage.parentElement?.classList.remove('cal-top'); stage.style.top = stage.style.bottom = '';
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
  } else if (mode === 'calib' && corners.length === 4 && handles.length === 4) {
    // Touchpad: irgendwo ziehen bewegt die gewählte Ecke (sonst die nächste) – auch Ecken am Bildrand erreichbar
    let i = selCorner;
    if (i < 0) {
      const R = viewRect(); let best = 1e9;
      corners.forEach((c, k) => { const [x, y] = toScreen(c[0], c[1], R); const d = Math.hypot(x - e.clientX + R.left, y - e.clientY + R.top); if (d < best) { best = d; i = k; } });
    }
    dragHandle(e, i, stage);
  } else if (mode === 'calib' && corners.length < 4) {
    const n = toNorm(e.clientX, e.clientY);
    if (n[0] < 0 || n[0] > 1 || n[1] < 0 || n[1] > 1) return;
    corners.push(n); if (corners.length === 4) { corners = orderCorners(corners); selCorner = -1; } placeHandles(); calbar(true); requestDraw();
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
  if (window.__evlog) { const L = window.__evlog; L.n = (L.n || 0) + 1; if (L.st !== m.state || L.n % 15 === 0) L.push((video.currentTime || 0).toFixed(2) + ' ' + (L.st = m.state) + ' ok' + (m.ok ? 1 : 0) + ' q' + (m.quality || 0).toFixed(2) + ' akt' + (m.active || 0)); for (const ev of m.events || []) L.push((video.currentTime || 0).toFixed(2) + ' ev ' + ev.type + (ev.why ? ' ' + JSON.stringify({ why: ev.why, gap: ev.gap, y: ev.y, span: ev.span, vy: ev.vy, n: ev.n }) : '')); }
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
  if (ev.type === 'start') { if (performance.now() > quietUntil && last?.ok !== false && mode === 'live') { buzz(20); beep(660); } }
  else if (ev.type === 'abort') { toast(t('shot.abort')); }
  else if (ev.type === 'shot') {
    if (window.__evlog) window.__evlog.pts = ev.shot?.points;
    if (window.__evlog) window.__evlog.push('pins ' + JSON.stringify(ev.shot?.pinsAfter) + ' ' + JSON.stringify(Object.fromEntries(Object.entries(ev.shot?.pinDetail || {}).map(([k, v]) => [k, [v.state, v.ratio, v.vis]]))));
    if (fileMode && S.get('fileOneShot')) fileEarly = true;   // Video: nach dem ersten Wurf samt Pins aufhören
    let done; savingShot = new Promise(r => { done = r; });
    try { await saveShotEvent(ev); } finally { done(); }
  }
}
async function saveShotEvent(ev) {
  {
    if (performance.now() > quietUntil) { buzz(60); beep(990, 0.12); }
    if (!S.get('autoSave') && !confirm(t('btn.save') + '?')) return;
    const shot = await addShot(ev.shot, { source: fileMode ? 'file' : 'camera' });
    if (fileMode) { fileShots++; fileShotList.push(shot); }
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
  if (fileMode) { if (paused) video.pause(); else video.play().catch(() => { }); }
  setStatus(paused ? 'st.paused' : 'st.idle', paused ? '' : 'ok');
}
async function moreMenu() {
  const item = (val, ic, label, sub) => ({ value: val, label, icon: ic, sub });
  const v = await sheet(t('btn.more'), null, [], { menu: [
    ...(fileMode ? [item('closefile', 'close', t('file.close'))] : []),
    ...(fileMode ? [] : [item('lanes', 'lanes', t('lane.title'), activeLane()?.name || t('lane.sub', { n: lanes().length }))]),
    item('file', 'video', t('btn.file'), t('file.short')),
    item('game', 'pins', t('h.scorecard')),
    item('fs', 'expand', t('btn.fullscreen')),
  ] });
  if (v === 'closefile') closeFile(); else if (v === 'lanes') lanesSheet(); else if (v === 'file') pickFile(); else if (v === 'fs') toggleFullscreen(); else if (v === 'game') showGame();
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
let camCorners = null, fileShots = 0, fileShotList = [], fileEarly = false, savingShot = null;
async function openVideoUrl(url, q) {
  if (!fileMode) camCorners = corners.length === 4 ? corners.map(c => [...c]) : null;
  fileMode = true; fileStop = true; fileShots = 0; fileShotList = [];
  fileBallColor = null; syncBall();
  await new Promise(r => setTimeout(r, 50));
  fileStop = false; calibrated = false; unfreeze();
  proc.stop(); stopStream(cam?.stream); cam = null;
  video.srcObject = null; video.autoplay = false; video.removeAttribute('autoplay'); video.src = url; video.muted = true;
  await new Promise((r, j) => { video.onloadeddata = r; video.onerror = () => j(new Error('Video')); }).catch(e => toast(e.message, 'bad'));
  hint.style.display = 'none';
  toast(t('file.hint'));
  const fps = +(q.get('fps') || 0) || await estimateFps(video);
  video.pause(); await new Promise(r => setTimeout(r, 50)); video.pause();
  video.currentTime = 0.001; fileStart = 0;
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
          if (r.color) { fileBallColor = r.color; syncBall(); }
          video.currentTime = 0; await new Promise(r => { video.onseeked = r; });
        }
      }
    } catch (e) { console.warn('GT', e); }
  }
  else corners = [];          // jedes Video hat seinen eigenen Blickwinkel: Ecken auf dem ersten Bild neu setzen
  if (q.get('corners')) corners = JSON.parse(q.get('corners'));
  if (corners.length === 4) await calibrateNow();
  else { pendingFps = fps; toast(t('file.corners')); await startCalib(); return; }
  await runFile(fps);
}
async function runFile(fps) {
  fileStop = false; fileEarly = false;
  window.__fileDone = false;
  if (paused) togglePause();
  setStatus('file.running', 'ok');
  await proc.runFile(video, fps, (i, n) => { progress.style.transform = `scaleX(${i / n})`; }, () => fileStop || fileEarly || !active);
  await new Promise(r => setTimeout(r, 700));   // letzter Wurf (Abschluss am Videoende) kommt etwas später
  if (savingShot) await savingShot;             // Speichern/Pins-Bestätigung abwarten
  window.__fileDone = true;
  progress.style.transform = 'scaleX(0)';
  if (fileStop || !fileMode) return;
  setStatus('file.ended', '');
  const n = fileShots;
  // Wurf erkannt: Video schließen und direkt die Auswertung zeigen (ein Wurf: der Wurf, mehrere: die Session)
  if (n) {
    const list = fileShotList.slice();
    toast(t('file.found', { n }), 'ok');
    await closeFile(false);
    if (n === 1) openShot(list[0]); else openSession(list[0].sessionId);
    return;
  }
  const acts = [{ label: t('file.again'), value: 'again' }, { label: t('file.toCam'), value: 'cam', primary: true }];
  const body = h('div', null, h('p', null, t('file.none')),
    h('ul.tips', null, h('li', null, t('file.tip1')), h('li', null, t('file.tip2')), h('li', null, t('file.tip3'))));
  const v = await sheet(t('file.result'), body, acts);
  if (v === 'again') { corners = []; calibrated = false; pendingFps = fps; video.currentTime = 0.001; fileStart = 0; await new Promise(r => { video.onseeked = r; }); await startCalib(); }
  else if (v === 'cam') closeFile();
}
// Video schließen: zurück zur Kamera mit deren Einrichtung
async function closeFile(restartCam = true) {
  if (!fileMode) return;
  fileStop = true; pendingFps = 0;
  endMode(); unfreeze();
  video.pause(); video.onended = null; video.removeAttribute('src'); video.load(); video.autoplay = true;
  fileMode = false; calibrated = false;
  corners = camCorners || []; camCorners = null;
  fileBallColor = null; syncBall();
  progress.style.transform = 'scaleX(0)';
  if (paused) togglePause();
  const q = new URLSearchParams(location.search);
  if (q.get('video')) history.replaceState(null, '', location.pathname + location.hash);
  if (active && restartCam) await startCam();
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
      // nur ein dünner Strich vom Fuß bis zur Pinspitze (bei schräger Sicht liegen die Pins dicht beieinander)
      c.strokeStyle = 'rgba(228,87,46,.9)'; c.lineWidth = 1;
      if (top) { c.beginPath(); c.moveTo(...b); c.lineTo(...top); c.stroke(); }
      else { c.fillStyle = 'rgba(228,87,46,.9)'; c.beginPath(); c.arc(b[0], b[1], 1.2, 0, 7); c.fill(); }
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
