/**
 * A HAR file (HTTP Archive 1.2, a browser's captured session) as a request
 * waterfall: method, status, URL, size and time per row, and a bar placed
 * on the session's own timeline. The bar is one small inline SVG per row,
 * drawn here (no script, no inline style, so the page's CSP holds). Every
 * URL, status text and header value is untrusted text and is escaped.
 * Fields are read defensively; a file that is not JSON, or has no
 * `log.entries`, falls back to its source with the reason.
 * Spec: http://www.softwareishard.com/blog/har-12-spec/ (entries, timings).
 */

import { escapeHtml, html, raw } from "../html.ts";
import { fileSize } from "../ui.ts";
import type { Rendered, RenderInput } from "./renderers.ts";

/** Rows drawn, whatever the file holds. */
export const ROW_CAP = 500;
/** Header lines drawn per side of a row. */
export const HEADER_CAP = 50;
/** Longest URL or header value shown, in characters. */
const TEXT_CAP = 2000;

export interface HarEntry {
  readonly method: string;
  readonly url: string;
  /** 0 when the request never got a response (HAR 1.2 §response.status). */
  readonly status: number;
  readonly statusText: string;
  /** Body bytes: `content.size`, else `bodySize`; undefined when unknown (-1). */
  readonly bytes: number | undefined;
  /** Milliseconds, the entry's `time`; 0 when unknown. */
  readonly ms: number;
  /** Start in ms since the epoch; NaN when unreadable. */
  readonly start: number;
  readonly requestHeaders: readonly (readonly [string, string])[];
  readonly responseHeaders: readonly (readonly [string, string])[];
}

export type Har = { readonly entries: HarEntry[] } | { readonly error: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v.slice(0, TEXT_CAP) : "");
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function headers(v: unknown): [string, string][] {
  if (!Array.isArray(v)) return [];
  const out: [string, string][] = [];
  for (const h of v) if (isObj(h)) out.push([str(h.name), str(h.value)]);
  return out;
}

/** Parse a HAR's text. Pure; never throws. */
export function parseHar(source: string): Har {
  let doc: unknown;
  try {
    doc = JSON.parse(source.replace(/^﻿/, ""));
  } catch {
    return { error: "it is not valid JSON" };
  }
  const log = isObj(doc) ? doc.log : undefined;
  if (!isObj(log) || !Array.isArray(log.entries)) return { error: "it has no log.entries list" };
  const entries: HarEntry[] = [];
  for (const e of log.entries) {
    if (!isObj(e)) return { error: "an entry is not an object" };
    const req = isObj(e.request) ? e.request : {};
    const res = isObj(e.response) ? e.response : {};
    const content = isObj(res.content) ? res.content : {};
    const size = num(content.size) ?? num(res.bodySize);
    const time = num(e.time);
    entries.push({
      method: str(req.method).toUpperCase().slice(0, 16) || "?",
      url: str(req.url),
      status: Math.trunc(num(res.status) ?? 0),
      statusText: str(res.statusText).slice(0, 100),
      bytes: size === undefined || size < 0 ? undefined : size,
      ms: time === undefined || time < 0 ? 0 : time,
      start: typeof e.startedDateTime === "string" ? Date.parse(e.startedDateTime) : NaN,
      requestHeaders: headers(req.headers),
      responseHeaders: headers(res.headers),
    });
  }
  return { entries };
}

const WIDTH = 200;

/** `1.23 s` or `45 ms`. */
export const duration = (ms: number): string => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`);

/** The bar (decorative: the Time column says the same in words): x and width are the share of the session's span (0..WIDTH). */
function bar(x: number, w: number): string {
  const width = Math.max(1, Math.min(WIDTH - x, w));
  return `<svg class="har-bar" viewBox="0 0 ${WIDTH} 10" preserveAspectRatio="none" aria-hidden="true" focusable="false"><rect x="${x.toFixed(2)}" y="0" width="${width.toFixed(2)}" height="10" fill="currentColor"/></svg>`;
}

const headerList = (title: string, hs: readonly (readonly [string, string])[]): string =>
  hs.length === 0
    ? ""
    : `<p class="muted small">${title}</p><ul class="small">${hs
        .slice(0, HEADER_CAP)
        .map(([n, v]) => `<li><code>${escapeHtml(n)}</code>: ${escapeHtml(v)}</li>`)
        .join("")}</ul>${hs.length > HEADER_CAP ? `<p class="muted small">${hs.length - HEADER_CAP} more headers not shown.</p>` : ""}`;

export function har(input: RenderInput): Rendered {
  const parsed = parseHar(new TextDecoder().decode(input.body));
  if ("error" in parsed) return { content: html``, lines: 0, fallback: `This file is not drawn as a HAR: ${parsed.error}.` };
  if (parsed.entries.length === 0) return { content: html``, lines: 0, fallback: "This HAR holds no requests." };
  const shown = parsed.entries.slice(0, ROW_CAP);
  // The timeline is the shown rows' own: from the earliest start to the latest end.
  const starts = shown.map((e) => e.start).filter(Number.isFinite);
  const t0 = starts.length > 0 ? Math.min(...starts) : 0;
  const span = Math.max(1, ...shown.map((e) => (Number.isFinite(e.start) ? e.start - t0 : 0) + e.ms));
  let rows = "";
  for (const e of shown) {
    const off = Number.isFinite(e.start) ? e.start - t0 : 0;
    const x = (off / span) * WIDTH;
    const status = e.status === 0 ? "—" : String(e.status);
    const detail = headerList("Request headers", e.requestHeaders) + headerList("Response headers", e.responseHeaders);
    const line = detail === ""
      ? escapeHtml(e.url)
      : `<details><summary>${escapeHtml(e.url)}</summary>${detail}</details>`;
    // The bar sits under the URL, so a phone's sideways scroll never hides it.
    const url = line + bar(x, (e.ms / span) * WIDTH);
    rows += `<tr><td>${escapeHtml(e.method)}</td><td>${escapeHtml(status)}${e.statusText ? ` <span class="muted">${escapeHtml(e.statusText)}</span>` : ""}</td><td class="har-url">${url}</td><td>${e.bytes === undefined ? "—" : escapeHtml(fileSize(e.bytes))}</td><td>${escapeHtml(duration(e.ms))}</td></tr>`;
  }
  const left = parsed.entries.length - shown.length;
  const more = left > 0
    ? `<p class="muted small">Showing ${ROW_CAP.toLocaleString()} of ${parsed.entries.length.toLocaleString()} requests, ${left.toLocaleString()} left out. The rest is in the raw file.</p>`
    : "";
  const name = input.path.slice(input.path.lastIndexOf("/") + 1);
  const content = html`<div class="har-view"><table class="table" data-dense aria-label="${name} requests">
    <thead><tr><th scope="col">Method</th><th scope="col">Status</th><th scope="col">URL and waterfall (0 to ${duration(span)})</th><th scope="col">Size</th><th scope="col">Time</th></tr></thead>
    <tbody>${raw(rows)}</tbody>
  </table>${raw(more)}</div>`;
  const n = parsed.entries.length;
  return { content, lines: 0, summary: `${n.toLocaleString()} ${n === 1 ? "request" : "requests"} · ${fileSize(input.size)}` };
}
