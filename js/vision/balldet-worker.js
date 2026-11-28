// Kugel-Netz (eigenes kleines Netz, tools/balltrack/train_small.py) im eigenen Worker: rechnet parallel zur Bildauswertung, damit diese nicht auf das Netz wartet.
// Nachricht {type:'init'} -> {type:'ready', ok, backend, ms} ; {type:'det', id, data, width, height, conf}
// (data = Bahnausschnitt, RGBA) -> {type:'dets', id, dets, ms}
import { BallDet } from './balldet.js';

const NET_W = 448, NET_H = 288;
let det = null;

async function init(version) {
  const t0 = performance.now();
  const ort = await import('../vendor/ort/ort.wasm.min.mjs');
  ort.env.wasm.numThreads = 1;               // ohne Cross-Origin-Isolation gibt es keine Threads
  ort.env.wasm.wasmPaths = new URL('../vendor/ort/', import.meta.url).href;
  ort.env.logLevel = 'error';
  const u = new URL('./ballnet.onnx', import.meta.url); if (version) u.search = 'v=' + version;
  const buf = new Uint8Array(await (await fetch(u)).arrayBuffer());
  det = await BallDet.create(ort, buf, NET_W, NET_H);
  // einmal aufwärmen (erste Ausführung legt Speicher an)
  await det.detect({ data: new Uint8ClampedArray(NET_W * NET_H * 4), width: NET_W, height: NET_H }, null, 0.5);
  return performance.now() - t0;
}

// Verbindung: direkt (postMessage) oder über einen MessagePort zum Auswertungs-Worker ({type:'port', port})
async function onMsg(m, out) {
  if (m.type === 'port') { m.port.onmessage = (e) => onMsg(e.data, m.port); return; }
  if (m.type === 'init') {
    try { const ms = await init(m.version); out.postMessage({ type: 'ready', ok: true, backend: 'wasm', ms }); }
    catch (err) { out.postMessage({ type: 'ready', ok: false, error: String(err?.message || err) }); }
  } else if (m.type === 'det') {
    const t0 = performance.now();
    let dets = [];
    try { if (det) dets = await det.detect({ data: new Uint8ClampedArray(m.data), width: m.width, height: m.height }, null, m.conf ?? 0.1); }
    catch (err) { out.postMessage({ type: 'error', message: String(err?.message || err) }); }
    out.postMessage({ type: 'dets', id: m.id, dets, ms: performance.now() - t0 });
  }
}
self.onmessage = (e) => onMsg(e.data, self);
