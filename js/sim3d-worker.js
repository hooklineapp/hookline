// Hintergrund-Worker für die 3D-Pinphysik (hält die Oberfläche flüssig)
import { simulateMeasured3D } from './pinsim3d.js';
self.onmessage = (e) => {
  const { id, shot, an, params, falls } = e.data;
  try {
    const r = simulateMeasured3D(shot, an, params, falls);
    self.postMessage({ id, ok: true, sim: r });
  } catch (err) { self.postMessage({ id, ok: false, error: String(err) }); }
};
