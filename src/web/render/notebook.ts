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

function image(mime: string, data: unknown): Html | undefined {
  const b64 = text(data).replace(/\s+/g, "");
  if (!BASE64.test(b64)) return undefined;
  return html`<img class="nb-img" alt="Notebook output" src="data:${mime};base64,${b64}" />`;
}

function output(out: unknown): Html {
  if (!isObj(out)) return html``;
  if (out.output_type === "stream")
    return html`<pre class="nb-out">${text(out.text)}</pre>`;
  if (out.output_type === "error") {
    const trace = Array.isArray(out.traceback) ? text(out.traceback) : `${text(out.ename)}: ${text(out.evalue)}`;
    return html`<pre class="nb-out nb-err">${stripAnsi(trace)}</pre>`;
  }
  const data = isObj(out.data) ? out.data : {};
  const parts: Html[] = [];
  for (const mime of IMAGES) {
    if (data[mime] === undefined) continue;
    const img = image(mime, data[mime]);
    if (img !== undefined) parts.push(img);
  }
  if (data["text/plain"] !== undefined) parts.push(html`<pre class="nb-out">${text(data["text/plain"])}</pre>`);
  for (const [mime, label] of SOURCES)
    if (data[mime] !== undefined)
      parts.push(html`<div class="nb-cap">${label}</div><pre class="nb-out">${text(data[mime])}</pre>`);
  return html`${parts}`;
}

function cell(c: unknown): Html {
  if (!isObj(c)) return html``;
  const source = text(c.source);
  if (c.cell_type === "markdown") return html`<div class="nb-cell">${renderMarkdown(source)}</div>`;
  if (c.cell_type === "code") {
    const n = typeof c.execution_count === "number" && Number.isFinite(c.execution_count) ? String(c.execution_count) : " ";
    const outs = Array.isArray(c.outputs) ? c.outputs.slice(0, MAX_CELLS).map(output) : [];
    return html`<div class="nb-cell"><pre class="nb-in"><span class="muted">In [${n}]:</span> ${source}</pre>${outs}</div>`;
  }
  return html`<div class="nb-cell"><pre>${source}</pre></div>`;
}

export function notebook(input: RenderInput): Rendered {
  const fail = (why: string): Rendered => ({ content: html``, lines: 0, fallback: why });
  let doc: unknown;
  try {
    doc = JSON.parse(new TextDecoder().decode(input.body));
  } catch {
    return fail("This notebook is not valid JSON, so it is shown as plain text.");
  }
  if (!isObj(doc) || !Array.isArray(doc.cells))
    return fail("This notebook has no cells list, so it is shown as plain text.");
  const cells = doc.cells.slice(0, MAX_CELLS);
  return {
    lines: 0,
    summary: `${doc.cells.length} cells`,
    content: html`<div class="nb prose">${cells.map(cell)}</div>`,
  };
}
