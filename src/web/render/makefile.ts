/**
 * A `Makefile`, `GNUmakefile` or `*.mk` as what it declares: variables in one
 * block on top, then one row per target with its prerequisites and recipe
 * (mono), `.PHONY` targets marked. Comments stay in place as notes. A line
 * the parser does not understand (`include`, `ifeq`, a `define` block,
 * a recipe with no target) stays as source text where it was; nothing is
 * dropped except blank lines and `.PHONY` lines (the badges say it). A backslash at the end of a line joins the next.
 * Every cell is escaped by the template; at most `ROW_CAP` items are drawn.
 */

import { html, type Html } from "../html.ts";
import { fileSize } from "../ui.ts";
import type { Rendered, RenderInput } from "./renderers.ts";

export const ROW_CAP = 500;

export interface MakeVariable {
  readonly name: string;
  readonly op: string;
  readonly value: string;
}
export interface MakeTarget {
  readonly names: string;
  /** `::` rules and `:` rules alike; the prerequisites before any `|`. */
  readonly prereqs: readonly string[];
  readonly orderOnly: readonly string[];
  /** One entry per recipe line, continuation lines kept inside it. */
  readonly recipe: readonly string[];
  readonly phony: boolean;
}
export type MakeItem =
  | { readonly kind: "variable"; readonly variable: MakeVariable }
  | { readonly kind: "target"; readonly target: MakeTarget }
  | { readonly kind: "comment"; readonly text: string }
  | { readonly kind: "source"; readonly text: string };

export interface MakeDoc {
  readonly items: readonly MakeItem[];
  readonly targets: number;
  readonly variables: number;
}

const VARIABLE = /^(?:(?:export|override|private)\s+)*([A-Za-z0-9_.@%<^+?*$(){}-]+?)\s*(:::=|::=|:=|\?=|\+=|!=|=)\s*(.*)$/;
const DIRECTIVE = /^(?:-?include|sinclude|ifn?eq|ifn?def|else|endif|define|endef|undefine|vpath|export|unexport|override)\b/;

/** Physical lines joined where a line ends in an odd number of backslashes. */
function logicalLines(source: string): string[] {
  const out: string[] = [];
  let cur: string | undefined;
  for (const raw of source.replace(/^﻿/, "").split(/\r?\n/)) {
    cur = cur === undefined ? raw : `${cur}\n${raw}`;
    const slashes = /\\*$/.exec(raw)![0].length;
    if (slashes % 2 === 0 || raw.startsWith("#") && cur === raw) {
      out.push(cur);
      cur = undefined;
    }
  }
  if (cur !== undefined) out.push(cur);
  return out;
}

const words = (s: string): string[] => s.split(/\s+/).filter((w) => w !== "");
const flat = (s: string): string => s.replace(/\\\n\s*/g, " ");

/** Read a makefile. Pure; never throws. */
export function parseMakefile(source: string): MakeDoc {
  const items: MakeItem[] = [];
  const phony = new Set<string>();
  const recipes: string[][] = [];
  let current: string[] | undefined;
  let inDefine = false;
  let targets = 0;
  let variables = 0;
  const pending: { index: number; names: string; prereqs: string[]; orderOnly: string[]; recipe: string[] }[] = [];

  for (const line of logicalLines(source)) {
    if (line.trim() === "") continue;
    if (inDefine) {
      items.push({ kind: "source", text: line });
      if (/^\s*endef\b/.test(line)) inDefine = false;
      continue;
    }
    if (line.startsWith("\t")) {
      if (current !== undefined) current.push(line.slice(1));
      else items.push({ kind: "source", text: line });
      continue;
    }
    current = undefined;
    const text = flat(line).trim();
    if (text.startsWith("#")) {
      items.push({ kind: "comment", text: text.replace(/^#+\s?/, "") });
      continue;
    }
    if (/^define\b/.test(text)) {
      inDefine = true;
      items.push({ kind: "source", text: line });
      continue;
    }
    if (DIRECTIVE.test(text) && !/^(?:export|override)\s+[\w.-]+\s*(?:[:?+!]?=)/.test(text)) {
      items.push({ kind: "source", text: line });
      continue;
    }
    const v = VARIABLE.exec(text);
    if (v !== null) {
      variables++;
      items.push({ kind: "variable", variable: { name: v[1]!, op: v[2]!, value: v[3]! } });
      continue;
    }
    const colon = text.search(/::?(?!=)/);
    if (colon > 0) {
      const names = text.slice(0, colon).trim();
      let rest = text.slice(colon).replace(/^::?/, "");
      let inline: string | undefined;
      const semi = rest.indexOf(";");
      if (semi !== -1) {
        inline = rest.slice(semi + 1).trim();
        rest = rest.slice(0, semi);
      }
      rest = rest.replace(/(^|\s)#.*$/, "");
      // A target-specific variable (`all: CC=gcc`) is not a rule: keep it as written.
      if (names !== "" && !rest.includes("=")) {
        const [pre = "", order = ""] = rest.split("|", 2).concat(rest.includes("|") ? [] : [""]);
        const prereqs = words(pre);
        const orderOnly = words(order);
        if (names === ".PHONY") {
          for (const w of prereqs) phony.add(w);
          continue; // read into the badges; the line is not repeated as a row
        }
        const recipe: string[] = inline !== undefined && inline !== "" ? [inline] : [];
        targets++;
        pending.push({ index: items.length, names, prereqs, orderOnly, recipe });
        items.push({ kind: "source", text: "" }); // replaced below, once `.PHONY` is known
        recipes.push(recipe);
        current = recipe;
        continue;
      }
    }
    items.push({ kind: "source", text: line });
  }
  for (const p of pending)
    items[p.index] = {
      kind: "target",
      target: {
        names: p.names,
        prereqs: p.prereqs,
        orderOnly: p.orderOnly,
        recipe: p.recipe,
        phony: words(p.names).some((n) => phony.has(n)),
      },
    };
  return { items, targets, variables };
}

const list = (words: readonly string[]): Html =>
  words.length === 0 ? html`—` : html`${words.map((w) => html`<code>${w}</code> `)}`;

function targetRow(t: MakeTarget): Html {
  const mark = t.phony ? html` <span class="badge">phony</span>` : html``;
  const order = t.orderOnly.length > 0 ? html`<div class="muted small">order-only: ${list(t.orderOnly)}</div>` : html``;
  const recipe = t.recipe.length === 0 ? html`—` : html`<pre><code>${t.recipe.join("\n")}</code></pre>`;
  return html`<tr><th scope="row"><code>${t.names}</code>${mark}</th><td>${list(t.prereqs)}${order}</td><td>${recipe}</td></tr>`;
}

export function makefile(input: RenderInput): Rendered {
  const doc = parseMakefile(new TextDecoder().decode(input.body));
  if (doc.items.length === 0) return { content: html``, lines: 0, fallback: "This file holds nothing to draw." };
  const shown = doc.items.slice(0, ROW_CAP);
  const vars = shown.flatMap((i) => (i.kind === "variable" ? [i.variable] : []));
  const rows: Html[] = [];
  for (const i of shown) {
    if (i.kind === "target") rows.push(targetRow(i.target));
    else if (i.kind === "comment") rows.push(html`<tr><td colspan="3" class="muted small">${i.text}</td></tr>`);
    else if (i.kind === "source") rows.push(html`<tr><td colspan="3"><pre><code>${i.text}</code></pre></td></tr>`);
  }
  const varBlock =
    vars.length === 0
      ? html``
      : html`<div class="table-scroll" role="region" tabindex="0" aria-label="Variables"><table class="table" data-dense aria-label="Variables"><thead><tr><th scope="col">Variable</th><th scope="col">Value</th></tr></thead><tbody>${vars.map((v) => html`<tr><th scope="row"><code>${v.name}</code> <span class="muted small">${v.op}</span></th><td><code>${v.value}</code></td></tr>`)}</tbody></table></div>`;
  const ruleBlock =
    rows.length === 0
      ? html``
      : html`<div class="table-scroll" role="region" tabindex="0" aria-label="Targets"><table class="table" data-dense aria-label="Targets"><thead><tr><th scope="col">Target</th><th scope="col">Prerequisites</th><th scope="col">Recipe</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  const more = doc.items.length - shown.length;
  const foot = more > 0 ? html`<p class="muted small">${more.toLocaleString()} more not shown</p>` : html``;
  const content = html`<div>${varBlock}${ruleBlock}${foot}</div>`;
  const t = doc.targets;
  return { content, lines: 0, summary: `${t.toLocaleString()} ${t === 1 ? "target" : "targets"} · ${doc.variables.toLocaleString()} ${doc.variables === 1 ? "variable" : "variables"} · ${fileSize(input.size)}` };
}
