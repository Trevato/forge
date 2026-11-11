/**
 * A GeoJSON file (`.geojson`, RFC 7946) drawn as an outline of its features
 * and a table of their properties. The outline is server-rendered inline SVG:
 * an equirectangular projection (longitude scaled by the cosine of the middle
 * latitude, as `gpx.ts` does) fitted to the bounding box. No tiles, no
 * network. Past `FEATURE_CAP` features only the table and a sentence show.
 * A file that is not valid GeoJSON is shown as the JSON config view.
 */

import { html, raw } from "../html.ts";
import { config } from "./config.ts";
import { thin } from "./gpx.ts";
import type { Rendered, RenderInput } from "./renderers.ts";
import { fileSize } from "../ui.ts";

/** Above this many features no outline is drawn. */
export const FEATURE_CAP = 5_000;
/** Rows of the properties table. */
export const TABLE_ROWS = 100;
/** Columns of the table, and characters of one cell. */
const COLUMN_CAP = 12;
const CELL_CHARS = 200;
/** Vertices drawn in all; more are thinned evenly per part. */
const VERTEX_CAP = 20_000;

type Position = readonly [number, number];
/** A geometry as drawable parts. */
interface Shape {
  readonly points: Position[];
  readonly lines: Position[][];
  readonly rings: Position[][];
}
export interface Feature {
  readonly type: string;
  readonly props: Record<string, unknown>;
  readonly shape: Shape;
}
export interface GeoJson {
  readonly features: Feature[];
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function position(v: unknown): Position {
  if (!Array.isArray(v) || v.length < 2) throw new Error("position");
  const [lon, lat] = v;
  if (typeof lon !== "number" || typeof lat !== "number" || !(Math.abs(lon) <= 180) || !(Math.abs(lat) <= 90))
    throw new Error("range");
  return [lon, lat];
}
const list = (v: unknown, min = 0): unknown[] => {
  if (!Array.isArray(v) || v.length < min) throw new Error("array");
  return v;
};

function addGeometry(g: unknown, into: Shape, depth = 0): string {
  if (!isObj(g) || depth > 8) throw new Error("geometry");
  const c = g.coordinates;
  switch (g.type) {
    case "Point":
      into.points.push(position(c));
      break;
    case "MultiPoint":
      for (const p of list(c)) into.points.push(position(p));
      break;
    case "LineString":
      into.lines.push(list(c, 2).map(position));
      break;
    case "MultiLineString":
      for (const l of list(c)) into.lines.push(list(l, 2).map(position));
      break;
    case "Polygon":
      for (const r of list(c)) into.rings.push(list(r, 4).map(position));
      break;
    case "MultiPolygon":
      for (const p of list(c)) for (const r of list(p)) into.rings.push(list(r, 4).map(position));
      break;
    case "GeometryCollection":
      for (const m of list(g.geometries)) addGeometry(m, into, depth + 1);
      break;
    default:
      throw new Error("type");
  }
  return g.type;
}

function feature(f: unknown): Feature {
  if (!isObj(f)) throw new Error("feature");
  const shape: Shape = { points: [], lines: [], rings: [] };
  let type = "none";
  if (f.type === "Feature") {
    if (f.geometry !== null && f.geometry !== undefined) type = addGeometry(f.geometry, shape);
    if (f.properties !== null && f.properties !== undefined && !isObj(f.properties)) throw new Error("properties");
    return { type, props: (f.properties as Record<string, unknown> | null | undefined) ?? {}, shape };
  }
  type = addGeometry(f, shape);
  return { type, props: {}, shape };
}

/** Parse GeoJSON text. Pure. Undefined when it is not valid GeoJSON. */
export function parseGeoJson(source: string): GeoJson | undefined {
  try {
    const doc: unknown = JSON.parse(source.replace(/^﻿/, ""));
    if (!isObj(doc)) return undefined;
    if (doc.type === "FeatureCollection") return { features: list(doc.features).map(feature) };
    return { features: [feature(doc)] };
  } catch {
    return undefined;
  }
}

const W = 640;
const MAX_H = 480;
const PAD = 12;
const rad = (d: number): number => (d * Math.PI) / 180;

/** The drawing: SVG markup for the shapes, in a viewBox fitted to their bounds. */
export function outline(features: readonly Feature[]): { width: number; height: number; body: string } | undefined {
  let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
  let vertices = 0;
  const see = (p: Position): void => {
    minLon = Math.min(minLon, p[0]);
    maxLon = Math.max(maxLon, p[0]);
    minLat = Math.min(minLat, p[1]);
    maxLat = Math.max(maxLat, p[1]);
    vertices++;
  };
  for (const f of features) {
    f.shape.points.forEach(see);
    f.shape.lines.forEach((l) => l.forEach(see));
    f.shape.rings.forEach((l) => l.forEach(see));
  }
  if (vertices === 0) return undefined;
  const keep = vertices > VERTEX_CAP ? VERTEX_CAP / vertices : 1;
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
  const x = (p: Position): string => (PAD + (p[0] - minLon) * k * scale).toFixed(1);
  const y = (p: Position): string => (PAD + (maxLat - p[1]) * scale).toFixed(1);
  const path = (pts: Position[], min: number, close: boolean): string =>
    thin(pts, Math.max(min, Math.floor(pts.length * keep)))
      .map((p, i) => `${i === 0 ? "M" : "L"}${x(p)} ${y(p)}`)
      .join("") + (close ? "Z" : "");
  let areas = "", lines = "", dots = "";
  for (const f of features) {
    for (const r of f.shape.rings) areas += path(r, 4, true);
    for (const l of f.shape.lines) lines += path(l, 2, false);
    for (const p of f.shape.points) dots += `<circle cx="${x(p)}" cy="${y(p)}" r="3"/>`;
  }
  const body =
    (areas === "" ? "" : `<path class="gj-area" d="${areas}" fill="currentColor" fill-opacity="0.2" fill-rule="evenodd"/>`) +
    (lines === "" ? "" : `<path class="gj-line" d="${lines}" fill="none"/>`) +
    (dots === "" ? "" : `<g class="gj-points" fill="currentColor" stroke="none">${dots}</g>`);
  return { width: Math.round(width), height: Math.round(height), body };
}

const cell = (v: unknown): string => {
  const s = typeof v === "string" ? v : v === undefined ? "" : (JSON.stringify(v) ?? "");
  return s.length > CELL_CHARS ? `${s.slice(0, CELL_CHARS)}…` : s;
};

/** The properties table as plain text: the header, and a row per feature (first TABLE_ROWS). Shared with the terminal. */
export function propertyRows(features: readonly Feature[]): { header: string[]; rows: string[][] } {
  const rows = features.slice(0, TABLE_ROWS);
  const keys: string[] = [];
  for (const f of rows)
    for (const key of Object.keys(f.props)) if (!keys.includes(key) && keys.length < COLUMN_CAP) keys.push(key);
  return {
    header: ["#", "Geometry", ...keys],
    rows: rows.map((f, i) => [String(i + 1), f.type, ...keys.map((k) => cell(f.props[k]))]),
  };
}

const count = (n: number): string => `${n.toLocaleString("en")} feature${n === 1 ? "" : "s"}`;

export function geojson(input: RenderInput): Rendered {
  const parsed = parseGeoJson(new TextDecoder().decode(input.body));
  if (parsed === undefined) {
    // Not GeoJSON: show it as the JSON document it may still be.
    const as = config({ ...input, path: input.path.replace(/\.geojson$/i, ".json") });
    return { ...as, content: html`<p class="muted small">This file is not valid GeoJSON; shown as JSON.</p>${as.content}` };
  }
  const { features } = parsed;
  const n = features.length;
  const { header, rows } = propertyRows(features);
  const table = html`<div class="gj-table" tabindex="0" role="region" aria-label="Feature properties"><table>
    <caption class="sr-only">Properties of ${count(n)}</caption>
    <thead><tr>${header.map((k) => html`<th scope="col">${k}</th>`)}</tr></thead>
    <tbody>${rows.map((r) => html`<tr>${r.map((v) => html`<td>${v}</td>`)}</tr>`)}</tbody>
  </table></div>`;
  const label = count(n);
  const drawn = n > FEATURE_CAP ? undefined : outline(features);
  const note =
    n > FEATURE_CAP
      ? `This file has more than ${FEATURE_CAP.toLocaleString("en")} features, too many to draw; only their properties are listed.`
      : drawn === undefined
        ? "No feature has a geometry to draw."
        : "";
  const more = n > TABLE_ROWS ? ` Properties of the first ${TABLE_ROWS} are listed.` : "";
  const content = html`<figure class="gj-view">
    ${drawn === undefined ? null : html`<svg viewBox="0 0 ${drawn.width} ${drawn.height}" role="img" aria-label="Outline of ${label}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${raw(drawn.body)}</svg>`}
    <p class="muted small">${label}. ${note}${more}</p>
    ${n === 0 ? null : table}
  </figure>`;
  return { content, lines: 0, summary: `${label} · ${fileSize(input.size)}` };
}
