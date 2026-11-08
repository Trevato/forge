// The jbox boot tag: "L · jbox green, spin", confirmed in
// Arcade records/design/1026-loading-tags. A Game Boy green cube spins two and three
// quarter turns counterclockwise and settles with the J in front, lighting its groove in
// three beats to a rising power-on chord. Drawn at 160x144 and scaled by whole pixels.
//
// playJboxSpin(canvas) runs it once and resolves when the chord has rung out.

// The tag: a 160x144 buffer, ray-cast per pixel, scaled up by whole pixels.
const VW = 160, VH = 144, SC = 28;
let x, img, buf;
const mask = new Uint8Array(VW * VH);
const rgb = (h) => [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4), 16)];
const pack = ([r, g, b], k = 1) => 0xff000000 | Math.min(255, b * k) << 16 | Math.min(255, g * k) << 8 | Math.min(255, r * k);
// Game Boy greens. Faces pick a shade by how much light they catch.
const BG = pack(rgb("9bbc0f")), INK = pack(rgb("0f380f")), LIP = INK, LIT = pack(rgb("e0f8a0"));
const SHADES = [["8bac0f", "c4e050", "306230"], ["6a8c1c", "a0c030", "306230"], ["306230", "5a8a28", "1d4a1d"]].map((r) => r.map((h) => pack(rgb(h))));

// M's line: one unbroken groove from mid-face on the right, across the
// left face and the next side round, over the top and down into the J.
// Beat one lights the first two sides, beat two the third side and the
// top, beat three the J. Cells are [col, row].
const PATHS = [
  ["z-", [[5, 5], [7, 5], [7, 2], [3, 2], [3, 7], [0, 7]]],
  ["x-", [[9, 7], [6, 7], [6, 3], [2, 3], [2, 6], [0, 6]]],
  ["z+", [[9, 6], [7, 6], [7, 8], [3, 8], [3, 4], [6, 4], [6, 0]]],
  ["y+", [[3, 0], [3, 5], [7, 5], [7, 2], [9, 2]]],
  ["x+", [[7, 0], [7, 8], [2, 8], [2, 5]]],
];
const cells = {}, SEC = { "z-": 0, "x-": 0, "z+": 1, "y+": 1, "x+": 2 };
for (const [f, pts] of PATHS) for (let i = 1; i < pts.length; i++) {
  let [a, b] = pts[i - 1]; const [ea, eb] = pts[i];
  for (;;) { cells[f + a + "," + b] = 1; if (a === ea && b === eb) break; a += Math.sign(ea - a); b += Math.sign(eb - b); }
}
const on = (f, a, b) => a < 0 || b < 0 || f + a + "," + b in cells;

const PITCH = Math.PI / 6, SP = Math.sin(PITCH), CP = Math.cos(PITCH), L = [-0.5, 0.83, -0.17];
function toObj([a, b, z], yaw) {
  const y1 = b * CP - z * SP, z1 = b * SP + z * CP, cs = Math.cos(-yaw), sn = Math.sin(-yaw);
  return [a * cs - z1 * sn, y1, a * sn + z1 * cs];
}
const toWorld = ([a, b, z], yaw) => [a * Math.cos(yaw) - z * Math.sin(yaw), b, a * Math.sin(yaw) + z * Math.cos(yaw)];
function hitBox(o, d) {
  let tn = -1e9, tf = 1e9, ax = 0, sg = 0;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-9) { if (Math.abs(o[i]) > 1) return null; continue; }
    let t1 = (-1 - o[i]) / d[i], t2 = (1 - o[i]) / d[i], s = -1;
    if (t1 > t2) { const q = t1; t1 = t2; t2 = q; s = 1; }
    if (t1 > tn) { tn = t1; ax = i; sg = s; }
    if (t2 < tf) tf = t2;
    if (tn > tf) return null;
  }
  return { ax, sg, p: [o[0] + d[0] * tn, o[1] + d[1] * tn, o[2] + d[2] * tn] };
}
function uv(ax, sg, p) {
  const cl = (q) => Math.min(0.9999, Math.max(0, q));
  if (ax === 1) return [cl((p[0] + 1) / 2), cl((1 - p[2]) / 2)];
  return [cl(((ax === 0 ? p[2] * sg : -p[0] * sg) + 1) / 2), cl((1 - p[1]) / 2)];
}

// Shade row by light: [face, flashed face, empty groove].
function paint(f, u, v, b, lit, flash) {
  const row = SHADES[b >= 0.95 ? 0 : b >= 0.7 ? 1 : 2], iu = u * 10 | 0, iv = v * 10 | 0;
  if (!cells[f + iu + "," + iv]) return row[SEC[f] === flash ? 1 : 0];
  if ((!on(f, iu, iv - 1) && v * 10 - iv < 0.3) || (!on(f, iu - 1, iv) && u * 10 - iu < 0.3)) return LIP;
  return SEC[f] < lit ? LIT : row[2];
}
function render(yaw, rev, flash) {
  buf.fill(BG); mask.fill(0);
  const ex = toObj([1, 0, 0], yaw), ey = toObj([0, 1, 0], yaw), d = toObj([0, 0, 1], yaw), shade = {};
  for (const [f, w] of [["x+", [1, 0, 0]], ["x-", [-1, 0, 0]], ["z+", [0, 0, 1]], ["z-", [0, 0, -1]], ["y+", [0, 1, 0]]]) {
    const q = toWorld(w, yaw);
    shade[f] = Math.min(1, Math.round((0.4 + 0.7 * Math.max(0, q[0] * L[0] + q[1] * L[1] + q[2] * L[2])) * 8) / 8);
  }
  for (let py = 0; py < VH; py++) for (let px = 0; px < VW; px++) {
    const X = (px + 0.5 - VW / 2) / SC, Y = -(py + 0.5 - VH / 2) / SC, i = py * VW + px;
    const h = hitBox([ex[0] * X + ey[0] * Y - d[0] * 10, ex[1] * X + ey[1] * Y - d[1] * 10, ex[2] * X + ey[2] * Y - d[2] * 10], d);
    if (!h) continue;
    const f = "xyz"[h.ax] + (h.sg > 0 ? "+" : "-"), [u, v] = uv(h.ax, h.sg, h.p);
    mask[i] = 1; buf[i] = paint(f, u, v, shade[f] ?? 0.4, rev, flash);
  }
  for (let i = 0; i < mask.length; i++) if (!mask[i] && (mask[i - 1] || mask[i + 1] || mask[i - VW] || mask[i + VW])) buf[i] = INK;
  x.putImageData(img, 0, 0);
}

// A gentle three quarter turn counterclockwise, eased in and out, that stops
// with the J face in front on the right. It settles before the first beat,
// so each beat lights a face that is in view.
const FPS = 20, SPIN = 0.9, BEATS = [0.95, 1.25, 1.55];
const yawAt = (t) => { const k = Math.min(t / SPIN, 1); return Math.PI / 4 + 1.5 * Math.PI * k * k * (3 - 2 * k); };
function frame(t) {
  const lit = BEATS.filter((b) => t >= b).length;
  render(yawAt(t), lit, lit && t < BEATS[lit - 1] + 0.1 ? lit - 1 : -1);
}

let A;
function tone(f, at, dur, gain, type = "triangle", f2) {
  const o = A.createOscillator(), g = A.createGain(), s = A.currentTime + at;
  o.type = type; o.frequency.setValueAtTime(f, s);
  if (f2) o.frequency.exponentialRampToValueAtTime(f2, s + dur);
  g.gain.setValueAtTime(0.001, s); g.gain.exponentialRampToValueAtTime(gain, s + 0.02);
  g.gain.exponentialRampToValueAtTime(0.001, s + dur);
  o.connect(g).connect(A.destination); o.start(s); o.stop(s + dur);
}
function sound() {
  // I's power-on, the standard: a low hum that rises, then each beat stacks
  // one more held note into a chord that rings out together.
  tone(55, 0, 0.55, 0.24, "triangle", 110);
  const END = BEATS[2] + 0.9;
  tone(131, BEATS[0], END - BEATS[0], 0.1);
  tone(196, BEATS[1], END - BEATS[1], 0.08);
  tone(262, BEATS[2], END - BEATS[2], 0.07); tone(392, BEATS[2], END - BEATS[2], 0.025, "square");
}


/** Seconds from start until the chord has rung out. */
export const JBOX_SPIN_LENGTH = BEATS[2] + 0.9;

/**
 * Play the tag once on `canvas`. Call it from a click or key press, so the browser lets
 * the sound play. Resolves when the tag is done.
 */
export function playJboxSpin(canvas, { sound: withSound = true } = {}) {
  canvas.width = VW;
  canvas.height = VH;
  x = canvas.getContext("2d");
  img = x.createImageData(VW, VH);
  buf = new Uint32Array(img.data.buffer);
  if (withSound) {
    try {
      A = A || new AudioContext();
      A.resume();
      sound();
    } catch {}
  }
  const t0 = performance.now();
  let last = -1;
  return new Promise((done) => {
    (function loop(now) {
      const t = (now - t0) / 1000;
      const step = Math.max(0, Math.floor(t * FPS));
      if (step !== last) { last = step; frame(Math.min(step / FPS, SPIN + 1)); }
      if (t >= JBOX_SPIN_LENGTH) return done();
      requestAnimationFrame(loop);
    })(t0);
  });
}

/** Whole-pixel scale that fits the tag in a box. */
export function jboxScale(width, height) {
  return Math.max(1, Math.floor(Math.min(width / VW, height / VH)));
}
