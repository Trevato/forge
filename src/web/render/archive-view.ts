/**
 * A .zip, .tar or .tar.gz as a table of what is inside: path, size and
 * modified date, drawn on the server from `listArchive`. Nothing is unpacked.
 */

import { escapeHtml, html, raw } from "../html.ts";
import { fileSize } from "../ui.ts";
import { count, ENTRY_CAP, listArchive, type Entry } from "./archive.ts";
import type { Rendered, RenderInput } from "./renderers.ts";

/** `2026-11-09 12:30`, UTC, as the archive stores it. */
const when = (d: Date | null): string => (d === null ? "" : d.toISOString().slice(0, 16).replace("T", " "));

/** Control and bidi-override characters would hide or reorder a name. */
const printable = (s: string): string =>
  s.replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, "�");

/** The folder part muted, the name plain; both escaped. */
function name(e: Entry): string {
  const path = printable(e.path);
  const trimmed = e.dir ? path.slice(0, -1) : path;
  const cut = trimmed.lastIndexOf("/") + 1;
  const tail = escapeHtml(trimmed.slice(cut)) + (e.dir ? "/" : "");
  return `<span class="muted">${escapeHtml(trimmed.slice(0, cut))}</span>${tail}`;
}

const FORMAT = { zip: "ZIP", tar: "tar", "tar.gz": "tar.gz" } as const;

export function archive(input: RenderInput): Rendered {
  const listed = listArchive(input.body);
  if ("error" in listed) return { content: html``, lines: 0, fallback: listed.error };
  let rows = "";
  for (const e of listed.entries)
    rows += `<tr><td>${name(e)}</td><td class="num">${e.dir ? "" : fileSize(e.size)}</td><td class="num">${when(e.mtime)}</td></tr>`;
  const left = listed.count - listed.entries.length;
  const more =
    left > 0
      ? ` ${count(left)} more ${left === 1 ? "entry is" : "entries are"} not listed (the page shows the first ${count(ENTRY_CAP)}).`
      : "";
  const label = input.path.slice(input.path.lastIndexOf("/") + 1);
  return {
    lines: 0,
    summary: `${fileSize(input.size)} · ${FORMAT[listed.format]}`,
    content: html`<table class="table archive-view" data-dense aria-label="${label} contents">
        <thead><tr><th>Path</th><th class="num">Size</th><th class="num">Modified</th></tr></thead>
        <tbody>${raw(rows)}</tbody>
        <tfoot><tr><td colspan="3" class="muted small">${count(listed.count)} ${listed.count === 1 ? "entry" : "entries"} · ${fileSize(listed.bytes)} unpacked.${more}</td></tr></tfoot>
      </table>`,
  };
}
