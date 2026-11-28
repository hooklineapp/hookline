// Alle Optionen an einer Stelle: Typ, Standard, Bereich, Gruppe. Labels kommen aus i18n (opt.<key>).
import { ENGINE_DEFAULTS as E } from './vision/engine.js';

const S = (key, type, def, extra = {}) => ({ key, type, def, ...extra });

export const SCHEMA = [
  // Allgemein
  S('lang', 'select', 'auto', { group: 'general', options: ['auto', 'de', 'en'], basic: true }),
  S('theme', 'select', 'auto', { group: 'general', options: ['auto', 'light', 'dark'], basic: true, look: true }),
  S('uiStyle', 'select', 'glass', { group: 'general', options: ['glass', 'flat', 'soft', 'sport', 'pin'], basic: true, look: true }),
  S('accentColor', 'color', '#4f46e5', { group: 'general', basic: true, look: true }),
  S('expertMode', 'bool', false, { group: 'general', hidden: true }),
  S('mascot', 'bool', true, { group: 'general', basic: true, look: true }),
  S('preset', 'select', 'recommended', { group: 'general', hidden: true, options: ['recommended', 'handheld', 'tripod', 'battery', 'precise', 'custom'] }),
  S('units', 'select', 'kmh', { group: 'general', options: ['kmh', 'mph'] , basic: true }),
  S('lengthUnit', 'select', 'ft', { group: 'general', options: ['ft', 'm'] , basic: true }),
  S('haptics', 'bool', true, { group: 'general' , basic: true }),
  S('sound', 'bool', false, { group: 'general' , basic: true }),
  S('wakeLock', 'bool', true, { group: 'general' , basic: true }),
  S('autoSave', 'bool', true, { group: 'general' , basic: true }),
  S('confirmShots', 'bool', false, { group: 'general' , basic: true }),
  S('fileOneShot', 'bool', true, { group: 'general', basic: true }),
  S('fileRealtime', 'bool', true, { group: 'general', basic: true }),   // Videodatei wie Live-Kamera (Echtzeit, Bilder überspringen)
  // Kamera
  S('camDevice', 'camera', '', { group: 'camera' , basic: true }),
  S('camRes', 'select', 'auto', { group: 'camera', options: ['auto', '480', '720', '1080', '1440', '2160'] , basic: true }),
  S('camFps', 'select', 'max', { group: 'camera', options: ['max', '240', '120', '60', '30'] , basic: true }),
  S('camPrefer', 'select', 'fps', { group: 'camera', options: ['fps', 'res'] }),
  S('camZoom', 'range', 1, { group: 'camera', min: 1, max: 5, step: 0.1 , basic: true }),
  S('camShortExposure', 'bool', false, { group: 'camera' }),
  S('camFocusFar', 'bool', false, { group: 'camera' }),
  S('fovDeg', 'range', 0, { group: 'camera', min: 0, max: 120, step: 1, engine: true }),
  // Verarbeitung
  S('workW', 'select', '640', { group: 'processing', options: ['400', '480', '640', '800', '960', '1280'] }),
  S('useWorker', 'bool', true, { group: 'processing' }),
  S('trackMode', 'select', E.trackMode, { group: 'processing', options: ['hand', 'tripod'], engine: true , basic: true }),
  S('features', 'range', E.features, { group: 'processing', min: 30, max: 400, step: 10, engine: true }),
  S('lkRadius', 'range', E.lkRadius, { group: 'processing', min: 3, max: 9, step: 1, engine: true }),
  S('lkLevels', 'range', E.lkLevels, { group: 'processing', min: 2, max: 6, step: 1, engine: true }),
  S('lkIters', 'range', E.lkIters, { group: 'processing', min: 3, max: 20, step: 1, engine: true }),
  S('ransacPx', 'range', E.ransacPx, { group: 'processing', min: 0.5, max: 6, step: 0.1, engine: true }),
  S('refRefresh', 'bool', E.refRefresh, { group: 'processing', engine: true }),
  S('keyQ', 'range', E.keyQ, { group: 'processing', min: 0.1, max: 0.8, step: 0.05, engine: true }),
  S('planeFeatures', 'bool', E.planeFeatures, { group: 'processing', engine: true }),
  S('gridScale', 'select', String(E.gridScale), { group: 'processing', options: ['0.75', '1', '1.5', '2'], engine: true, num: true }),
  // Kugel
  S('net', 'bool', true, { group: 'ball', engine: true, basic: true }),
  S('detMode', 'select', E.detMode, { group: 'ball', options: ['both', 'motion', 'color'], engine: true }),
  S('motionThr', 'range', E.motionThr, { group: 'ball', min: 10, max: 120, step: 1, engine: true }),
  S('devK', 'range', E.devK, { group: 'ball', min: 1, max: 8, step: 0.1, engine: true }),
  S('bgRate', 'range', E.bgRate, { group: 'ball', min: 0.01, max: 0.3, step: 0.01, engine: true }),
  S('colorTol', 'range', E.colorTol, { group: 'ball', min: 0.3, max: 3, step: 0.05, engine: true }),
  S('lumTol', 'range', E.lumTol, { group: 'ball', min: 0.3, max: 3, step: 0.05, engine: true }),
  S('minColorFrac', 'range', E.minColorFrac, { group: 'ball', min: 0, max: 1, step: 0.05, engine: true }),
  S('startMin', 'range', E.startMin, { group: 'ball', min: 0, max: 6, step: 0.1, engine: true }),
  S('startMax', 'range', E.startMax, { group: 'ball', min: 2, max: 15, step: 0.5, engine: true }),
  S('startFrames', 'range', E.startFrames, { group: 'ball', min: 2, max: 8, step: 1, engine: true }),
  S('minSpeed', 'range', E.minSpeed, { group: 'ball', min: 0.5, max: 6, step: 0.1, engine: true }),
  S('maxSpeed', 'range', E.maxSpeed, { group: 'ball', min: 8, max: 20, step: 0.5, engine: true }),
  S('maxMissNear', 'range', E.maxMissNear, { group: 'ball', min: 0.2, max: 2, step: 0.05, engine: true }),
  S('maxMissLong', 'range', E.maxMissLong, { group: 'ball', min: 0.3, max: 3, step: 0.1, engine: true }),
  S('topEdge', 'bool', E.topEdge, { group: 'ball', engine: true }),
  S('maxMiss', 'range', E.maxMiss, { group: 'ball', min: 0.1, max: 1.5, step: 0.05, engine: true }),
  S('motionFallback', 'bool', E.motionFallback, { group: 'ball', engine: true }),
  S('sizeTolLo', 'range', E.sizeTolLo, { group: 'ball', min: 0.1, max: 0.9, step: 0.05, engine: true }),
  S('sizeTolHi', 'range', E.sizeTolHi, { group: 'ball', min: 1.2, max: 5, step: 0.1, engine: true }),
  S('smooth', 'range', 40, { group: 'ball', min: 1, max: 400, step: 1 }),
  // Pins
  S('pinsEnabled', 'bool', E.pinsEnabled, { group: 'pins', engine: true , basic: true }),
  S('pinTrack', 'bool', E.pinTrack, { group: 'pins', engine: true, basic: true }),
  S('pinDelay', 'range', E.pinDelay, { group: 'pins', min: 0.5, max: 5, step: 0.1, engine: true }),
  S('pinWindow', 'range', E.pinWindow, { group: 'pins', min: 0.05, max: 1.5, step: 0.05, engine: true }),
  S('pinRatio', 'range', E.pinRatio, { group: 'pins', min: 0.1, max: 0.95, step: 0.05, engine: true }),
  S('pinOccluded', 'select', E.pinOccluded, { group: 'pins', options: ['standing', 'down'], engine: true }),
  S('pinZLow', 'range', E.pinZLow, { group: 'pins', min: 0.1, max: 0.85, step: 0.05, engine: true }),
  S('pinLumThr', 'range', E.pinLumThr, { group: 'pins', min: 0, max: 250, step: 1, engine: true }),
  S('cropMax', 'select', String(E.cropMax), { group: 'pins', options: ['400', '600', '900', '1400'], engine: true, num: true }),
  S('cooldown', 'range', E.cooldown, { group: 'pins', min: 0.5, max: 10, step: 0.5, engine: true }),
  S('pocketMin', 'range', 16, { group: 'pins', min: 10, max: 20, step: 0.5 }),
  S('pocketMax', 'range', 19, { group: 'pins', min: 17, max: 25, step: 0.5 }),
  // Kalibrierung
  S('topLine', 'select', E.topLine, { group: 'calib', options: ['headpin', 'pit'], engine: true , basic: true }),
  S('snapCorners', 'bool', E.snapCorners, { group: 'calib', engine: true , basic: true }),
  S('autoWizard', 'bool', true, { group: 'calib' , basic: true }),
  S('freezeOnCalib', 'bool', true, { group: 'calib' , basic: true }),
  S('loupe', 'bool', true, { group: 'calib' , basic: true }),
  // Anzeige
  S('showLane', 'bool', true, { group: 'display' , basic: true }),
  S('showBoards', 'bool', false, { group: 'display' }),
  S('showTrail', 'bool', true, { group: 'display' , basic: true }),
  S('showCands', 'bool', false, { group: 'display' }),
  S('showPins', 'bool', true, { group: 'display' , basic: true }),
  S('showHud', 'bool', false, { group: 'display' }),
  S('debug', 'bool', false, { group: 'display', engine: true }),
  S('pinSim', 'bool', true, { group: 'display', basic: true }),
  S('pin3d', 'bool', true, { group: 'display', basic: true }),
  S('pinZoom', 'bool', true, { group: 'display', basic: true }),
  S('replaySpeed', 'select', '1', { group: 'display', options: ['0.25', '0.5', '1', '2'] , basic: true }),
  S('replayWidth', 'range', 4, { group: 'display', min: 1, max: 10, step: 0.5 }),
  S('replayMode', 'select', 'top', { group: 'display', options: ['top', 'camera', 'split'] , basic: true }),
  S('compareN', 'range', 5, { group: 'display', min: 0, max: 30, step: 1 , basic: true }),
];

export const GROUPS = ['general', 'camera', 'processing', 'ball', 'pins', 'calib', 'display'];
const KEY = 'bt.settings.v1';
const byKey = Object.fromEntries(SCHEMA.map(s => [s.key, s]));

let values = {};
const listeners = new Set();

export function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { /* privat */ }
  if (saved.startMax === 8) delete saved.startMax;   // alter Standard (8 m) → neuer Standard
  values = Object.fromEntries(SCHEMA.map(s => [s.key, saved[s.key] ?? s.def]));
  return values;
}
export function get(k) { return values[k]; }
export function all() { return values; }
export function set(k, v) {
  values[k] = v;
  if (byKey[k] && ['camera', 'processing', 'ball', 'pins'].includes(byKey[k].group)) values.preset = 'custom';
  try { localStorage.setItem(KEY, JSON.stringify(values)); } catch { /* */ }
  listeners.forEach(f => f(k, v));
}
export function resetAll(group) {
  for (const s of SCHEMA) if (!group || s.group === group) values[s.key] = s.def;
  try { localStorage.setItem(KEY, JSON.stringify(values)); } catch { /* */ }
  listeners.forEach(f => f('*'));
}
export function onChange(f) { listeners.add(f); return () => listeners.delete(f); }
export function engineOptions() {
  const o = {};
  for (const s of SCHEMA) if (s.engine) o[s.key] = s.num || s.type === 'range' ? +values[s.key] : values[s.key];
  return o;
}
export function isEngineKey(k) { return !!(byKey[k] && byKey[k].engine); }
export function exportSettings() { return { ...values }; }
export function importSettings(obj) {
  for (const s of SCHEMA) if (obj[s.key] !== undefined) values[s.key] = obj[s.key];
  try { localStorage.setItem(KEY, JSON.stringify(values)); } catch { /* */ }
  listeners.forEach(f => f('*'));
}

// ---------- Vorlagen ----------
// Jede Vorlage setzt Kamera/Verarbeitung/Erkennung zuerst auf Standard und ändert dann nur ihre Werte.
export const PRESETS = {
  recommended: {},
  handheld: { trackMode: 'hand', features: 170, refRefresh: true, workW: '640', maxMissNear: 1.0 },
  tripod: { trackMode: 'tripod', workW: '800', camFps: 'max' },
  battery: { workW: '480', camFps: '60', features: 100, lkLevels: 3, lkIters: 6, cropMax: '600', pinWindow: 0.2, useWorker: true },
  precise: { workW: '960', camRes: '1080', features: 220, lkRadius: 6, gridScale: '0.75', cropMax: '1400', pinWindow: 0.45 },
};
const TECH = ['camera', 'processing', 'ball', 'pins'];
export function applyPreset(name) {
  const pr = PRESETS[name]; if (!pr) return;
  for (const sc of SCHEMA) if (TECH.includes(sc.group) && sc.key !== 'camDevice' && sc.key !== 'pocketMin' && sc.key !== 'pocketMax') values[sc.key] = sc.def;
  Object.assign(values, pr);
  values.preset = name;
  try { localStorage.setItem(KEY, JSON.stringify(values)); } catch { /* */ }
  listeners.forEach(f => f('*'));
}

// ---------- gespeicherte Profile ----------
const PKEY = 'bt.profiles.v1';
const readP = () => { try { return JSON.parse(localStorage.getItem(PKEY) || '{}'); } catch { return {}; } };
const writeP = (o) => { try { localStorage.setItem(PKEY, JSON.stringify(o)); } catch { /* */ } };
export function listProfiles() { return Object.entries(readP()).map(([name, p]) => ({ name, saved: p.saved })).sort((a, b) => b.saved - a.saved); }
export function saveProfile(name) {
  const o = readP();
  const v = { ...values }; delete v.expertMode;
  o[name] = { saved: Date.now(), values: v }; writeP(o);
}
export function loadProfile(name) { const o = readP(); if (o[name]) importSettings(o[name].values); }
export function deleteProfile(name) { const o = readP(); delete o[name]; writeP(o); }
