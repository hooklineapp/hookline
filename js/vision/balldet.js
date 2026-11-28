// Kugel-Erkennung mit einem trainierten Netz (ONNX) über onnxruntime-web: eigenes kleines Netz (Mittelpunkt-Karte)
// oder YOLO-Ausgabe.
// Läuft im Worker und in Node (Tests). Eingabe: RGBA-Bild (oder Ausschnitt daraus), Ausgabe: Kandidaten in Bildpixeln.
export class BallDet {
  constructor(ort, session, sw, sh) { this.ort = ort; this.s = session; this.SW = sw; this.SH = sh; this.inp = new Float32Array(3 * sw * sh); }
  static async create(ort, model, sw = 640, sh = sw) {
    const s = await ort.InferenceSession.create(model, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
    return new BallDet(ort, s, sw, sh);
  }
  // img: {data (RGBA), width, height}; rect: Ausschnitt in Pixeln {x,y,w,h} (Standard: ganzes Bild)
  // Ergebnis: [{x, y, w, h, conf}] in Pixeln des Eingangsbilds, nach Konfidenz sortiert
  async detect(img, rect, conf = 0.15) {
    const SW = this.SW, SH = this.SH, { data, width: W } = img;
    const r = rect || { x: 0, y: 0, w: img.width, h: img.height };
    const sc = Math.min(SW / r.w, SH / r.h), nw = Math.round(r.w * sc), nh = Math.round(r.h * sc);
    const px = Math.floor((SW - nw) / 2), py = Math.floor((SH - nh) / 2);
    const inp = this.inp, P = SW * SH;
    inp.fill(114 / 255);
    // bilinear verkleinern/vergrößern (wie cv2 INTER_LINEAR beim Letterbox der Python-Seite)
    for (let y = 0; y < nh; y++) {
      const fy = Math.max(0, Math.min(r.h - 1, (y + 0.5) / sc - 0.5)), y0 = Math.floor(fy), y1 = Math.min(r.h - 1, y0 + 1), wy = fy - y0;
      const row0 = (r.y + y0) * W, row1 = (r.y + y1) * W;
      let o = (py + y) * SW + px;
      for (let x = 0; x < nw; x++, o++) {
        const fx = Math.max(0, Math.min(r.w - 1, (x + 0.5) / sc - 0.5)), x0 = Math.floor(fx), x1 = Math.min(r.w - 1, x0 + 1), wx = fx - x0;
        const a = (row0 + r.x + x0) * 4, b = (row0 + r.x + x1) * 4, c = (row1 + r.x + x0) * 4, d = (row1 + r.x + x1) * 4;
        const w00 = (1 - wx) * (1 - wy), w01 = wx * (1 - wy), w10 = (1 - wx) * wy, w11 = wx * wy;
        inp[o] = (data[a] * w00 + data[b] * w01 + data[c] * w10 + data[d] * w11) / 255;
        inp[o + P] = (data[a + 1] * w00 + data[b + 1] * w01 + data[c + 1] * w10 + data[d + 1] * w11) / 255;
        inp[o + 2 * P] = (data[a + 2] * w00 + data[b + 2] * w01 + data[c + 2] * w10 + data[d + 2] * w11) / 255;
      }
    }
    const t = new this.ort.Tensor('float32', inp, [1, 3, SH, SW]);
    const out = await this.s.run({ [this.s.inputNames[0]]: t });
    const o = out[this.s.outputNames[0]], v = o.data, c = [];
    if (o.dims.length === 4) {
      // eigenes Netz (CenterNet-Art): [1, 4, H/4, W/4] = Wahrscheinlichkeit (Spitzen schon gefiltert), log(Durchmesser), Versatz x, y
      const gh = o.dims[2], gw = o.dims[3], G = gh * gw, st = SW / gw;
      for (let k = 0; k < G; k++) {
        const p = v[k]; if (p < conf) continue;
        const gx = k % gw, gy = (k - gx) / gw, d = Math.exp(v[G + k]) / sc;
        c.push({ x: ((gx + v[2 * G + k]) * st - px) / sc + r.x, y: ((gy + v[3 * G + k]) * st - py) / sc + r.y, w: d, h: d, conf: p });
      }
    } else {
      const N = o.dims[2];   // YOLO: [1, 5, N]: cx, cy, w, h, conf
      for (let i = 0; i < N; i++) {
        const p = v[4 * N + i]; if (p < conf) continue;
        c.push({ x: (v[i] - px) / sc + r.x, y: (v[N + i] - py) / sc + r.y, w: v[2 * N + i] / sc, h: v[3 * N + i] / sc, conf: p });
      }
    }
    c.sort((a, b) => b.conf - a.conf);
    // einfache NMS (Mittelpunkt in einer stärkeren Box)
    const keep = [];
    for (const d of c) if (!keep.some(k => Math.abs(k.x - d.x) < 0.5 * k.w && Math.abs(k.y - d.y) < 0.5 * k.h)) { keep.push(d); if (keep.length >= 10) break; }
    return keep;
  }
}
