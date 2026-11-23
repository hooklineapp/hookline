// Kamera: Hauptkamera hinten finden, höchste Bildrate aushandeln, Zoom/Belichtung/Fokus.

const BAD = /(ultra|ultraweit|weitwinkel|wide angle|tele|dual|triple|depth|tiefe|infrared|ir\b|front|user|vorder|facetime|selfie)/i;
const BACK = /(back|rear|rück|environment|hinten|facing back)/i;

export function scoreCamera(label, idx) {
  const l = label || '';
  let s = 0;
  if (BACK.test(l)) s += 10;
  if (/^back camera$|^rückkamera$|^rear camera$/i.test(l.trim())) s += 8; // iOS Hauptkamera
  if (BAD.test(l)) s -= 12;
  const m = l.match(/camera2? ?(\d+)/i);
  if (m) s += 4 - Math.min(4, +m[1]); // Android: camera2 0 ist meist die Hauptkamera
  return s - idx * 0.01;
}

export async function listCameras() {
  const d = await navigator.mediaDevices.enumerateDevices();
  return d.filter(x => x.kind === 'videoinput');
}

function resList(pref) {
  const all = [[3840, 2160], [2560, 1440], [1920, 1080], [1280, 720], [960, 540], [640, 480]];
  if (pref === 'auto') return all.slice(2);
  const hgt = +pref;
  return all.filter(r => r[1] === hgt || (hgt === 480 && r[1] === 480));
}

export async function startCamera(video, opt) {
  if (!window.isSecureContext) throw Object.assign(new Error('https'), { code: 'https' });
  if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error('nocam'), { code: 'nocam' });
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } });
  } catch (e) {
    throw Object.assign(e, { code: e.name === 'NotAllowedError' ? 'denied' : 'nocam' });
  }
  let track = stream.getVideoTracks()[0];
  const cams = await listCameras();
  let want = opt.device;
  if (!want) {
    const ranked = cams.map((c, i) => ({ c, s: scoreCamera(c.label, i) })).sort((a, b) => b.s - a.s);
    if (ranked.length && ranked[0].s > 0) want = ranked[0].c.deviceId;
  }
  const cur = track.getSettings().deviceId;
  if (want && want !== cur) {
    track.stop();
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { deviceId: { exact: want } } });
    track = stream.getVideoTracks()[0];
  }
  const caps = track.getCapabilities ? track.getCapabilities() : {};
  const fpsMaxCap = caps.frameRate?.max || 60;
  const fpsWant = opt.fps === 'max' ? Math.min(fpsMaxCap, 240) : Math.min(+opt.fps, fpsMaxCap);
  // Kombinationen testen: höchste Bildrate (oder Auflösung) gewinnt
  let best = null;
  for (const [w, h] of resList(opt.res)) {
    if (caps.width?.max && w > caps.width.max && h > caps.width.max) continue;
    try {
      await track.applyConstraints({ width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: fpsWant, max: fpsWant } });
    } catch { continue; }
    const s = track.getSettings();
    const cand = { w: s.width, h: s.height, fps: s.frameRate || 30, req: [w, h] };
    const key = (c) => opt.prefer === 'res' ? c.w * c.h * 1000 + c.fps : c.fps * 1e8 + c.w * c.h;
    if (!best || key(cand) > key(best)) best = cand;
    if (opt.res !== 'auto') break;
  }
  if (best) {
    try { await track.applyConstraints({ width: { ideal: best.req[0] }, height: { ideal: best.req[1] }, frameRate: { ideal: fpsWant, max: fpsWant } }); } catch { /* */ }
  }
  const adv = {};
  if (caps.zoom && opt.zoom > 1) adv.zoom = Math.min(caps.zoom.max, Math.max(caps.zoom.min, opt.zoom));
  if (opt.shortExposure && caps.exposureMode?.includes('manual') && caps.exposureTime) {
    adv.exposureMode = 'manual'; adv.exposureTime = Math.max(caps.exposureTime.min, Math.min(caps.exposureTime.max, 40));
  }
  if (opt.focusFar && caps.focusMode?.includes('manual') && caps.focusDistance) {
    adv.focusMode = 'manual'; adv.focusDistance = caps.focusDistance.max;
  }
  if (Object.keys(adv).length) try { await track.applyConstraints({ advanced: [adv] }); } catch { /* nicht unterstützt */ }
  video.srcObject = stream;
  video.muted = true; video.playsInline = true; video.setAttribute('playsinline', '');
  await video.play().catch(() => { });
  await new Promise(r => video.readyState >= 2 ? r() : video.addEventListener('loadeddata', r, { once: true }));
  const s = track.getSettings();
  return {
    stream, track, cams, caps,
    info: { w: video.videoWidth || s.width, h: video.videoHeight || s.height, fps: Math.round(s.frameRate || 30), label: track.label, deviceId: s.deviceId, zoom: !!caps.zoom },
  };
}

export function stopStream(stream) { stream?.getTracks().forEach(t => t.stop()); }
