/**
 * /flow's clog rows (#11454), read by `flow/clog_view.ts`: the sentence as plain text, a test failing on
 * three or more open pulls as one row, and pairs of open pulls on the same files as rows. No box: they sit
 * on the page under its intro. Quiet draws nothing.
 */

import type { ClogView } from "../../flow/clog_view.ts";
import { html, type Html } from "../html.ts";
import { icon, row } from "../ui.ts";

export { readClogView } from "../../flow/clog_view.ts";

type Ref = { repo: string; number: number };
const pullLink = (r: Ref) => html`<a href="/${r.repo}/pulls/${String(r.number)}">${r.repo} #${String(r.number)}</a>`;

export function clogSection(v: ClogView): Html {
  if (v.says === "" && v.shared.length === 0 && v.pairs.length === 0) return html``;
  return html`<div class="mb" id="flow-clog">${v.says === "" ? "" : html`<p id="clog-says">${v.says}</p>`}
    ${v.shared.length === 0 ? "" : html`<ul class="list" id="flow-shared-red">${v.shared.map((s) => row({
      lead: icon("alert"),
      title: html`<code>${s.test}</code> <span class="muted small">fails on ${String(s.pulls.length)} open pulls</span>`,
      meta: html`<span class="small">${s.pulls.map((p, i) => html`${i === 0 ? "" : ", "}${pullLink(p)}`)}</span>`,
    }))}</ul>`}
    ${v.pairs.length === 0 ? "" : html`<ul class="list" id="flow-conflict-pairs">${v.pairs.map((c) => row({
      lead: icon("branch"),
      title: html`${pullLink(c.a)} and ${pullLink(c.b)} <span class="muted small">${String(c.shared)} shared ${c.shared === 1 ? "file" : "files"}</span>`,
    }))}</ul>`}</div>`;
}
