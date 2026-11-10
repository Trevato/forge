/**
 * An OpenAPI document (`openapi.json|yaml|yml`, `*.openapi.json|yaml|yml`) as
 * the API it describes: one table per tag, one row per operation with its
 * method, path, summary and deprecated mark. Untagged operations go last; an
 * operation with several tags is listed under its first.
 *
 * A document is OpenAPI when its top-level `openapi` starts with `3.` or its
 * `swagger` is `2.0`. A file under one of these names that parses as
 * something else is drawn by the config renderer as before; a file that
 * declares itself OpenAPI but does not parse, or has no usable `paths`, falls
 * back to the source with the reason. The file is
 * parsed once (JSON natively, YAML by the parser `yaml-config.ts` uses) and
 * cut at `OPERATION_CAP` operations before anything is drawn. Every string
 * is escaped and cut to `TEXT_CAP` characters.
 */

import { escapeHtml, html, raw } from "../html.ts";
import { fileSize } from "../ui.ts";
import { plainOf } from "./config-diff.ts";
import { config } from "./config.ts";
import type { Rendered, RenderInput } from "./renderers.ts";
import { parseYaml } from "./yaml-config.ts";

export const OPERATION_CAP = 500;
const TEXT_CAP = 300;
const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;

export interface Operation {
  readonly method: string;
  readonly path: string;
  readonly summary: string;
  readonly deprecated: boolean;
}
export interface Group {
  /** Empty for the operations with no tag. */
  readonly tag: string;
  readonly ops: Operation[];
}
export type OpenApi =
  | { readonly groups: Group[]; readonly shown: number; readonly more: number }
  | { readonly error: string };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, TEXT_CAP) : "");

/** A top-level `openapi` or `swagger` key, quoted or not: the file says it is an API description. */
const CLAIMS = /^\s*\{?\s*["']?(openapi|swagger)["']?\s*:/m;

/** The parsed value of the file, or undefined when it does not parse. */
function load(source: string, path: string): unknown {
  const body = source.replace(/^﻿/, "");
  if (/\.json$/i.test(path)) {
    try {
      return JSON.parse(body);
    } catch {
      return undefined;
    }
  }
  const y = parseYaml(body);
  return y.ok ? plainOf(y.value) : undefined;
}

/** Whether a parsed value is an OpenAPI 3.x or Swagger 2.0 document. */
const isSpec = (doc: unknown): doc is Obj =>
  isObj(doc) && ((typeof doc.openapi === "string" && doc.openapi.startsWith("3.")) || doc.swagger === "2.0");

/** `"not"` when the file is not an OpenAPI document at all; otherwise its operations, capped. */
export function parseOpenApi(source: string, path: string): OpenApi | "not" {
  const doc = load(source, path);
  if (doc === undefined) return CLAIMS.test(source) ? { error: "it does not parse" } : "not";
  if (!isSpec(doc)) return "not";
  if (!isObj(doc.paths)) return { error: "it has no paths object" };
  const order: string[] = [];
  if (Array.isArray(doc.tags)) for (const t of doc.tags) if (isObj(t) && text(t.name) !== "") order.push(text(t.name));
  const byTag = new Map<string, Operation[]>();
  let total = 0;
  let shown = 0;
  for (const [route, item] of Object.entries(doc.paths)) {
    if (!isObj(item)) continue;
    for (const method of METHODS) {
      const op = item[method];
      if (!isObj(op)) continue;
      total++;
      if (shown >= OPERATION_CAP) continue;
      shown++;
      const tag = Array.isArray(op.tags) ? text(op.tags[0]) : "";
      const list = byTag.get(tag) ?? [];
      list.push({ method: method.toUpperCase(), path: route.slice(0, TEXT_CAP), summary: text(op.summary), deprecated: op.deprecated === true });
      byTag.set(tag, list);
    }
  }
  if (total === 0) return { error: "it describes no operations" };
  const names = [...order.filter((t) => byTag.has(t)), ...[...byTag.keys()].filter((t) => t !== "" && !order.includes(t))];
  if (byTag.has("")) names.push("");
  return { groups: names.map((tag) => ({ tag, ops: byTag.get(tag)! })), shown, more: total - shown };
}

export const moreLine = (n: number): string => `${n.toLocaleString()} more operation${n === 1 ? "" : "s"} not shown`;

export function openapi(input: RenderInput): Rendered {
  const doc = parseOpenApi(new TextDecoder().decode(input.body), input.path);
  if (doc === "not") return config(input);
  if ("error" in doc) return { content: html``, lines: 0, fallback: `This file is not drawn as an API: ${doc.error}.` };
  let out = "";
  for (const g of doc.groups) {
    const label = g.tag === "" ? "Untagged" : g.tag;
    let rows = "";
    for (const o of g.ops)
      rows += `<tr><td><code>${escapeHtml(o.method)}</code></td><td><code>${escapeHtml(o.path)}</code></td><td>${escapeHtml(o.summary)}${o.deprecated ? ` <span class="muted">deprecated</span>` : ""}</td></tr>`;
    out += `<h3>${escapeHtml(label)}</h3><table class="table" data-dense aria-label="${escapeHtml(label)} operations"><thead><tr><th scope="col">Method</th><th scope="col">Path</th><th scope="col">Summary</th></tr></thead><tbody>${rows}</tbody></table>`;
  }
  if (doc.more > 0) out += `<p class="muted small">${moreLine(doc.more)}</p>`;
  const n = doc.shown + doc.more;
  const lead = `The API this file describes: ${n.toLocaleString()} ${n === 1 ? "operation" : "operations"} by tag.`;
  return {
    content: html`<div class="openapi-view"><p>${lead}</p>${raw(out)}</div>`,
    lines: 0,
    summary: `${n.toLocaleString()} ${n === 1 ? "operation" : "operations"} · ${fileSize(input.size)}`,
  };
}
