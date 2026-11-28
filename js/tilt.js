// Lagesensor: Neigung des Horizonts im Kamerabild (Grad, Bildkoordinaten mit y nach unten; 0 = Handy aufrecht).
// Aus der Schwerkraft (devicemotion, accelerationIncludingGravity): Winkel = atan(ax / ay). Das Verhältnis ist von der
// Vorzeichen-Konvention (iOS/Android unterschiedlich) unabhängig. Nur im Hochformat (Bildschirmdrehung 0° oder 180°).
let gx = 0, gy = 0, gz = 0, t = 0, on = false;

function onMotion(e) {
  const g = e.accelerationIncludingGravity; if (!g || g.x == null) return;
  const k = t ? 0.2 : 1;   // leicht glätten (Handzittern)
  gx += k * (g.x - gx); gy += k * (g.y - gy); gz += k * ((g.z || 0) - gz); t = performance.now();
}

// Beim Antippen eines Knopfs aufrufen (iOS verlangt für die Erlaubnis eine Nutzeraktion)
export async function startTilt() {
  if (on || typeof window === 'undefined' || !('DeviceMotionEvent' in window)) return on;
  try {
    if (typeof DeviceMotionEvent.requestPermission === 'function' && (await DeviceMotionEvent.requestPermission()) !== 'granted') return false;
  } catch { return false; }
  window.addEventListener('devicemotion', onMotion);
  on = true;
  return true;
}

// Horizont-Neigung oder null (kein Sensor, veraltet, Querformat, Handy fast flach/nicht aufrecht)
export function horizonDeg() {
  if (!t || performance.now() - t > 1000) return null;
  const ang = (screen.orientation?.angle ?? window.orientation ?? 0) % 180;
  if (ang !== 0) return null;
  const inPlane = Math.hypot(gx, gy), total = Math.hypot(gx, gy, gz);
  if (inPlane < 0.6 * total || Math.abs(gy) < 0.5 * inPlane) return null;   // zu flach gehalten oder stark gekippt
  return Math.atan(gx / gy) * 180 / Math.PI;
}
