/**
 * The diff viewer: a structured Diff (from git/diff.ts) rendered as HTML.
 * Unified view, mobile-first — nobody has made side-by-side work on a phone,
 * so we don't try. Big files collapse (native <details>, no JS) and windowing
 * is pure CSS (content-visibility). Changed words inside a modified line are
 * underlined on top of the add/delete background — a second visual layer so
 * identifying a change never depends on color alone.
 *
 * Syntax highlighting is a separate layer, wired in when the tokenizer lands;
 * until then lines render as escaped plain text, which degrades cleanly.
 */

import type { Diff, DiffLine, FileDiff, Hunk } from "../git/diff.ts";
import { escapeHtml, html, raw, when, type Html } from "./html.ts";
import { wordDiff, type Segment } from "./worddiff.ts";

// Above this many changed lines a single file is not rendered inline — it is
// a scroll-and-memory hazard and almost never read line by line.
const MAX_FILE_LINES = 5000;

const GENERATED =
  /(^|\/)(package-lock\.json|bun\.lock|yarn\.lock|pnpm-lock\.yaml|go\.sum|Cargo\.lock)$/;

function statusLabel(status: FileDiff["status"]): string {
  switch (status) {
    case "added":
      return "added";
    case "deleted":
      return "deleted";
    case "renamed":
      return "renamed";
    case "copied":
      return "copied";
    default:
      return "";
  }
}

function fileAnchor(file: FileDiff): string {
  // Stable per-path id for deep-linking; not security-sensitive.
  return "d-" + escapeHtml(file.path).replace(/[^a-zA-Z0-9]+/g, "-");
}

function segments(parts: Segment[]): Html {
  return html`${parts.map((s) =>
    s.changed ? html`<span class="wd">${s.text}</span>` : html`${s.text}`,
  )}`;
}

interface Row {
  kind: DiffLine["kind"];
  oldNumber: number | null;
  newNumber: number | null;
  content: Html;
  noNewline: boolean;
}

/** Turn a hunk's raw lines into rows, pairing del/add runs for word-diff. */
function rowsForHunk(hunk: Hunk): Row[] {
  const rows: Row[] = [];
  const lines = hunk.lines;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.kind === "context") {
      rows.push(plainRow(line));
      i++;
      continue;
    }
    // Collect a run of deletions then a run of additions.
    const dels: DiffLine[] = [];
    while (i < lines.length && lines[i]!.kind === "del") dels.push(lines[i++]!);
    const adds: DiffLine[] = [];
    while (i < lines.length && lines[i]!.kind === "add") adds.push(lines[i++]!);

    const pairs = Math.min(dels.length, adds.length);
    for (let k = 0; k < dels.length; k++) {
      const del = dels[k]!;
      const paired =
        k < pairs ? wordDiff(del.content, adds[k]!.content) : undefined;
      rows.push({
        kind: "del",
        oldNumber: del.oldNumber,
        newNumber: null,
        content: paired ? segments(paired.old) : html`${del.content}`,
        noNewline: del.noNewline,
      });
    }
    for (let k = 0; k < adds.length; k++) {
      const add = adds[k]!;
      const paired =
        k < pairs ? wordDiff(dels[k]!.content, add.content) : undefined;
      rows.push({
        kind: "add",
        oldNumber: null,
        newNumber: add.newNumber,
        content: paired ? segments(paired.new) : html`${add.content}`,
        noNewline: add.noNewline,
      });
    }
  }
  return rows;
}

function plainRow(line: DiffLine): Row {
  return {
    kind: line.kind,
    oldNumber: line.oldNumber,
    newNumber: line.newNumber,
    content: html`${line.content}`,
    noNewline: line.noNewline,
  };
}

function renderRow(row: Row): Html {
  const mark = row.kind === "add" ? "+" : row.kind === "del" ? "-" : " ";
  return html`<tr class="dl" data-k="${row.kind}">
    <td class="dn">${row.oldNumber ?? ""}</td>
    <td class="dn">${row.newNumber ?? ""}</td>
    <td class="dc" data-mark="${mark}">
      <span class="dcx">${row.content}</span>${when(
        row.noNewline,
        () =>
          html`<span class="nonl" title="No newline at end of file">↵</span>`,
      )}
    </td>
  </tr>`;
}

function hunkHeader(hunk: Hunk): Html {
  const at = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
  return html`<tr class="dh">
    <td class="dn"></td>
    <td class="dn"></td>
    <td class="dc">
      <span class="mono muted">${at}</span>${when(
        hunk.section !== "",
        () => html` <span class="muted">${hunk.section}</span>`,
      )}
    </td>
  </tr>`;
}

function fileBody(file: FileDiff): Html {
  if (file.binary) {
    return html`<div class="diff-note">Binary file not shown.</div>`;
  }
  const changed = file.additions + file.deletions;
  if (changed > MAX_FILE_LINES) {
    return html`<div class="diff-note">
      Large diff not shown — ${file.additions.toLocaleString()} additions,
      ${file.deletions.toLocaleString()} deletions.
    </div>`;
  }
  if (file.hunks.length === 0) {
    return html`<div class="diff-note">No content changes.</div>`;
  }
  return html`<table class="diff-table">
    <tbody>
      ${file.hunks.map(
        (hunk) => html`${hunkHeader(hunk)}${rowsForHunk(hunk).map(renderRow)}`,
      )}
    </tbody>
  </table>`;
}

function fileHeader(file: FileDiff): Html {
  const label = statusLabel(file.status);
  const name =
    file.status === "renamed" && file.oldPath && file.newPath
      ? html`<span class="muted">${file.oldPath}</span> → ${file.newPath}`
      : html`${file.path}`;
  return html`<summary class="diff-head">
    <span class="diff-path mono">${name}</span>
    ${when(label !== "", () => html`<span class="badge">${label}</span>`)}
    <span class="spacer"></span>
    <span class="diff-stat"
      >${when(
        file.additions > 0,
        () => html`<span class="add">+${file.additions}</span>`,
      )}
      ${when(
        file.deletions > 0,
        () => html`<span class="del">−${file.deletions}</span>`,
      )}</span
    >
  </summary>`;
}

function fileView(file: FileDiff): Html {
  // Generated/lockfiles start collapsed; everything else is open.
  const collapsed = GENERATED.test(file.path);
  const openAttr = collapsed ? null : raw("open");
  return html`<details
    class="diff-file card"
    id="${fileAnchor(file)}"
    ${openAttr}
  >
    ${fileHeader(file)}
    <div class="diff-body">${fileBody(file)}</div>
  </details>`;
}

/** The whole diff: a summary line, then one collapsible view per file. */
export function renderDiff(diff: Diff): Html {
  if (diff.files.length === 0) {
    return html`<div class="card empty">No changes.</div>`;
  }
  return html`<div class="diff">
    <div class="diff-summary card">
      <strong>${diff.files.length}</strong> ${diff.files.length === 1
        ? "file"
        : "files"}
      changed <span class="add">+${diff.additions}</span>
      <span class="del">−${diff.deletions}</span>
    </div>
    ${diff.files.map(fileView)}
  </div>`;
}
