/**
 * A GPS track (`.gpx`) drawn as its route: an inline SVG outline of every
 * track segment and route, fitted to their bounds by an equirectangular
 * projection (longitude scaled by the cosine of the middle latitude). No map
 * tiles, no network. Distance is the haversine sum, climb the sum of rises.
 *
 * The parser is a small tag scanner, not an XML engine: it reads the five
 * predefined entities and numeric references in names and nothing else, so a
 * DOCTYPE with entity definitions is skipped and never expanded. A file whose
 * tags do not nest, or that holds no point, is not a GPX file to us: the
 * caller falls back to the text view.
 */

import { html, raw } from "../html.ts";
import { fileSize } from "../ui.ts";
import type { Rendered, RenderInput } from "./renderers.ts";

/** Points drawn; more than this are thinned evenly across the whole track. */
export const POINT_CAP = 20_000;

export interface Point {
  readonly lat: number;
  readonly lon: number;
  readonly ele?: number;
}
export interface Line {
  readonly name: string;
  readonly points: Point[];
}
export interface Gpx {
  readonly lines: Line[];
  readonly count: number;
}

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
/** Predefined and numeric references only; any other `&name;` stays text. */
const decode = (s: string): string =>
  s.replace(/&(?:#(\d{1,6})|#x([0-9a-fA-F]{1,5})|(amp|lt|gt|quot|apos));/g, (m, d, h, n) => {
    if (n !== undefined) return ENTITIES[n]!;
    const code = d !== undefined ? Number(d) : parseInt(h, 16);
    return code > 0x1f || code === 9 || code === 10 ? String.fromCodePoint(code) : m;
  });

const TAG = /<!--[\s\S]*?-->|<!DOCTYPE[^[>]*(?:\[[\s\S]*?\])?\s*>|<!\[CDATA\[([\s\S]*?)\]\]>|<[?!][^>]*>|<(\/?)([A-Za-z_][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>|([^<]+)/g;
const ATTR = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

const attr = (src: string, name: string): string | undefined => {
  for (const m of src.matchAll(ATTR)) if (m[1] === name) return m[2] ?? m[3];
  return undefined;
};
const local = (tag: string): string => tag.slice(tag.indexOf(":") + 1).toLowerCase();
const coord = (v: string | undefined, max: number): number | undefined => {
  if (v === undefined || !/^\s*[+-]?\d+(\.\d+)?\s*$/.test(v)) return undefined;
  const n = Number(v);
  return Math.abs(n) <= max ? n : undefined;
};

/** Parse GPX text. Pure. Returns undefined when it is not well-formed GPX with a point. */
export function parseGpx(source: string): Gpx | undefined {
  const stack: string[] = [];
  const lines: Line[] = [];
  let name = "";
  let current: { lat: number; lon: number; ele?: number } | undefined;
  let seg: Point[] | undefined;
  let text = "";
  let sawRoot = false;
  let count = 0;

  const open = (tag: string, attrs: string): void => {
    if (stack.length === 0) {
      if (tag !== "gpx") throw new Error("root");
      sawRoot = true;
    }
    if (tag === "trk" || tag === "rte") name = "";
    if (tag === "trkseg" || tag === "rte") {
      seg = [];
      lines.push({ name, points: seg });
    }
    if (tag === "trkpt" || tag === "rtept") {
      const lat = coord(attr(attrs, "lat"), 90);
      const lon = coord(attr(attrs, "lon"), 180);
      current = lat !== undefined && lon !== undefined ? { lat, lon } : undefined;
    }
    if (tag === "name" || tag === "ele") text = "";
  };
  const close = (tag: string): void => {
    const parent = stack[stack.length - 1];
    if (tag === "ele" && current !== undefined && /^\s*[+-]?\d+(\.\d+)?([eE][+-]?\d+)?\s*$/.test(text))
      current.ele = Number(text);
    if (tag === "name" && (parent === "trk" || parent === "rte") && name === "") name = decode(text.trim());
    if ((tag === "trkpt" || tag === "rtept") && current !== undefined && seg !== undefined) {
      seg.push(current);
      count++;
      current = undefined;
    }
    if (tag === "trkseg" || tag === "rte") seg = undefined;
    if (tag === "name" || tag === "ele") text = "";
  };

  try {
    for (const m of source.replace(/^﻿/, "").matchAll(TAG)) {
      const [, cdata, closing, rawTag, attrs, selfClose, chars] = m;
      if (cdata !== undefined) text += cdata;
      else if (chars !== undefined) {
        if (stack.length === 0 && chars.trim() !== "") throw new Error("text outside root");
        text += chars;
      } else if (rawTag !== undefined) {
        const tag = local(rawTag);
        if (closing === "/") {
          if (stack.pop() !== tag) throw new Error("mismatch");
          close(tag);
        } else {
          if (stack.length === 0 && sawRoot) throw new Error("two roots");
          open(tag, attrs ?? "");
          if (selfClose === "/") close(tag);
          else stack.push(tag);
        }
      }
    }
  } catch {
    return undefined;
  }
  if (!sawRoot || stack.length > 0 || count === 0) return undefined;
  return { lines: lines.filter((l) => l.points.length > 0), count };
}

/** Keep at most `cap` points of a list, evenly spaced, first and last included. */
export function thin<T>(items: readonly T[], cap: number): T[] {
  if (items.length <= cap) return [...items];
  if (cap < 2) return items.slice(0, cap);
  const out: T[] = [];
  for (let i = 0; i < cap; i++) out.push(items[Math.round((i * (items.length - 1)) / (cap - 1))]!);
  return out;
}

const R = 6_371_008.8;
const rad = (d: number): number => (d * Math.PI) / 180;
/** Great-circle distance in metres between two points. */
export function haversine(a: Point, b: Point): number {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface Stats {
  /** Metres. */
  readonly distance: number;
  /** Metres climbed. */
  readonly gain: number;
}
export function gpxStats(gpx: Gpx): Stats {
  let distance = 0;
  let gain = 0;
  for (const line of gpx.lines) {
    for (let i = 1; i < line.points.length; i++) {
      const a = line.points[i - 1]!;
      const b = line.points[i]!;
      distance += haversine(a, b);
      if (a.ele !== undefined && b.ele !== undefined && b.ele > a.ele) gain += b.ele - a.ele;
    }
  }
  return { distance, gain };
}

const W = 640;
const MAX_H = 480;
const PAD = 12;

/** The outline as SVG path data in a viewBox, thinned to `POINT_CAP` points overall. */
export function outline(gpx: Gpx): { width: number; height: number; paths: string[] } {
  const keep = gpx.count > POINT_CAP ? POINT_CAP / gpx.count : 1;
  const lines = gpx.lines.map((l) => thin(l.points, Math.max(2, Math.floor(l.points.length * keep))));
  let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
  for (const l of gpx.lines)
    for (const p of l.points) {
      minLat = Math.min(minLat, p.lat);
      maxLat = Math.max(maxLat, p.lat);
      minLon = Math.min(minLon, p.lon);
      maxLon = Math.max(maxLon, p.lon);
    }
  const k = Math.cos(rad((minLat + maxLat) / 2));
  const spanX = Math.max((maxLon - minLon) * k, 1e-9);
  const spanY = Math.max(maxLat - minLat, 1e-9);
  let scale = (W - 2 * PAD) / spanX;
  let height = spanY * scale + 2 * PAD;
  if (height > MAX_H) {
    scale = (MAX_H - 2 * PAD) / spanY;
    height = MAX_H;
  }
  const width = Math.max(spanX * scale + 2 * PAD, 2 * PAD + 1);
  const f = (n: number): string => n.toFixed(1);
  const paths = lines.map((pts) =>
    pts
      .map((p, i) => `${i === 0 ? "M" : "L"}${f(PAD + (p.lon - minLon) * k * scale)} ${f(PAD + (maxLat - p.lat) * scale)}`)
      .join(""),
  );
  return { width: Math.round(width), height: Math.round(height), paths };
}

const km = (m: number): string => (m / 1000).toLocaleString("en", { maximumFractionDigits: 2 });

/** Track, Distance, Climb, Points as text: the facts both the page and the terminal show. */
export function gpxFacts(parsed: Gpx, path: string): [string, string][] {
  const { distance, gain } = gpxStats(parsed);
  const named = parsed.lines.map((l) => l.name).filter((n) => n !== "");
  return [
    ["Track", named[0] ?? path.slice(path.lastIndexOf("/") + 1)],
    ["Distance", `${km(distance)} km`],
    ["Climb", `${Math.round(gain).toLocaleString("en")} m`],
    ["Points", parsed.count.toLocaleString("en")],
  ];
}

export function gpx(input: RenderInput): Rendered {
  const parsed = parseGpx(new TextDecoder().decode(input.body));
  if (parsed === undefined)
    return { content: html``, lines: 0, fallback: "This file is not a readable GPX track." };
  const { width, height, paths } = outline(parsed);
  const facts = gpxFacts(parsed, input.path);
  const d = paths.map((p) => `<path d="${p}"/>`).join("");
  const title = facts[0]![1];
  const content = html`<figure class="gpx-view">
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Route of ${title}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${raw(d)}</svg>
    <dl class="status-rows">${facts.map(([k, v]) => html`<div class="status-row"><dt>${k}</dt><dd>${v}</dd></div>`)}</dl>
  </figure>`;
  const { distance, gain } = gpxStats(parsed);
  return {
    content,
    lines: 0,
    summary: `${km(distance)} km · ${Math.round(gain)} m climb · ${fileSize(input.size)}`,
  };
}
