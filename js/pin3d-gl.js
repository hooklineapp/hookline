// Kleiner WebGL-Zeichner für Pins und Kugel in der Kamerasicht des Replays (ohne Bibliothek).
// Projektion exakt wie die Aufnahme: Homografie der Bahn + Höhenspalte (cameraFromH: H, m3), dazu der 2D-Zoom des Replays.
import { PIN_PROFILE, PIN_ZC } from './pinphys.js';
import { BALL_R } from './lane.js';

const VS = `
attribute vec3 aPos; attribute vec3 aNrm;
uniform mat3 uRot; uniform vec3 uTr;
uniform vec4 uM0, uM1, uM2, uDep;
uniform vec2 uOff, uSize, uHp, uAnc; uniform float uZ;
varying vec3 vN; varying vec3 vW; varying float vZ;
void main() {
  vec3 w = uRot * aPos + uTr;
  vec4 w4 = vec4(w, 1.0);
  vec3 h = vec3(dot(uM0, w4), dot(uM1, w4), dot(uM2, w4));
  vec2 pix = h.xy / h.z + uOff;
  pix = (pix - uHp) * uZ + uAnc;
  float d = dot(uDep, w4);
  gl_Position = vec4(pix.x / uSize.x * 2.0 - 1.0, 1.0 - pix.y / uSize.y * 2.0, clamp((d - 0.05) / 60.0, 0.0, 1.0) * 2.0 - 1.0, 1.0);
  vN = uRot * aNrm; vW = w; vZ = aPos.z;
}`;
const FS = `
precision mediump float;
varying vec3 vN; varying vec3 vW; varying float vZ;
uniform vec3 uCol; uniform float uPin; uniform vec3 uCam;
void main() {
  vec3 n = normalize(vN);
  vec3 L = normalize(vec3(-0.35, -0.55, 0.75));
  vec3 V = normalize(uCam - vW);
  float dif = max(dot(n, L), 0.0), amb = 0.42;
  float spec = pow(max(dot(n, normalize(L + V)), 0.0), 40.0) * 0.45;
  vec3 col = uCol;
  if (uPin > 0.5) {
    float z = vZ + ${PIN_ZC.toFixed(4)};
    if ((z > 0.236 && z < 0.250) || (z > 0.258 && z < 0.272)) col = vec3(0.80, 0.07, 0.08);
  }
  gl_FragColor = vec4(col * (amb + 0.62 * dif) + spec, 1.0);
}`;

function lathe(seg = 24) {
  const pos = [], nrm = [], idx = [];
  const prof = PIN_PROFILE.map(([z, r]) => [z - PIN_ZC, Math.max(r, 0.0005)]);
  for (let i = 0; i < prof.length; i++) {
    const [z, r] = prof[i];
    const a = prof[Math.max(0, i - 1)], b = prof[Math.min(prof.length - 1, i + 1)];
    const dz = b[0] - a[0], dr = b[1] - a[1], l = Math.hypot(dz, dr) || 1;
    const nr = dz / l, nz = -dr / l;                    // Normale des Profils (nach außen)
    for (let k = 0; k <= seg; k++) {
      const t = k / seg * Math.PI * 2, c = Math.cos(t), s = Math.sin(t);
      pos.push(c * r, s * r, z); nrm.push(c * nr, s * nr, nz);
    }
  }
  for (let i = 0; i < prof.length - 1; i++) for (let k = 0; k < seg; k++) {
    const a = i * (seg + 1) + k, b = a + seg + 1;
    idx.push(a, b, a + 1, a + 1, b, b + 1);
  }
  // Fuß (Scheibe)
  const c0 = pos.length / 3; pos.push(0, 0, -PIN_ZC); nrm.push(0, 0, -1);
  for (let k = 0; k <= seg; k++) { const t = k / seg * Math.PI * 2; pos.push(Math.cos(t) * prof[0][1], Math.sin(t) * prof[0][1], -PIN_ZC); nrm.push(0, 0, -1); }
  for (let k = 0; k < seg; k++) idx.push(c0, c0 + 1 + k, c0 + 2 + k);
  return { pos: new Float32Array(pos), nrm: new Float32Array(nrm), idx: new Uint16Array(idx) };
}
function sphere(r, us = 20, vs = 14) {
  const pos = [], nrm = [], idx = [];
  for (let j = 0; j <= vs; j++) {
    const v = j / vs * Math.PI, sv = Math.sin(v), cv = Math.cos(v);
    for (let i = 0; i <= us; i++) { const u = i / us * Math.PI * 2; const x = Math.cos(u) * sv, y = Math.sin(u) * sv, z = cv; pos.push(x * r, y * r, z * r); nrm.push(x, y, z); }
  }
  for (let j = 0; j < vs; j++) for (let i = 0; i < us; i++) { const a = j * (us + 1) + i, b = a + us + 1; idx.push(a, b, a + 1, a + 1, b, b + 1); }
  return { pos: new Float32Array(pos), nrm: new Float32Array(nrm), idx: new Uint16Array(idx) };
}
function quatMat(q) {
  const [x, y, z, w] = q;
  return new Float32Array([1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w),
    2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w),
    2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y)]);   // spaltenweise für WebGL
}

export class Pin3D {
  constructor() {
    this.canvas = document.createElement('canvas');
    const gl = this.canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: true });
    if (!gl) throw new Error('kein WebGL');
    this.gl = gl;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const pr = gl.createProgram(); gl.attachShader(pr, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(pr);
    if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pr));
    this.pr = pr; gl.useProgram(pr);
    this.u = {}; for (const n of ['uRot', 'uTr', 'uM0', 'uM1', 'uM2', 'uDep', 'uOff', 'uSize', 'uHp', 'uAnc', 'uZ', 'uCol', 'uPin', 'uCam']) this.u[n] = gl.getUniformLocation(pr, n);
    this.aPos = gl.getAttribLocation(pr, 'aPos'); this.aNrm = gl.getAttribLocation(pr, 'aNrm');
    const up = (m) => {
      const b = { n: m.idx.length, p: gl.createBuffer(), q: gl.createBuffer(), i: gl.createBuffer() };
      gl.bindBuffer(gl.ARRAY_BUFFER, b.p); gl.bufferData(gl.ARRAY_BUFFER, m.pos, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, b.q); gl.bufferData(gl.ARRAY_BUFFER, m.nrm, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, b.i); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, m.idx, gl.STATIC_DRAW);
      return b;
    };
    this.pin = up(lathe()); this.ball = up(sphere(BALL_R));
  }
  // view: { w, h, dpr, C (cameraFromH in Bildfeld-Koordinaten), off: [ox, oy], zoom: { z, hp: [x,y], anc: [x,y] } }
  // bodies: [{ kind: 'pin'|'ball', pose: [x,y,z,qx,qy,qz,qw], color: [r,g,b] }]
  render(view, bodies) {
    const gl = this.gl, c = this.canvas, W = Math.round(view.w * view.dpr), H = Math.round(view.h * view.dpr);
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);
    const { C } = view, Hm = C.H, m3 = C.m3, u = this.u;
    gl.uniform4f(u.uM0, Hm[0], Hm[1], m3[0], Hm[2]); gl.uniform4f(u.uM1, Hm[3], Hm[4], m3[1], Hm[5]); gl.uniform4f(u.uM2, Hm[6], Hm[7], m3[2], Hm[8]);
    gl.uniform4f(u.uDep, C.r1[2], C.r2[2], C.r3[2], C.t[2]);
    gl.uniform2f(u.uOff, view.off[0], view.off[1]); gl.uniform2f(u.uSize, view.w, view.h);
    const z = view.zoom || { z: 1, hp: [0, 0], anc: [0, 0] };
    gl.uniform2f(u.uHp, z.hp[0], z.hp[1]); gl.uniform2f(u.uAnc, z.anc[0], z.anc[1]); gl.uniform1f(u.uZ, z.z);
    gl.uniform3f(u.uCam, C.camPos[0], C.camPos[1], C.camPos[2]);
    for (const b of bodies) {
      const m = b.kind === 'pin' ? this.pin : this.ball;
      gl.bindBuffer(gl.ARRAY_BUFFER, m.p); gl.enableVertexAttribArray(this.aPos); gl.vertexAttribPointer(this.aPos, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, m.q); gl.enableVertexAttribArray(this.aNrm); gl.vertexAttribPointer(this.aNrm, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, m.i);
      const p = b.pose;
      gl.uniformMatrix3fv(u.uRot, false, quatMat([p[3], p[4], p[5], p[6]]));
      gl.uniform3f(u.uTr, p[0], p[1], p[2]);
      const col = b.color || [0.96, 0.96, 0.94];
      gl.uniform3f(u.uCol, col[0], col[1], col[2]); gl.uniform1f(u.uPin, b.kind === 'pin' ? 1 : 0);
      gl.drawElements(gl.TRIANGLES, m.n, gl.UNSIGNED_SHORT, 0);
    }
    return c;
  }
}
