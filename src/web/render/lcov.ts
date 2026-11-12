/**
 * An lcov tracefile (`lcov.info`, `*.lcov`; the format `geninfo(1)` documents
 * and `bun test --coverage-reporter=lcov` writes) as a table: total line and
 * function coverage at the top, then one row per `SF:` record with lines
 * (`LH`/`LF`), functions (`FNH`/`FNF`) and branches (`BRH`/`BRF`) hit over
 * found, worst line coverage first, each with a `<meter>` bar (no script).
 * When a record has no `LF`/`LH`, they are counted from its `DA:line,hits`
 * lines. A source path links to that file in the same repository when it is
 * a plain relative path that exists at the ref (`RenderInput.exists`);
 * otherwise it is plain text. At most `RECORD_CAP` records are drawn and the
 * rest counted. One linear pass; a malformed file falls back to the source
 * with the reason. Every string is escaped.
 */

import { escapeHtml, html, raw } from "../html.ts";
import { fileSize } from "../ui.ts";
import type { Rendered, RenderInput } from "./renderers.ts";
import { relativePath } from "./sarif.ts";

export const RECORD_CAP = 5000;

export interface Ratio {
  readonly hit: number;
  readonly found: number;
}
export interface Record_ {
  readonly file: string;
  readonly lines: Ratio;
  readonly functions: Ratio | undefined;
  readonly branches: Ratio | undefined;
}
export type Lcov = { readonly records: Record_[] } | { readonly error: string };

const COUNTERS = new Set(["LF", "LH", "FNF", "FNH", "BRF", "BRH"]);

interface Open {
  file: string;
  n: Record<string, number>;
  daFound: number;
  daHit: number;
  line: number;
}

/** Parse an lcov file's text in one pass. Pure; never throws. */
export function parseLcov(source: string): Lcov {
  const records: Record_[] = [];
  let cur: Open | undefined;
  let lineNo = 0;
  let pos = 0;
  const text = source.replace(/^﻿/, "");
  const close = (o: Open): string | undefined => {
    const n = o.n;
    const ratio = (f: string, h: string, da?: Ratio): Ratio | undefined => {
      if (n[f] === undefined && n[h] === undefined) return da;
      if (n[f] === undefined || n[h] === undefined) return undefined;
      return { hit: n[h]!, found: n[f]! };
    };
    const lines = ratio("LF", "LH", { hit: o.daHit, found: o.daFound });
    const functions = ratio("FNF", "FNH");
    const branches = ratio("BRF", "BRH");
    if ((n.LF === undefined) !== (n.LH === undefined)) return `line ${o.line}: ${o.file} has only one of LF and LH`;
    if ((n.FNF === undefined) !== (n.FNH === undefined)) return `line ${o.line}: ${o.file} has only one of FNF and FNH`;
    if ((n.BRF === undefined) !== (n.BRH === undefined)) return `line ${o.line}: ${o.file} has only one of BRF and BRH`;
    for (const r of [lines, functions, branches])
      if (r !== undefined && r.hit > r.found) return `line ${o.line}: ${o.file} hits more than it finds`;
    records.push({ file: o.file, lines: lines!, functions, branches });
    return undefined;
  };
  while (pos <= text.length) {
    let end = text.indexOf("\n", pos);
    if (end < 0) end = text.length;
    const line = text.slice(pos, end).trim();
    pos = end + 1;
    lineNo++;
    if (line === "") continue;
    const colon = line.indexOf(":");
    const key = colon < 0 ? line : line.slice(0, colon);
    const val = colon < 0 ? "" : line.slice(colon + 1);
    if (key === "SF") {
      if (cur !== undefined) return { error: `line ${lineNo}: a new SF record starts before end_of_record` };
      if (val === "") return { error: `line ${lineNo}: SF has no path` };
      cur = { file: val, n: {}, daFound: 0, daHit: 0, line: lineNo };
    } else if (key === "end_of_record") {
      if (cur === undefined) return { error: `line ${lineNo}: end_of_record with no SF record` };
      const bad = close(cur);
      if (bad !== undefined) return { error: bad };
      cur = undefined;
    } else if (key === "TN") {
      continue;
    } else if (COUNTERS.has(key)) {
      if (cur === undefined) return { error: `line ${lineNo}: ${key} outside an SF record` };
      if (!/^\d{1,12}$/.test(val)) return { error: `line ${lineNo}: ${key} is not a count` };
      cur.n[key] = Number(val);
    } else if (key === "DA") {
      if (cur === undefined) return { error: `line ${lineNo}: DA outside an SF record` };
      const m = /^\d+,(-?\d+)/.exec(val);
      if (m === null) return { error: `line ${lineNo}: DA is not "line,hits"` };
      cur.daFound++;
      if (Number(m[1]) > 0) cur.daHit++;
    }
    // FN, FNDA, BRDA, VER and the like: not needed for the table.
  }
  if (cur !== undefined) return { error: `the record for ${cur.file} has no end_of_record` };
  if (records.length === 0) return { error: "it has no SF records" };
  return { records };
}

const pct = (r: Ratio | undefined): number | undefined => (r === undefined || r.found === 0 ? undefined : (r.hit / r.found) * 100);
/** Records ordered worst line coverage first; a file with no lines last; ties by path. Both doors (page and terminal) draw this order. */
export function worstFirst(records: readonly Record_[]): Record_[] {
  const key = (r: Record_): number => pct(r.lines) ?? 101;
  return [...records].sort((a, b) => key(a) - key(b) || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}
const fmt = (p: number | undefined): string => (p === undefined ? "—" : `${(Math.floor(p * 10) / 10).toFixed(1)}%`);
const sum = (rs: readonly (Ratio | undefined)[]): Ratio | undefined => {
  let any = false;
  let hit = 0;
  let found = 0;
  for (const r of rs) if (r !== undefined) (any = true), (hit += r.hit), (found += r.found);
  return any ? { hit, found } : undefined;
};
const cell = (r: Ratio | undefined): string =>
  r === undefined ? "<td>—</td>" : `<td>${r.hit.toLocaleString()}/${r.found.toLocaleString()} · ${fmt(pct(r))}</td>`;
const bar = (r: Ratio | undefined, label: string): string =>
  r === undefined || r.found === 0 ? "" : `<meter min="0" max="${r.found}" value="${r.hit}" aria-label="${escapeHtml(label)}"></meter>`;
const encodePath = (path: string): string => path.split("/").map(encodeURIComponent).join("/");

export function lcov(input: RenderInput): Rendered {
  const doc = parseLcov(new TextDecoder().decode(input.body));
  if ("error" in doc) return { content: html``, lines: 0, fallback: `This file is not drawn as coverage: ${doc.error}.` };
  const all = doc.records;
  const sorted = worstFirst(all);
  const shown = sorted.slice(0, RECORD_CAP);
  const showBranches = all.some((r) => r.branches !== undefined);

  const name = (file: string): string => {
    const rel = relativePath(file);
    if (input.repo === undefined || input.exists === undefined || rel === undefined || rel !== file || !input.exists(file)) return escapeHtml(file);
    return `<a href="${escapeHtml(`${input.repo.base}/blob/${input.repo.ref}/${encodePath(file)}`)}">${escapeHtml(file)}</a>`;
  };
  let rows = "";
  for (const r of shown)
    rows += `<tr><td>${name(r.file)}</td><td>${bar(r.lines, `${r.file} line coverage`)}</td>${cell(r.lines)}${cell(r.functions)}${showBranches ? cell(r.branches) : ""}</tr>`;
  const out = all.length - shown.length;
  const more =
    out > 0
      ? `<p class="muted small">Showing ${RECORD_CAP.toLocaleString()} of ${all.length.toLocaleString()} files, ${out.toLocaleString()} left out. The rest is in the raw file.</p>`
      : "";
  const lines = sum(all.map((r) => r.lines));
  const fns = sum(all.map((r) => r.functions));
  const branches = sum(all.map((r) => r.branches));
  const top = [`${fmt(pct(lines))} of lines`, `${fmt(pct(fns))} of functions`, ...(branches ? [`${fmt(pct(branches))} of branches`] : [])].join(" · ");
  const head = `<tr><th scope="col">File</th><th scope="col">Lines</th><th scope="col">Lines hit</th><th scope="col">Functions hit</th>${showBranches ? '<th scope="col">Branches hit</th>' : ""}</tr>`;
  const content = html`<div><p>${top}</p><table class="table" data-dense aria-label="Coverage by file, worst first"><thead>${raw(head)}</thead><tbody>${raw(rows)}</tbody></table>${raw(more)}</div>`;
  return { content, lines: 0, summary: `${all.length.toLocaleString()} ${all.length === 1 ? "file" : "files"} · ${fmt(pct(lines))} lines · ${fileSize(input.size)}` };
}
