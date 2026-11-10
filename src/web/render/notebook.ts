/**
 * A Jupyter notebook as its cells and saved outputs; nothing is run. Markdown
 * cells go through the forge's own Markdown renderer. Everything else is
 * escaped text, except PNG and JPEG outputs, which are `<img>` data URIs
 * only after the base64 is checked. HTML and JavaScript outputs are shown
 * as source and never inserted.
 */

import { html, type Html } from "../html.ts";
import { renderMarkdown } from "../markdown.ts";
import type { Rendered, RenderInput } from "./renderers.ts";

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** nbformat stores text as a string or an array of lines. */
const text = (v: unknown): string =>
  typeof v === "string" ? v : Array.isArray(v) ? v.filter((x) => typeof x === "string").join("") : "";

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const IMAGES = ["image/png", "image/jpeg"] as const;
/** Outputs shown as source, with the plain words that name them. */
const SOURCES = [
  ["text/html", "HTML output, shown as text"],
  ["application/javascript", "Script output, shown as text"],
] as const;
/** The most outputs and cells drawn, so a hostile file cannot make a huge page. */
const MAX_CELLS = 2_000;

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

/** One saved output, as data: the HTML page and the terminal both draw from this. */
export type NbOutput =
  | { readonly kind: "text" | "error" | "caption"; readonly text: string }
  | { readonly kind: "image"; readonly mime: string; readonly data: string };

/** One cell: its source, the count a code cell ran with, and its outputs. */
export interface NbCell {
  readonly kind: "markdown" | "code" | "raw";
  readonly source: string;
  readonly count: string;
  readonly outputs: readonly NbOutput[];
}

function image(mime: string, data: unknown): NbOutput | undefined {
  const b64 = text(data).replace(/\s+/g, "");
  return BASE64.test(b64) ? { kind: "image", mime, data: b64 } : undefined;
}

function outputs(out: unknown): NbOutput[] {
  if (!isObj(out)) return [];
  if (out.output_type === "stream") return [{ kind: "text", text: text(out.text) }];
  if (out.output_type === "error") {
    const trace = Array.isArray(out.traceback) ? text(out.traceback) : `${text(out.ename)}: ${text(out.evalue)}`;
    return [{ kind: "error", text: stripAnsi(trace) }];
  }
  const data = isObj(out.data) ? out.data : {};
  const parts: NbOutput[] = [];
  for (const mime of IMAGES) {
    if (data[mime] === undefined) continue;
    const img = image(mime, data[mime]);
    if (img !== undefined) parts.push(img);
  }
  if (data["text/plain"] !== undefined) parts.push({ kind: "text", text: text(data["text/plain"]) });
  for (const [mime, label] of SOURCES)
    if (data[mime] !== undefined) parts.push({ kind: "caption", text: label }, { kind: "text", text: text(data[mime]) });
  return parts;
}

function parseCell(c: unknown): NbCell | undefined {
  if (!isObj(c)) return undefined;
  const source = text(c.source);
  if (c.cell_type === "markdown") return { kind: "markdown", source, count: "", outputs: [] };
  if (c.cell_type === "code") {
    const count = typeof c.execution_count === "number" && Number.isFinite(c.execution_count) ? String(c.execution_count) : " ";
    const outs = Array.isArray(c.outputs) ? c.outputs.slice(0, MAX_CELLS).flatMap(outputs) : [];
    return { kind: "code", source, count, outputs: outs };
  }
  return { kind: "raw", source, count: "", outputs: [] };
}

/** The notebook's cells (at most MAX_CELLS) and how many it has, or why it cannot be read. */
export function parseNotebook(body: Uint8Array | string): { cells: NbCell[]; total: number } | { error: string } {
  let doc: unknown;
  try {
    doc = JSON.parse(typeof body === "string" ? body : new TextDecoder().decode(body));
  } catch {
    return { error: "This notebook is not valid JSON, so it is shown as plain text." };
  }
  if (!isObj(doc) || !Array.isArray(doc.cells))
    return { error: "This notebook has no cells list, so it is shown as plain text." };
  const cells = doc.cells.slice(0, MAX_CELLS).flatMap((c) => parseCell(c) ?? []);
  return { cells, total: doc.cells.length };
}

function outputHtml(o: NbOutput): Html {
  if (o.kind === "image")
    return html`<img class="nb-img" alt="Notebook output" src="data:${o.mime};base64,${o.data}" />`;
  if (o.kind === "caption") return html`<div class="nb-cap">${o.text}</div>`;
  return html`<pre class="${o.kind === "error" ? "nb-out nb-err" : "nb-out"}">${o.text}</pre>`;
}

function cellHtml(c: NbCell): Html {
  if (c.kind === "markdown") return html`<div class="nb-cell">${renderMarkdown(c.source)}</div>`;
  if (c.kind === "code")
    return html`<div class="nb-cell"><pre class="nb-in"><span class="muted">In [${c.count}]:</span> ${c.source}</pre>${c.outputs.map(outputHtml)}</div>`;
  return html`<div class="nb-cell"><pre>${c.source}</pre></div>`;
}

export function notebook(input: RenderInput): Rendered {
  const parsed = parseNotebook(input.body);
  if ("error" in parsed) return { content: html``, lines: 0, fallback: parsed.error };
  return {
    lines: 0,
    summary: `${parsed.total} cells`,
    content: html`<div class="nb prose">${parsed.cells.map(cellHtml)}</div>`,
  };
}
