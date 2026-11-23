// Bildzufuhr: holt so viele Kamerabilder wie möglich und gibt sie an die Auswertung (Worker oder Hauptthread).
// Reihenfolge: MediaStreamTrackProcessor (jedes Kamerabild, exakte Zeit) -> Track im Worker -> requestVideoFrameCallback -> rAF.
import { Engine } from './vision/engine.js';
import { autoLane } from './vision/autolane.js';
import { snapCorners } from './vision/snap.js';
import { toGray } from './vision/lk.js';

class MainThreadEngine { // Ersatz, wenn der Browser keinen OffscreenCanvas im Worker kann
  constructor(onmsg) { this.e = new Engine(); this.onmessage = onmsg; this.c = document.createElement('canvas'); this.cx = this.c.getContext('2d', { willReadFrequently: true }); this.cc = document.createElement('canvas'); this.ccx = this.cc.getContext('2d', { willReadFrequently: true }); this.workW = 640; }
  postMessage(m) {
    setTimeout(() => {
      const res = this._do(m);
      if (res) this.onmessage({ data: res });
    }, 0);
  }
  _do(m) {
    const e = this.e;
    if (m.type === 'options') { if (m.workW) this.workW = m.workW; e.setOptions(m.options); return null; }
    if (m.type === 'ballColor') { e.setBallColor(m.color); return null; }
    if (m.type === 'pinsBefore') { e.setPinsBefore(m.pins); return null; }
    if (m.type === 'reset') { e.resetShot(); return null; }
    if (m.type === 'flush') return { type: 'flushed', events: e.flush(m.t) };
    if (m.type !== 'frame') return null;
    const src = m.bitmap || m.vf;
    const t0 = performance.now();
    const W = src.displayWidth || src.width, H = src.displayHeight || src.height;
    const w = Math.min(this.workW, W), h = Math.round(w * H / W);
    if (this.c.width !== w || this.c.height !== h) { this.c.width = w; this.c.height = h; }
    this.cx.drawImage(src, 0, 0, w, h);
    const frame = this.cx.getImageData(0, 0, w, h);
    let res;
    if (m.calibrate) res = { type: 'calibrated', info: e.calibrate(frame, m.calibrate), w, h };
    else if (m.sample) res = { type: 'color', color: e.sampleColor(frame, m.sample.x, m.sample.y, m.sample.r) };
    else if (m.auto) {
      const r = autoLane(frame, m.auto.target ? { target: [m.auto.target[0] * w - 0.5, m.auto.target[1] * h - 0.5] } : {});
      if (!r.corners) res = { type: 'auto', error: r.error };
      else { const sn = snapCorners(toGray(frame.data, w, h), w, h, r.corners, m.auto.yTop || 18.288); res = { type: 'auto', corners: (sn ? sn.corners : r.corners).map(([x, y]) => [(x + 0.5) / w, (y + 0.5) / h]) }; }
    }
    else {
      const rect = e.cropRequest(m.t);
      let crop = null;
      if (rect) {
        const sw = rect.w * W, sh = rect.h * H, sc = Math.min(1, e.o.cropMax / Math.max(sw, sh));
        const cw = Math.max(4, Math.round(sw * sc)), ch = Math.max(4, Math.round(sh * sc));
        this.cc.width = cw; this.cc.height = ch;
        this.ccx.drawImage(src, rect.x * W, rect.y * H, sw, sh, 0, 0, cw, ch);
        const img = this.ccx.getImageData(0, 0, cw, ch);
        crop = { data: img.data, width: cw, height: ch, rect };
      }
      res = { type: 'result', ...e.process(frame, m.t, crop) };
    }
    src.close?.();
    res.t = m.t; res.ms = performance.now() - t0; res.seq = m.seq;
    return res;
  }
  terminate() { }
}

export class Processor {
  constructor(onResult) {
    this.onResult = onResult;
    this.busy = 0; this.seq = 0; this.waiters = new Map();
    this.stats = { cam: 0, proc: 0, drop: 0, ms: 0, source: '' };
    this._cnt = { cam: 0, proc: 0, drop: 0, ms: 0 };
    this._tick = setInterval(() => {
      const c = this._cnt;
      this.stats = { cam: c.cam, proc: c.proc, drop: c.drop, ms: c.proc ? c.ms / c.proc : 0, source: this.source || '' };
      this._cnt = { cam: 0, proc: 0, drop: 0, ms: 0 };
    }, 1000);
  }

  async init(useWorker) {
    this.kill();
    const onmsg = (e) => this._msg(e.data);
    if (useWorker && typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined') {
      try {
        this.w = new Worker(new URL('./vision/worker.js?v=' + (window.BT_VERSION || '0'), import.meta.url), { type: 'module' });
        this.w.onmessage = onmsg;
        this.w.onerror = (e) => { console.error('Worker', e); };
        this.mode = 'worker';
        return;
      } catch (e) { console.warn('Worker nicht verfügbar', e); }
    }
    this.w = new MainThreadEngine(onmsg);
    this.mode = 'main';
  }
  kill() { this.stop(); this.w?.terminate(); this.w = null; }
  post(m, tr) { this.w?.postMessage(m, tr || []); }
  setOptions(options, workW) { this.post({ type: 'options', options, workW }); }

  _msg(m) {
    if (m.type === 'camfps') { this._cnt.cam += m.n; return; }
    if (m.type === 'trackOk') { this.source = 'track-worker'; return; }
    if (m.type === 'trackFail') { this._startVFC(); return; }
    if (m.type === 'flushed') { this.onResult(m); return; }
    if (m.type === 'result' || m.type === 'calibrated' || m.type === 'color' || m.type === 'auto' || m.type === 'error') {
      if (this.waiters.has(m.seq)) { this.waiters.get(m.seq)(m); this.waiters.delete(m.seq); this.busy = Math.max(0, this.busy - 1); return; }
      if (m.type === 'result') { this._cnt.proc++; this._cnt.ms += m.ms; }
      if (this.source !== 'track-worker') this.busy = Math.max(0, this.busy - 1);
      if (m.type === 'error') console.warn('Auswertung:', m.message);
    }
    this.onResult(m);
  }

  // --- Live-Kamera ---
  attach(video, track, prefer = 'auto') {
    this.stop();
    this.video = video; this.track = track; this.running = true;
    if (prefer === 'auto' && track && typeof window.MediaStreamTrackProcessor === 'function' && this.mode === 'worker') {
      this._startMSTP(track);
    } else if (prefer === 'auto' && track && this.mode === 'worker' && /Safari/.test(navigator.userAgent) && !/Chrome|Android/.test(navigator.userAgent)) {
      try { const c = track.clone(); this.post({ type: 'track', track: c }, [c]); this.source = 'track-worker?'; this.clone = c; }
      catch { this._startVFC(); }
    } else this._startVFC();
  }
  _startMSTP(track) {
    this.source = 'mstp';
    const c = track.clone();
    this.clone = c;
    const reader = new window.MediaStreamTrackProcessor({ track: c }).readable.getReader();
    this.reader = reader;
    const loop = async () => {
      while (this.running && this.reader === reader) {
        const { value: vf, done } = await reader.read().catch(() => ({ done: true }));
        if (done) break;
        this._cnt.cam++;
        if (this.busy >= 1 || this.paused) { this._cnt.drop++; vf.close(); continue; }
        this.busy++;
        this.post({ type: 'frame', vf, t: vf.timestamp / 1000, seq: ++this.seq }, [vf]);
      }
    };
    loop();
  }
  _startVFC() {
    const v = this.video; if (!v) return;
    this.source = 'vfc';
    const hasVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
    let lastPF = -1;
    const cb = (now, meta) => {
      if (!this.running || this.source !== 'vfc') return;
      this._schedule(cb);
      if (meta && meta.presentedFrames !== undefined) {
        this._cnt.cam += lastPF < 0 ? 1 : Math.max(1, meta.presentedFrames - lastPF);
        lastPF = meta.presentedFrames;
      } else this._cnt.cam++;
      if (this.busy >= 1 || this.paused || v.readyState < 2) { this._cnt.drop++; return; }
      const t = meta?.captureTime ?? (meta?.mediaTime !== undefined ? meta.mediaTime * 1000 : now);
      this.busy++;
      createImageBitmap(v).then(bmp => this.post({ type: 'frame', bitmap: bmp, t, seq: ++this.seq }, [bmp]))
        .catch(() => { this.busy--; });
    };
    this._schedule = (f) => hasVFC ? v.requestVideoFrameCallback(f) : requestAnimationFrame((n) => f(n, null));
    this._schedule(cb);
  }
  stop() {
    this.running = false;
    if (this.reader) { this.reader.cancel().catch(() => { }); this.reader = null; }
    if (this.source === 'track-worker' || this.source === 'track-worker?') this.post({ type: 'stopTrack' });
    this.clone?.stop(); this.clone = null;
    this.source = ''; this.busy = 0;
  }
  setPaused(p) { this.paused = p; this.post({ type: 'pause', on: p }); }

  // Einzelbild mit Antwort (Kalibrierung, Farbprobe)
  request(bitmap, extra) {
    return new Promise((res) => {
      const seq = ++this.seq;
      this.waiters.set(seq, res);
      this.busy++;
      this.post({ type: 'frame', bitmap, t: performance.now(), seq, ...extra }, [bitmap]);
    });
  }

  // --- Videodatei ---
  // Abspielen statt Bild für Bild springen (Springen ist auf Handys sehr langsam: jedes Bild ab dem letzten
  // Schlüsselbild neu dekodieren). Die Abspielgeschwindigkeit passt sich an: so schnell, wie die Auswertung
  // mitkommt, ohne Bilder auszulassen. Zeitstempel kommen aus dem Video, daher stimmen Tempo und Zeiten.
  // Ohne requestVideoFrameCallback (alte Browser): Bild für Bild springen.
  async runFile(video, fps, onProgress, shouldStop) {
    this.stop();
    this.source = 'file';
    const dur = video.duration;
    if (!('requestVideoFrameCallback' in HTMLVideoElement.prototype) || this.forceSeek) return this._runFileSeek(video, fps, onProgress, shouldStop, dur);
    video.pause(); video.muted = true;
    if (video.currentTime > 0.01) { await new Promise(r => { video.addEventListener('seeked', r, { once: true }); video.currentTime = 0; }); }
    let rate = 0.5, busy = false, pending = null, done = false, seen = 0, dropped = 0, lastAdapt = performance.now(), lastT = 0;
    video.playbackRate = rate;
    await new Promise((resolve) => {
      const finish = () => {
        if (done) return; done = true;
        video.pause(); video.playbackRate = 1;
        this.post({ type: 'flush', t: Math.max(lastT, dur * 1000) + 50 });
        resolve();
      };
      const run = async (bmp, t) => {
        busy = true;
        const res = await this.request(bmp, { t });
        this._cnt.cam++; this._cnt.proc++; this._cnt.ms += res.ms || 0;
        this.onResult(res);
        onProgress?.(t / 1000, dur);
        busy = false;
        if (pending) { const p = pending; pending = null; run(p.bmp, p.t); }
        else if (video.ended || video.currentTime >= dur - 0.001) finish();
      };
      const onFrame = async (now, meta) => {
        if (done) return;
        if (shouldStop()) { finish(); return; }
        const t = meta.mediaTime * 1000;
        if (t <= lastT && seen) { video.requestVideoFrameCallback(onFrame); return; }
        lastT = t; seen++;
        let bmp;
        try { bmp = await createImageBitmap(video); } catch { video.requestVideoFrameCallback(onFrame); return; }
        if (busy) { if (pending) { pending.bmp.close?.(); dropped++; } pending = { bmp, t }; } else run(bmp, t);
        // Geschwindigkeit anpassen: Bilder ausgelassen -> langsamer, sonst etwas schneller (max. Echtzeit)
        const nowMs = performance.now();
        if (nowMs - lastAdapt > 700) {
          const r0 = rate;
          if (dropped > 0) rate = Math.max(0.07, rate * 0.7); else rate = Math.min(1, rate * 1.1);
          if (rate !== r0) video.playbackRate = rate;
          dropped = 0; lastAdapt = nowMs;
        }
        video.requestVideoFrameCallback(onFrame);
      };
      const fallback = () => {             // keine Bilder (z. B. Seite im Hintergrund): Bild für Bild auswerten
        if (done) return; done = true;
        video.pause(); video.playbackRate = 1; video.onended = null;
        resolve(this._runFileSeek(video, fps, onProgress, shouldStop, dur));
      };
      video.onended = () => { if (!seen) fallback(); else if (!busy && !pending) finish(); };
      video.requestVideoFrameCallback(onFrame);
      video.play().catch(fallback);
      setTimeout(() => { if (!seen) fallback(); }, 1500);
    });
  }
  async _runFileSeek(video, fps, onProgress, shouldStop, dur) {
    const n = Math.floor(dur * fps);
    video.pause();
    for (let i = 0; i < n; i++) {
      if (shouldStop()) break;
      const tt = (i + 0.5) / fps;
      await new Promise(r => { video.addEventListener('seeked', r, { once: true }); video.currentTime = tt; });
      const bmp = await createImageBitmap(video);
      const res = await this.request(bmp, { t: i / fps * 1000 });
      this._cnt.cam++; this._cnt.proc++; this._cnt.ms += res.ms || 0;
      this.onResult(res);
      onProgress?.(tt, dur);
    }
    // Videoende: laufenden Wurf abschließen
    this.post({ type: 'flush', t: n / fps * 1000 + 50 });
  }
}

export async function estimateFps(video) {
  if (!('requestVideoFrameCallback' in HTMLVideoElement.prototype)) return 30;
  return new Promise((resolve) => {
    const times = [];
    const cb = (now, meta) => {
      times.push(meta.mediaTime);
      if (times.length < 12) video.requestVideoFrameCallback(cb);
      else {
        video.pause();
        const d = []; for (let i = 1; i < times.length; i++) if (times[i] > times[i - 1]) d.push(times[i] - times[i - 1]);
        d.sort((a, b) => a - b);
        const dt = d[0] || 1 / 30;
        const fps = 1 / dt;
        const std = [24, 25, 30, 50, 60, 90, 120, 240].reduce((a, b) => Math.abs(b - fps) < Math.abs(a - fps) ? b : a);
        resolve(Math.abs(std - fps) / fps < 0.08 ? std : Math.round(fps));
      }
    };
    video.muted = true; video.playbackRate = 1;
    video.requestVideoFrameCallback(cb);
    video.play();
  });
}
