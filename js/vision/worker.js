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

async function handle(m, src) {
  const t0 = performance.now();
  const frame = frameFrom(src);
  lastFrame = frame;
  let res;
  if (m.calibrate) {
    res = { type: 'calibrated', info: engine.calibrate(frame, m.calibrate), w: frame.width, h: frame.height };
  } else if (m.auto) {
    res = await findCorners(frame, m.auto);
  } else if (m.snap) {
    res = { type: 'auto', ...snapNormalized(toGray(frame.data, frame.width, frame.height), frame.width, frame.height, m.snap.corners, m.snap.yTop || 18.288) };
  } else if (m.sample) {
    res = { type: 'color', color: engine.sampleColor(frame, m.sample.x, m.sample.y, m.sample.r) };
  } else {
    const rect = engine.cropRequest(m.t);
    const crop = rect ? cropFrom(src, rect, engine.o.cropMax) : null;
    res = { type: 'result', ...engine.process(frame, m.t, crop) };
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
    if (m.type === 'options') { if (m.workW) workW = m.workW; engine.setOptions(m.options); }
    else if (m.type === 'frame') { const src = m.bitmap || m.vf; try { handle(m, src).catch(e => self.postMessage({ type: 'error', message: String(e), seq: m.seq })); } finally { src.close?.(); } }
    else if (m.type === 'track') {
      if (!self.MediaStreamTrackProcessor) { self.postMessage({ type: 'trackFail' }); m.track.stop(); return; }
      readTrack(m.track).catch(err => self.postMessage({ type: 'trackFail', message: String(err) }));
    }
    else if (m.type === 'stopTrack') { reader?.cancel(); reader = null; }
    else if (m.type === 'pause') paused = !!m.on;
    else if (m.type === 'ballColor') engine.setBallColor(m.color);
    else if (m.type === 'pinsBefore') engine.setPinsBefore(m.pins);
    else if (m.type === 'reset') engine.resetShot();
    else if (m.type === 'flush') self.postMessage({ type: 'flushed', events: engine.flush(m.t) });
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err?.message || err), seq: m.seq });
  }
};
