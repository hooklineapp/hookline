// Auto-Optimierung: misst einige Sekunden lang Umgebung und Gerät und leitet Einstellungen ab.
// Eingaben: Messwerte der Engine (metrics), Rechenzeit je Bild, Kamera-/Analyse-Bildrate.
import * as S from './settings.js';

const WIDTHS = [400, 480, 640, 800, 960, 1280];
const med = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

export function recommend(samples, msList, camFps, info = {}) {
  const curW = +S.get('workW');
  const ms = med(msList) || 10;
  const fps = Math.max(15, camFps || 30);
  const budget = 1000 / fps;
  const lanePx = med(samples.map(s => s.laneFarPx)) || 0;
  const shake = med(samples.map(s => s.motion * 640 / (s.w || curW))); // px pro Bild, auf 640 normiert
  const noise = med(samples.map(s => s.noise));
  const lum = med(samples.map(s => s.lum));
  const changes = {}, notes = [];

  // Analysebreite: so groß wie das Zeitbudget erlaubt, bis die Bahn am Pin genug Pixel hat
  let best = WIDTHS[0];
  for (const w of WIDTHS) {
    const cost = ms * (w / curW) ** 2, px = lanePx * w / curW;
    if (cost > budget * 0.8) break;
    best = w;
    if (px >= 70) break;
  }
  if (info.videoW) best = Math.min(best, Math.max(400, info.videoW));
  if (String(best) !== String(curW)) changes.workW = String(best);
  const lanePxNew = lanePx * best / curW;
  if (lanePxNew < 28) notes.push('far');
  if (ms * (best / curW) ** 2 > budget) notes.push('slow');

  // Kamerahaltung: kaum Bewegung -> Stativ-Modus spart Rechenzeit
  const mode = shake < 0.15 ? 'tripod' : 'hand';
  if (mode !== S.get('trackMode')) changes.trackMode = mode;
  if (mode === 'hand' && shake > 3) notes.push('shaky');

  // Bewegungsschwelle aus dem Bildrauschen
  const thr = Math.round(Math.min(70, Math.max(25, noise * 2.5 + 22)));
  if (Math.abs(thr - +S.get('motionThr')) >= 3) changes.motionThr = thr;

  // Pin-Ausschnitt: bei kleiner Bahn mehr Auflösung für die Pins
  if (lanePxNew < 45 && +S.get('cropMax') < 1400) changes.cropMax = '1400';

  if (lum < 55) notes.push('dark');
  if (lum > 210) notes.push('bright');
  if (camFps && camFps < 45) notes.push('lowfps');
  if (!notes.length) notes.push('good');

  return {
    measured: { camFps: Math.round(camFps || 0), ms: +ms.toFixed(1), budget: +budget.toFixed(1), lanePx: Math.round(lanePx), lanePxNew: Math.round(lanePxNew),
      shake: +shake.toFixed(2), noise: +noise.toFixed(1), lum: Math.round(lum), workW: curW },
    changes, notes,
  };
}

export function applyChanges(changes) { for (const [k, v] of Object.entries(changes)) S.set(k, v); }
