/**
 * A `.env.example`, `.env.sample` or `.env.template` as the variables an app
 * needs: name, example value and the comment written above it, one row each.
 * A comment block followed by a blank line is a group heading; one directly
 * above a variable is that variable's comment (an inline ` # note` joins it).
 * A value whose name looks secret is shown as `•••`, even in an example file.
 * A plain `.env` is never this kind (`isEnvExample` in `kinds.ts`, matched by exact name).
 * Every cell is escaped by the template; at most `ROW_CAP` variables are drawn.
 */

import { html, type Html } from "../html.ts";
import { fileSize } from "../ui.ts";
import type { Rendered, RenderInput } from "./renderers.ts";

export const ROW_CAP = 500;
export const MASK = "•••";

export interface EnvRow {
  readonly name: string;
  /** The example value as written (quotes removed); `•••` when the name looks secret. */
  readonly value: string;
  readonly comment: string;
  /** The heading of the group this variable sits under; empty before any. */
  readonly group: string;
}

export interface EnvDoc {
  readonly rows: readonly EnvRow[];
  /** Variables in the file, drawn or not. */
  readonly total: number;
}

/** `*_KEY`, `*_SECRET`, `*_TOKEN`, `*PASSWORD*` (and the bare words). */
export const looksSecret = (name: string): boolean => /(^|_)(KEY|SECRET|TOKEN)$|PASSWORD/i.test(name);

const ENTRY = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=(.*)$/;

/** The value and any inline comment of what follows `=`. */
function value(rest: string): { value: string; comment: string } {
  const s = rest.trimStart();
  const q = s[0];
  if (q === '"' || q === "'") {
    let out = "";
    for (let i = 1; i < s.length; i++) {
      const ch = s[i]!;
      if (q === '"' && ch === "\\" && i + 1 < s.length) {
        const n = s[++i]!;
        out += n === "n" ? "\n" : n;
      } else if (ch === q) {
        const tail = s.slice(i + 1).trim();
        return { value: out, comment: tail.startsWith("#") ? tail.slice(1).trim() : "" };
      } else out += ch;
    }
    return { value: out, comment: "" }; // unterminated: the line's rest
  }
  const hash = s.search(/(^|\s)#/);
  if (hash === -1) return { value: s.trim(), comment: "" };
  return { value: s.slice(0, hash).trim(), comment: s.slice(s.indexOf("#", hash) + 1).trim() };
}

/** `# ---- Database ----` is `Database`. */
const commentText = (line: string): string =>
  line.trim().replace(/^#+\s?/, "").replace(/\s*[-=*#_~]{2,}\s*$/, "").replace(/^[-=*#_~]{2,}\s*/, "").trim();

/** Read a dotenv example. Pure; never throws; reads at most `ROW_CAP` rows but counts all. */
export function parseEnv(source: string): EnvDoc {
  const rows: EnvRow[] = [];
  let total = 0;
  let group = "";
  let pending: string[] = [];
  for (const raw of source.replace(/^﻿/, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "") {
      // A comment block set off by a blank line names the group that follows.
      const heading = pending.filter((p) => p !== "").join(" ");
      if (heading !== "") group = heading;
      pending = [];
    } else if (line.startsWith("#")) pending.push(commentText(line));
    else {
      const m = ENTRY.exec(raw);
      if (m !== null) {
        total++;
        if (rows.length < ROW_CAP) {
          const v = value(m[2]!);
          const comment = [...pending.filter((p) => p !== ""), v.comment].filter((p) => p !== "").join(" ");
          rows.push({
            name: m[1]!,
            value: v.value !== "" && looksSecret(m[1]!) ? MASK : v.value,
            comment,
            group,
          });
        }
      }
      pending = [];
    }
  }
  return { rows, total };
}

const cell = (v: string): string => (v === "" ? "—" : v);

export function envView(input: RenderInput): Rendered {
  const doc = parseEnv(new TextDecoder().decode(input.body));
  if (doc.total === 0) return { content: html``, lines: 0, fallback: "This file holds no variables to draw." };
  let last: string | undefined;
  const body: Html[] = [];
  for (const r of doc.rows) {
    if (r.group !== "" && r.group !== last) body.push(html`<tr><th scope="rowgroup" colspan="3">${r.group}</th></tr>`);
    last = r.group;
    body.push(html`<tr><th scope="row"><code>${r.name}</code></th><td>${cell(r.value)}</td><td>${cell(r.comment)}</td></tr>`);
  }
  const more = doc.total - doc.rows.length;
  const foot = more > 0 ? html`<p class="muted small">${more.toLocaleString()} more not shown</p>` : html``;
  const name = input.path.slice(input.path.lastIndexOf("/") + 1);
  const content = html`<div class="env-view"><table class="table" data-dense aria-label="${name} variables"><thead><tr><th scope="col">Name</th><th scope="col">Example</th><th scope="col">Comment</th></tr></thead><tbody>${body}</tbody></table>${foot}</div>`;
  const n = doc.total;
  return { content, lines: 0, summary: `${n.toLocaleString()} ${n === 1 ? "variable" : "variables"} · ${fileSize(input.size)}` };
}
