/**
 * An ASCII DXF drawing (`.dxf`, AutoCAD's exchange format) drawn as inline SVG.
 * The file is a list of (group code, value) line pairs; this reads the
 * ENTITIES section and draws LINE, CIRCLE, ARC and LWPOLYLINE, scaled to their
 * bounding box with the y axis flipped (DXF is y-up, SVG y-down). Angles are
 * degrees counter-clockwise, as in the DXF reference (group codes 10/20/11/21
 * points, 40 radius, 50/51 arc angles, 70 polyline flags, 8 layer). Bulges
 * (code 42) are ignored: a polyline's segments are drawn straight. TEXT and
 * every other entity are counted as ignored, never drawn. A binary DXF has a
 * NUL in its head and never reaches here; a file with no entities, no EOF
 * or no ENTITIES section falls back to the source view. Every number is
 * finite and clamped, every string escaped.
 */

import { html, raw } from "../html.ts";
import type { Rendered, RenderInput } from "./renderers.ts";
import { RENDER_CAP } from "./kinds.ts";
import { fileSize } from "../ui.ts";

/** Entities drawn in all; the rest are counted but not drawn. */
export const ENTITY_CAP = 50_000;
const LAYER_SHOWN = 50;
const NAME_CHARS = 80;
/** Coordinates beyond this magnitude are treated as corrupt. */
const LIMIT = 1e9;

type Pt = readonly [number, number];
export type Shape =
  | { readonly t: "line"; readonly a: Pt; readonly b: Pt }
  | { readonly t: "circle"; readonly c: Pt; readonly r: number }
  | { readonly t: "arc"; readonly c: Pt; readonly r: number; readonly from: number; readonly to: number }
  | { readonly t: "poly"; readonly pts: Pt[]; readonly closed: boolean };

export interface Drawing {
  readonly shapes: Shape[];
  /** Entity counts by type, drawn or not. */
  readonly counts: Map<string, number>;
  readonly layers: string[];
  /** Drawable entities left out past ENTITY_CAP. */
  readonly dropped: number;
}

const DRAWN = new Set(["LINE", "CIRCLE", "ARC", "LWPOLYLINE"]);

const num = (s: string | undefined): number | undefined => {
  if (s === undefined || s.trim() === "") return undefined;
  const n = Number(s);
  return Number.isFinite(n) && Math.abs(n) <= LIMIT ? n : undefined;
};

/** Parse DXF text. Pure. An error string when it cannot be drawn. */
export function parseDxf(text: string): Drawing | { error: string } {
  const lines = text.replace(/^﻿/, "").split(/\r\n|\n|\r/);
  if (lines.length < 4) return { error: "it is too short to be a drawing" };
  let inEntities = false;
  let sawEntities = false;
  let sawEof = false;
  const counts = new Map<string, number>();
  const layers = new Set<string>();
  const shapes: Shape[] = [];
  type Cur = { type: string; layer: string; codes: [number, string][] };
  let cur: Cur | undefined;
  let expectName = false;
  let dropped = 0;

  const finish = (): void => {
    if (cur === undefined) return;
    const e = cur;
    cur = undefined;
    counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
    layers.add(e.layer);
    if (shapes.length >= ENTITY_CAP) {
      if (DRAWN.has(e.type)) dropped++;
      return;
    }
    const first = (code: number): number | undefined => num(e.codes.find((c) => c[0] === code)?.[1]);
    const x = first(10), y = first(20);
    switch (e.type) {
      case "LINE": {
        const x2 = first(11), y2 = first(21);
        if (x !== undefined && y !== undefined && x2 !== undefined && y2 !== undefined)
          shapes.push({ t: "line", a: [x, y], b: [x2, y2] });
        break;
      }
      case "CIRCLE": {
        const r = first(40);
        if (x !== undefined && y !== undefined && r !== undefined && r > 0) shapes.push({ t: "circle", c: [x, y], r });
        break;
      }
      case "ARC": {
        const r = first(40), from = first(50), to = first(51);
        if (x !== undefined && y !== undefined && r !== undefined && r > 0 && from !== undefined && to !== undefined)
          shapes.push({ t: "arc", c: [x, y], r, from, to });
        break;
      }
      case "LWPOLYLINE": {
        const pts: Pt[] = [];
        let px: number | undefined;
        for (const [code, v] of e.codes) {
          if (code === 10) px = num(v);
          else if (code === 20 && px !== undefined) {
            const py = num(v);
            if (py !== undefined) pts.push([px, py]);
            px = undefined;
          }
        }
        const flags = first(70) ?? 0;
        if (pts.length >= 2) shapes.push({ t: "poly", pts, closed: (flags & 1) === 1 });
        break;
      }
    }
  };

  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number(lines[i]!.trim());
    const value = lines[i + 1]!.trim();
    if (!Number.isInteger(code)) return { error: "it is not group-code, value pairs" };
    if (code === 0) {
      finish();
      if (value === "EOF") {
        sawEof = true;
        break;
      }
      if (value === "SECTION") {
        expectName = true;
        inEntities = false;
      } else if (value === "ENDSEC") inEntities = false;
      else if (inEntities) cur = { type: value.slice(0, NAME_CHARS), layer: "0", codes: [] };
      continue;
    }
    if (expectName && code === 2) {
      expectName = false;
      inEntities = value === "ENTITIES";
      if (inEntities) sawEntities = true;
      continue;
    }
    if (cur === undefined) continue;
    if (code === 8) cur.layer = value.slice(0, NAME_CHARS);
    else if (cur.codes.length < 100_000) cur.codes.push([code, value]);
  }
  if (!sawEntities) return { error: "it has no ENTITIES section" };
  if (!sawEof) return { error: "it is cut short (no EOF)" };
  if (shapes.length === 0) return { error: "it has no line, circle, arc or polyline to draw" };
  return { shapes, counts, layers: [...layers].sort(), dropped };
}

const W = 640;
const MAX_H = 480;
const PAD = 12;
const rad = (d: number): number => (d * Math.PI) / 180;
const norm360 = (d: number): number => ((d % 360) + 360) % 360;

/** Corner points of a shape's extent, for the bounding box. */
function extent(s: Shape): Pt[] {
  switch (s.t) {
    case "line":
      return [s.a, s.b];
    case "poly":
      return s.pts;
    case "circle":
      return [[s.c[0] - s.r, s.c[1] - s.r], [s.c[0] + s.r, s.c[1] + s.r]];
    case "arc": {
      const span = norm360(s.to - s.from) || 360;
      const out: Pt[] = [];
      const at = (deg: number): void => void out.push([s.c[0] + s.r * Math.cos(rad(deg)), s.c[1] + s.r * Math.sin(rad(deg))]);
      at(s.from);
      at(s.from + span);
      for (const q of [0, 90, 180, 270]) if (norm360(q - s.from) <= span) at(q);
      return out;
    }
  }
}

/** The SVG body and its size, fitted to the shapes' bounds. */
export function draw(shapes: readonly Shape[]): { width: number; height: number; body: string; lines: number; rounds: number } {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const s of shapes)
    for (const p of extent(s)) {
      minX = Math.min(minX, p[0]);
      maxX = Math.max(maxX, p[0]);
      minY = Math.min(minY, p[1]);
      maxY = Math.max(maxY, p[1]);
    }
  const spanX = Math.max(maxX - minX, 1e-9);
  const spanY = Math.max(maxY - minY, 1e-9);
  let scale = (W - 2 * PAD) / spanX;
  let height = spanY * scale + 2 * PAD;
  if (height > MAX_H) {
    scale = (MAX_H - 2 * PAD) / spanY;
    height = MAX_H;
  }
  const width = Math.max(spanX * scale + 2 * PAD, 2 * PAD + 1);
  const f = (n: number): string => (Number.isFinite(n) ? n : 0).toFixed(2);
  const x = (v: number): string => f(PAD + (v - minX) * scale);
  const y = (v: number): string => f(PAD + (maxY - v) * scale);
  let d = "", circles = "", lines = 0, rounds = 0;
  for (const s of shapes) {
    if (s.t === "line") {
      d += `M${x(s.a[0])} ${y(s.a[1])}L${x(s.b[0])} ${y(s.b[1])}`;
      lines++;
    } else if (s.t === "poly") {
      d += s.pts.map((p, i) => `${i === 0 ? "M" : "L"}${x(p[0])} ${y(p[1])}`).join("") + (s.closed ? "Z" : "");
      lines++;
    } else if (s.t === "circle") {
      circles += `<circle cx="${x(s.c[0])}" cy="${y(s.c[1])}" r="${f(s.r * scale)}"/>`;
      rounds++;
    } else {
      const span = norm360(s.to - s.from);
      const r = f(s.r * scale);
      const p = (deg: number): string => `${x(s.c[0] + s.r * Math.cos(rad(deg)))} ${y(s.c[1] + s.r * Math.sin(rad(deg)))}`;
      if (span === 0) circles += `<circle cx="${x(s.c[0])}" cy="${y(s.c[1])}" r="${r}"/>`;
      else d += `M${p(s.from)}A${r} ${r} 0 ${span > 180 ? 1 : 0} 0 ${p(s.from + span)}`;
      rounds++;
    }
  }
  const body = (d === "" ? "" : `<path d="${d}"/>`) + circles;
  return { width: Math.round(width), height: Math.round(height), body, lines, rounds };
}

const plural = (n: number, one: string): string => `${n.toLocaleString("en")} ${one}${n === 1 ? "" : "s"}`;

export function dxf(input: RenderInput): Rendered {
  const fall = (why: string): Rendered => ({ content: html``, lines: 0, fallback: `This file is shown as text because ${why}.` });
  if (input.size > RENDER_CAP.dxf || input.body.length > RENDER_CAP.dxf) return fall("it is too large to draw");
  const parsed = parseDxf(new TextDecoder().decode(input.body));
  if ("error" in parsed) return fall(parsed.error);
  const drawn = draw(parsed.shapes);
  const entries = [...parsed.counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const total = entries.reduce((n, e) => n + e[1], 0);
  const shownLayers = parsed.layers.slice(0, LAYER_SHOWN);
  const more = parsed.layers.length - shownLayers.length;
  const facts: [string, string][] = [
    ["Entities", `${total.toLocaleString("en")} (${entries.map(([t, n]) => `${n.toLocaleString("en")} ${t}`).join(", ")})`],
    ["Layers", shownLayers.join(", ") + (more > 0 ? ` and ${more} more` : "")],
  ];
  const label = `Drawing of ${plural(total, "entity").replace("entitys", "entities")}`;
  const content = html`<figure class="dxf-view">
    <svg viewBox="0 0 ${drawn.width} ${drawn.height}" role="img" aria-label="${label}" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none">${raw(drawn.body)}</svg>
    <p class="muted small">Lines, circles, arcs and polylines are drawn; other entities are only counted.${parsed.dropped > 0 ? ` ${parsed.dropped.toLocaleString("en")} more past the first ${ENTITY_CAP.toLocaleString("en")} are not drawn.` : ""}</p>
    <dl class="status-rows">${facts.map(([k, v]) => html`<div class="status-row"><dt>${k}</dt><dd>${v}</dd></div>`)}</dl>
  </figure>`;
  return { content, lines: 0, summary: `${plural(total, "entity").replace("entitys", "entities")} · ${fileSize(input.size)}` };
}
