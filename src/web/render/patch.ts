/**
 * A `.patch` or `.diff` file drawn with the pull page's own diff markup
 * (`renderDiff`). A `git format-patch` mail header (From, Subject, Date)
 * shows above it as plain lines. Text with no `diff --git` file in it is not
 * a diff this parser reads, and falls back to the source view.
 */

import { parseUnifiedDiff } from "../../git/diff.ts";
import { renderDiff } from "../diff-view.ts";
import { html, type Html } from "../html.ts";
import type { Rendered, RenderInput } from "./renderers.ts";

const MAIL_FIELDS = ["From", "Subject", "Date"] as const;
type Field = (typeof MAIL_FIELDS)[number];
/** A header value longer than this is cut: a Subject is one line, not a page. */
export const VALUE_CAP = 500;

const row = (label: Field, value: string): Html =>
  html`<div class="status-row"><dt class="muted">${label}</dt><dd>${value}</dd></div>`;

/** The mail fields before the first file, in the order the file gives them. */
function mailHeader(text: string): [Field, string][] {
  const end = text.search(/^diff --git /m);
  const head = (end < 0 ? text : text.slice(0, end)).split("\n");
  if (!/^From [0-9a-f]{7,64} /.test(head[0] ?? "")) return [];
  const out: [Field, string][] = [];
  for (const line of head) {
    for (const f of MAIL_FIELDS) if (line.startsWith(`${f}: `)) out.push([f, line.slice(f.length + 2).slice(0, VALUE_CAP)]);
    if (line === "" && out.length > 0) break;
  }
  return out;
}

export function patch(input: RenderInput): Rendered {
  const text = new TextDecoder().decode(input.body);
  const diff = parseUnifiedDiff(text);
  if (diff.files.length === 0) {
    return { content: html``, lines: 0, fallback: "This is not a git unified diff, so it is shown as text." };
  }
  const mail = mailHeader(text);
  const header = mail.length === 0 ? null : html`<dl class="status-rows">${mail.map(([f, v]) => row(f, v))}</dl>`;
  return {
    lines: text.split("\n").length,
    content: html`${header}${renderDiff(diff)}`,
  };
}
