// Worker: nimmt ImageBitmap / VideoFrame entgegen (oder liest selbst einen übertragenen Kamera-Track),
// skaliert auf Arbeitsauflösung und schneidet den Pin-Bereich in voller Auflösung aus.
import { Engine } from './engine.js';
import { autoLane } from './autolane.js';
import { snapCorners, snapNormalized } from './snap.js';
import { toGray } from './lk.js';
import { findCorners } from './autocorners.js';

const engine = new Engine();
let canvas = null, ctx = null, cropCanvas = null, cctx = null;
let lastFrame = null, workW = 640, reader = null, seq = 0, camFrames = 0;

const dims = (s) => [s.displayWidth || s.width, s.displayHeight || s.height];

function frameFrom(src) {
  const [sw, sh] = dims(src);
  const w = Math.min(workW, sw), h = Math.round(w * sh / sw);
  if (!canvas || canvas.width !== w || canvas.height !== h) {
    canvas = new OffscreenCanvas(w, h);
    ctx = canvas.getContext('2d', { willReadFrequently: true }); ctx.imageSmoothingQuality = 'high';
  }
  ctx.drawImage(src, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

function cropFrom(src, rect, max) {
  const [W, H] = dims(src);
  const sx = rect.x * W, sy = rect.y * H, sw = rect.w * W, sh = rect.h * H;
  const sc = Math.min(1, max / Math.max(sw, sh));
  const cw = Math.max(4, Math.round(sw * sc)), ch = Math.max(4, Math.round(sh * sc));
  if (!cropCanvas || cropCanvas.width !== cw || cropCanvas.height !== ch) {
    cropCanvas = new OffscreenCanvas(cw, ch);
    cctx = cropCanvas.getContext('2d', { willReadFrequently: true });
  }
  cctx.drawImage(src, sx, sy, sw, sh, 0, 0, cw, ch);
  const img = cctx.getImageData(0, 0, cw, ch);
  return { data: img.data, width: cw, height: ch, rect };
}

// ---- Kugel-Netz (eigener Worker) ----
// Bilder laufen in Reihenfolge durch die Engine. Geht ein Bild ans Netz, warten es und alle folgenden, bis die
// Erkennungen da sind (wenige Bilder Verzögerung); Bilder ohne Netz-Auftrag laufen sonst sofort durch.
const VERSION = new URL(import.meta.url).searchParams.get('v') || '';
let net = null, netReady = false, netBusy = false, netId = 0, netMs = 0, netState = 'aus';
const queue = [];
// Das Netz läuft in einem eigenen Worker, den die Seite startet (Worker aus Workern gehen nicht überall);
// verbunden über einen MessagePort.
function startNet() {
  if (net || netState !== 'aus') return;
  netState = 'lädt'; self.postMessage({ type: 'needNet' });
}
function attachNet(port) {
  net = port;
  net.onmessage = (e) => {
    const r = e.data;
    if (r.type === 'ready') {
      netReady = r.ok; netState = r.ok ? 'bereit' : 'fehler';
      self.postMessage({ type: 'netStatus', ok: r.ok, ms: r.ms, error: r.error });
      if (!r.ok) { net = null; drain(true); }
    } else if (r.type === 'dets') {
      netBusy = false; netMs = r.ms;
      const q = queue.find(x => x.id === r.id);
      if (q) { q.dets = r.dets.map(d => ({ ...d, x: d.x + q.rect.x, y: d.y + q.rect.y })); q.id = 0; }
      drain();
    } else if (r.type === 'error') self.postMessage({ type: 'error', message: 'Kugel-Netz: ' + r.message });
  };
  net.postMessage({ type: 'init', version: VERSION });
}
function netFailed(error) {
  netState = 'fehler'; netReady = false; netBusy = false; net = null;
  self.postMessage({ type: 'netStatus', ok: false, error }); drain(true);
}
function subImage(frame, r) {
  const out = new Uint8ClampedArray(r.w * r.h * 4), W = frame.width;
  for (let y = 0; y < r.h; y++) out.set(frame.data.subarray(((r.y + y) * W + r.x) * 4, ((r.y + y) * W + r.x + r.w) * 4), y * r.w * 4);
  return out;
}
function runFrame(q) {
  const t0 = performance.now();
  const res = { type: 'result', ...engine.process(q.frame, q.m.t, q.crop, q.dets) };
  res.t = q.m.t; res.ms = q.ms + performance.now() - t0; res.seq = q.m.seq; res.net = netState; res.netMs = netMs;
  if (q.late) res.late = true;
  self.postMessage(res, res.debug ? [res.debug.mask.buffer] : []);
}
// all = true: auch Bilder ohne Netz-Ergebnis abarbeiten (Netz ausgefallen, Kalibrierung, Ende)
function drain(all) {
  while (queue.length && (all || !queue[0].id || queue.length > 12)) {
    const q = queue.shift(); if (q.id) q.dets = null; runFrame(q);
  }
}

async function handle(m, src) {
  const t0 = performance.now();
  const frame = frameFrom(src);
  lastFrame = frame;
  let res;
  if (!m.calibrate && !m.auto && !m.snap && !m.sample) {
    // normales Bild
    const st = engine.state, needPins = engine.o.pinsEnabled && engine.cam && (st === 'settle' || st === 'roll');
    const rect = engine.cropRequest(m.t) || (queue.length && needPins ? engine.pinRect() : null);
    const q = { m, frame, crop: rect ? cropFrom(src, rect, engine.o.cropMax) : null, dets: null, id: 0, ms: 0 };
    if (engine.o.net && netReady && !netBusy && engine.ref) {
      const r = engine.netRect(m.t / 1000);
      if (r) { q.id = ++netId; q.rect = r; const d = subImage(frame, r); netBusy = true; net.postMessage({ type: 'det', id: q.id, data: d.buffer, width: r.w, height: r.h, conf: 0.1 }, [d.buffer]); }
    }
    q.ms = performance.now() - t0;
    if (!queue.length && !q.id) { runFrame(q); return; }
    q.late = true; queue.push(q);
    self.postMessage({ type: 'queued', seq: m.seq });
    return;
  }
  drain(true);
  if (m.calibrate) {
    res = { type: 'calibrated', info: engine.calibrate(frame, m.calibrate), w: frame.width, h: frame.height };
  } else if (m.auto) {
    res = await findCorners(frame, m.auto);
  } else if (m.snap) {
    res = { type: 'auto', ...snapNormalized(toGray(frame.data, frame.width, frame.height), frame.width, frame.height, m.snap.corners, m.snap.yTop || 18.288) };
  } else {
    res = { type: 'color', color: engine.sampleColor(frame, m.sample.x, m.sample.y, m.sample.r) };
  }
  res.t = m.t; res.ms = performance.now() - t0; res.seq = m.seq;
  self.postMessage(res, res.debug ? [res.debug.mask.buffer] : []);
}

// Eigener Lesekreis für übertragenen Track (Safari 18+, Chrome): jedes Kamerabild, exakte Zeitstempel
async function readTrack(track) {
  const proc = new self.MediaStreamTrackProcessor({ track });
  reader = proc.readable.getReader();
  self.postMessage({ type: 'trackOk' });
  let busy = false;
  for (;;) {
    const { value: vf, done } = await reader.read();
    if (done) break;
    camFrames++;
    if (busy || paused) { vf.close(); continue; }
    busy = true;
    try { handle({ t: vf.timestamp / 1000, seq: ++seq }, vf).catch(e => self.postMessage({ type: 'error', message: String(e) })); }
    catch (err) { self.postMessage({ type: 'error', message: String(err?.message || err) }); }
    vf.close(); busy = false;
  }
}
let paused = false;
setInterval(() => { if (reader) { self.postMessage({ type: 'camfps', n: camFrames }); camFrames = 0; } }, 1000);

self.onmessage = (e) => {
  const m = e.data;
  try {
    if (m.type === 'options') { if (m.workW) workW = m.workW; engine.setOptions(m.options); if (engine.o.net) startNet(); }
    else if (m.type === 'frame') { const src = m.bitmap || m.vf; try { handle(m, src).catch(e => self.postMessage({ type: 'error', message: String(e), seq: m.seq })); } finally { src.close?.(); } }
    else if (m.type === 'track') {
      if (!self.MediaStreamTrackProcessor) { self.postMessage({ type: 'trackFail' }); m.track.stop(); return; }
      readTrack(m.track).catch(err => self.postMessage({ type: 'trackFail', message: String(err) }));
    }
    else if (m.type === 'stopTrack') { reader?.cancel(); reader = null; }
    else if (m.type === 'netPort') attachNet(m.port);
    else if (m.type === 'netFail') netFailed(m.error);
    else if (m.type === 'pause') paused = !!m.on;
    else if (m.type === 'ballColor') engine.setBallColor(m.color);
    else if (m.type === 'pinsBefore') engine.setPinsBefore(m.pins);
    else if (m.type === 'reset') { drain(true); engine.resetShot(); }
    else if (m.type === 'flush') { drain(true); self.postMessage({ type: 'flushed', events: engine.flush(m.t) }); }
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err?.message || err), seq: m.seq });
  }
};
