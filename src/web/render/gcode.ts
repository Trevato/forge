/**
 * A sliced `.gcode` file drawn one layer at a time, as SVG made on the server.
 *
 * The parser reads the linear moves a slicer writes (G0/G1; G2/G3 are taken
 * as the straight line to their endpoint), honours G90/G91 (positioning),
 * M82/M83 (extruder mode) and G92 (set position), and groups the moves that
 * extrude into layers by Z. Units are millimetres (G21, the slicer default;
 * G20 inches are not converted, see docs/features/gcode.md). Nothing from the file reaches the page but
 * numbers: comments are read only for a time estimate and never echoed.
 *
 * Filament used (mm of filament, the E axis): the sum of forward E travel,
 * with a retraction's rewind paid back before further forward travel counts.
 * So a retract of 1 mm followed by an unretract of 1 mm adds nothing, and
 * 20 mm of E in 3 layers is 20 mm. This is the same for absolute and
 * relative extruder modes.
 *
 * A parse is kept by the file's size and content hash,
 * so paging through layers parses once.
 */

import { html, raw } from "../html.ts";
import { fileSize } from "../ui.ts";
import type { Rendered, RenderInput } from "./renderers.ts";

/** Segments one layer's drawing holds; more are left out and the page says so. */
export const SEGMENT_CAP = 20_000;

export interface Layer {
  /** Z in mm of the extruding moves. */
  readonly z: number;
  /** x0, y0, x1, y1, extrudes (1) or travels (0), per move. */
  readonly moves: Float32Array;
}
export interface Gcode {
  readonly layers: readonly Layer[];
  /** x, y, z extents of the extruding moves, in mm. */
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
  /** Millimetres of filament. */
  readonly filament: number;
  /** The slicer's own estimate in seconds, when a comment states one. */
  readonly seconds?: number;
}

const WORD = /([A-Za-z])\s*([+-]?(?:\d+\.?\d*|\.\d+))/g;
const SECONDS = /^\s*TIME\s*:\s*(\d+(?:\.\d+)?)\s*$/i;
const ESTIMATE = /(?:estimated printing time|total estimated time)[^=:]*[=:]\s*((?:\d+\s*[dhms]\s*)+)$/i;

/** `1d 2h 3m 4s` as seconds. */
function duration(text: string): number {
  let s = 0;
  for (const m of text.matchAll(/(\d+)\s*([dhms])/gi))
    s += Number(m[1]) * ({ d: 86400, h: 3600, m: 60, s: 1 }[m[2]!.toLowerCase() as "d"] ?? 0);
  return s;
}

/** Moves as five floats each in one typed array that doubles as it fills: 20 bytes a move, no boxed numbers. */
class Moves {
  private a = new Float32Array(5 * 64);
  private n = 0;
  push(x0: number, y0: number, x1: number, y1: number, k: number): void {
    if (this.n + 5 > this.a.length) this.grow(this.n + 5);
    const a = this.a;
    a[this.n] = x0; a[this.n + 1] = y0; a[this.n + 2] = x1; a[this.n + 3] = y1; a[this.n + 4] = k;
    this.n += 5;
  }
  private grow(need: number): void {
    const b = new Float32Array(Math.max(need, this.a.length * 2));
    b.set(this.a.subarray(0, this.n));
    this.a = b;
  }
  /** Add another run's moves after these (a loop of copies, never a spread of arguments). */
  append(other: Moves): void {
    if (other.n === 0) return;
    if (this.n + other.n > this.a.length) this.grow(this.n + other.n);
    this.a.set(other.a.subarray(0, other.n), this.n);
    this.n += other.n;
  }
  /** Past twice `moves` moves, forget all but the last `moves` (amortised: one copy per `moves` pushes). */
  keepLast(moves: number): void {
    if (this.n <= 10 * moves) return;
    this.a.copyWithin(0, this.n - 5 * moves, this.n);
    this.n = 5 * moves;
  }
  done(): Float32Array {
    return this.a.slice(0, this.n);
  }
}

/** Parse G-code text. Pure. Undefined when no move in it extrudes. */
export function parseGcode(text: string): Gcode | undefined {
  let x = 0, y = 0, z = 0, e = 0;
  let absolute = true;
  let absoluteE = true;
  let retracted = 0;
  let filament = 0;
  let seconds: number | undefined;
  const layers: Layer[] = [];
  let layerZ: number | undefined;
  let cur = new Moves();
  let pending = new Moves();
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];

  const close = (): void => {
    if (layerZ !== undefined) layers.push({ z: layerZ, moves: cur.done() });
    cur = new Moves();
  };

  let pos = 0;
  const n = text.length;
  while (pos < n) {
    let end = text.indexOf("\n", pos);
    if (end < 0) end = n;
    let line = text.slice(pos, end);
    pos = end + 1;
    const semi = line.indexOf(";");
    if (semi >= 0) {
      const comment = line.slice(semi + 1);
      line = line.slice(0, semi);
      if (seconds === undefined) {
        const t = SECONDS.exec(comment);
        if (t !== null) seconds = Number(t[1]);
        else {
          const p = ESTIMATE.exec(comment.trim());
          if (p !== null) seconds = duration(p[1]!);
        }
      }
    }
    const star = line.indexOf("*");
    if (star >= 0) line = line.slice(0, star);
    line = line.trim();
    const c0 = line.charCodeAt(0);
    // Only G and M words (either case), after an optional N line number.
    if (c0 !== 71 && c0 !== 103 && c0 !== 77 && c0 !== 109 && c0 !== 78 && c0 !== 110) continue;

    let code = "";
    const v: Record<string, number> = {};
    for (const m of line.matchAll(WORD)) {
      const letter = m[1]!.toUpperCase();
      const value = Number(m[2]);
      if (!Number.isFinite(value)) continue;
      if ((letter === "G" || letter === "M") && code === "") code = letter + String(Math.trunc(value));
      else if (letter !== "N") v[letter] = value;
    }
    switch (code) {
      case "G90": absolute = true; break;
      case "G91": absolute = false; break;
      case "M82": absoluteE = true; break;
      case "M83": absoluteE = false; break;
      case "G92":
        if (v["X"] !== undefined) x = v["X"];
        if (v["Y"] !== undefined) y = v["Y"];
        if (v["Z"] !== undefined) z = v["Z"];
        if (v["E"] !== undefined) e = v["E"];
        break;
      case "G0":
      case "G1":
      case "G2":
      case "G3": {
        const nx = v["X"] === undefined ? x : absolute ? v["X"] : x + v["X"];
        const ny = v["Y"] === undefined ? y : absolute ? v["Y"] : y + v["Y"];
        const nz = v["Z"] === undefined ? z : absolute ? v["Z"] : z + v["Z"];
        let de = 0;
        if (v["E"] !== undefined) {
          if (absoluteE) {
            de = v["E"] - e;
            e = v["E"];
          } else de = v["E"];
        }
        const moved = nx !== x || ny !== y;
        if (de < 0) retracted -= de;
        let forward = 0;
        if (de > 0) {
          const paid = Math.min(retracted, de);
          retracted -= paid;
          forward = de - paid;
        }
        const extrudes = de > 0 && moved;
        // Z is rounded to the micron so float noise does not make a layer.
        const zr = Math.round(nz * 1000) / 1000;
        if (extrudes) {
          filament += forward;
          if (layerZ === undefined || zr !== layerZ) {
            close();
            layerZ = zr;
            // The travel that led here belongs to the layer it arrives in.
            cur = pending;
          } else cur.append(pending);
          pending = new Moves();
          cur.push(x, y, nx, ny, 1);
          min[0] = Math.min(min[0]!, x, nx);
          min[1] = Math.min(min[1]!, y, ny);
          min[2] = Math.min(min[2]!, zr);
          max[0] = Math.max(max[0]!, x, nx);
          max[1] = Math.max(max[1]!, y, ny);
          max[2] = Math.max(max[2]!, zr);
        } else {
          filament += de > 0 ? forward : 0;
          if (moved && layerZ !== undefined) {
            pending.push(x, y, nx, ny, 0);
            // A long travel run before the next extrusion is bounded.
            pending.keepLast(SEGMENT_CAP);
          }
        }
        x = nx;
        y = ny;
        z = nz;
        break;
      }
    }
  }
  close();
  if (layers.length === 0) return undefined;
  return {
    layers,
    min: min as [number, number, number],
    max: max as [number, number, number],
    filament,
    ...(seconds !== undefined ? { seconds } : {}),
  };
}

const kept = new Map<string, Gcode | null>();
const KEEP = 4;
/** Larger than this and the parse belongs on a worker, not the request thread. */
export const INLINE_MAX = 256 * 1024;

/**
 * The key of a body: its size and a 64-bit wyhash (about 1 GB/s, so 50 MB is
 * tens of milliseconds where a SHA-1 would be several times that). A parse is
 * only a picture of the file, and a collision needs two files of one size.
 */
const keyOf = (body: Uint8Array): string => `${body.length}:${Bun.hash.wyhash(body).toString(16)}`;

/** A kept parse: the Gcode, null when the file has no moves, undefined when not parsed yet. */
export function keptGcode(body: Uint8Array): Gcode | null | undefined {
  const id = keyOf(body);
  const hit = kept.get(id);
  if (hit !== undefined) {
    kept.delete(id);
    kept.set(id, hit);
  }
  return hit;
}

/** Keep a parse (made on a worker or here) for the next page of the same file. */
export function keepGcode(body: Uint8Array, parsed: Gcode | undefined): void {
  kept.set(keyOf(body), parsed ?? null);
  if (kept.size > KEEP) kept.delete(kept.keys().next().value!);
}

/** The parse of a body, once per content. Inline: callers with a big body use `gcodeOffThread` first. */
export function parsedGcode(body: Uint8Array): Gcode | undefined {
  const hit = keptGcode(body);
  if (hit !== undefined) return hit ?? undefined;
  const parsed = parseGcode(new TextDecoder().decode(body));
  keepGcode(body, parsed);
  return parsed;
}

/**
 * How many layers a body has, for a page that must know a `?layer=` is real.
 * A body not yet parsed and too big to parse here counts as none.
 */
export function layerCount(body: Uint8Array): number {
  const hit = keptGcode(body);
  if (hit === undefined && body.length > INLINE_MAX) return 0;
  return (hit === undefined ? parsedGcode(body) : (hit ?? undefined))?.layers.length ?? 0;
}

const mm = (n: number): string => (Math.round(n * 100) / 100).toLocaleString("en", { maximumFractionDigits: 2 });
const f2 = (n: number): string => (Math.round(n * 100) / 100).toString();

/** `1 h 02 min`, `4 min 05 s`, `38 s`. */
export function clock(seconds: number): string {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h} h ${String(m).padStart(2, "0")} min`;
  if (m > 0) return `${m} min ${String(s % 60).padStart(2, "0")} s`;
  return `${s} s`;
}

/** Facts as label and text, shared by the page and the tests. */
export function gcodeFacts(g: Gcode): [string, string][] {
  const [w, d, h] = [g.max[0] - g.min[0], g.max[1] - g.min[1], g.max[2]];
  const facts: [string, string][] = [
    ["Layers", g.layers.length.toLocaleString("en")],
    ["Bounding box", `${mm(w)} × ${mm(d)} × ${mm(h)} mm`],
    ["Filament", `${mm(g.filament)} mm`],
  ];
  if (g.seconds !== undefined) facts.push(["Estimated time", clock(g.seconds)]);
  return facts;
}

const W = 640;
const MAX_H = 480;
const PAD = 8;

/** One layer as an SVG: extrusion bold, travel faint. Numbers only. */
export function layerSvg(g: Gcode, index: number): { svg: string; shown: number; total: number } {
  const layer = g.layers[index]!;
  const spanX = Math.max(g.max[0] - g.min[0], 0.1);
  const spanY = Math.max(g.max[1] - g.min[1], 0.1);
  let scale = (W - 2 * PAD) / spanX;
  if (spanY * scale + 2 * PAD > MAX_H) scale = (MAX_H - 2 * PAD) / spanY;
  const width = Math.round(spanX * scale + 2 * PAD);
  const height = Math.round(spanY * scale + 2 * PAD);
  const px = (v: number): string => f2(PAD + (v - g.min[0]) * scale);
  const py = (v: number): string => f2(PAD + (g.max[1] - v) * scale);
  const total = layer.moves.length / 5;
  const shown = Math.min(total, SEGMENT_CAP);
  let bold = "";
  let faint = "";
  let lx = NaN, ly = NaN, lk = -1;
  for (let i = 0; i < shown; i++) {
    const o = i * 5;
    const [x0, y0, x1, y1, k] = [layer.moves[o]!, layer.moves[o + 1]!, layer.moves[o + 2]!, layer.moves[o + 3]!, layer.moves[o + 4]!];
    // A move that starts where the last ended, of the same kind, continues its path.
    const join = k === lk && Math.abs(x0 - lx) < 1e-3 && Math.abs(y0 - ly) < 1e-3;
    const seg = `${join ? "L" : `M${px(x0)} ${py(y0)}L`}${px(x1)} ${py(y1)}`;
    if (k === 1) bold += seg;
    else faint += seg;
    lx = x1; ly = y1; lk = k;
  }
  const svg =
    `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Layer ${index + 1} of ${g.layers.length}, Z ${mm(layer.z)} mm" fill="none" stroke-linecap="round" stroke-linejoin="round">` +
    `<path d="${faint}" stroke="currentColor" stroke-opacity="0.25" stroke-width="0.75"/>` +
    `<path d="${bold}" stroke="currentColor" stroke-width="${f2(Math.min(3, Math.max(1, 0.4 * scale)))}"/></svg>`;
  return { svg, shown, total };
}

export function gcode(input: RenderInput): Rendered {
  const hit = keptGcode(input.body);
  if (hit === undefined && input.body.length > INLINE_MAX)
    return { content: html``, lines: 0, fallback: "This file is too big to draw while the forge is busy; try again, or download it." };
  const g = hit === undefined ? parsedGcode(input.body) : (hit ?? undefined);
  if (g === undefined) return { content: html``, lines: 0, fallback: "This file has no extruding moves to draw." };
  const count = g.layers.length;
  const want = input.layer !== undefined && Number.isInteger(input.layer) ? input.layer : 1;
  const n = Math.min(count, Math.max(1, want));
  const { svg, shown, total } = layerSvg(g, n - 1);
  const facts = gcodeFacts(g);
  const href = input.pathHref ?? "";
  const nav = (to: number, label: string, on: boolean) =>
    on
      ? html`<a class="btn" href="${href}?layer=${to}" rel="${to < n ? "prev" : "next"}">${label}</a>`
      : html`<span class="btn" aria-disabled="true">${label}</span>`;
  const content = html`<figure class="gcode-view">
    <div class="gcode-nav">
      ${nav(n - 1, "← Previous", n > 1)}
      <form method="get" action="${href}" class="gcode-form">
        <label>Layer <input type="number" name="layer" min="1" max="${count}" value="${n}" inputmode="numeric" required> of ${count.toLocaleString("en")}</label>
        <button type="submit" class="btn">Show</button>
      </form>
      ${nav(n + 1, "Next →", n < count)}
    </div>
    ${raw(svg)}
    <p class="muted small">Layer ${n.toLocaleString("en")} · Z ${mm(g.layers[n - 1]!.z)} mm: solid lines extrude, faint lines travel.${shown < total ? ` Drawing the first ${shown.toLocaleString("en")} of ${total.toLocaleString("en")} moves.` : ""}</p>
    <dl class="status-rows">${facts.map(([k, v]) => html`<div class="status-row"><dt>${k}</dt><dd>${v}</dd></div>`)}</dl>
    <p class="small"><a href="${input.download}">Download</a></p>
  </figure>`;
  return {
    content,
    lines: 0,
    summary: `${count.toLocaleString("en")} layers · ${mm(g.filament / 1000)} m filament · ${fileSize(input.size)}`,
  };
}
