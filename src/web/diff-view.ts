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
import {
  anchorKey,
  hashLine,
  type ReviewComment,
  type Side,
} from "../core/reviews.ts";
import { composeLine } from "./code.ts";
import type { Token } from "./highlight.ts";
import { escapeHtml, html, raw, when, type Html } from "./html.ts";
import { renderMarkdown } from "./markdown.ts";
import { wordDiff, type Segment } from "./worddiff.ts";

/** Highlighted tokens per side for a file, keyed by path in a SyntaxMap. */
export interface FileTokens {
  old?: Token[][];
  new?: Token[][];
}
export type SyntaxMap = Map<string, FileTokens>;

/** Everything the viewer needs beyond the diff itself. */
export interface DiffViewOptions {
  syntax?: SyntaxMap;
  /** Review comments, grouped by `anchorKey(path, side, line)`. */
  comments?: Map<string, ReviewComment[]>;
  /** Render an inline comment form at this anchor (from a `?rc=` link). */
  active?: { path: string; side: Side; line: number };
  /** Base path for comment forms and "+" links, e.g. `/owner/repo/pulls/3`.
   * When set, lines become commentable. */
  reviewBase?: string;
}

/** Per-file render context, resolved once per file. */
interface RowCtx {
  path: string;
  tokens: FileTokens;
  opts: DiffViewOptions;
}

// Above this many changed lines a single file is not rendered inline — it is
// a scroll-and-memory hazard and almost never read line by line.
const MAX_FILE_LINES = 5000;

// Cap files rendered (and highlighted — see diff-syntax.ts) per diff. Beyond
// this, a page load would spawn thousands of git subprocesses; a 5000-file
// commit is a DoS, not something anyone reads top to bottom.
export const MAX_DIFF_FILES = 100;

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

/** Per-character changed mask for a line, from its word-diff segments. */
function changedMask(parts: Segment[]): boolean[] {
  const mask: boolean[] = [];
  for (const s of parts) {
    for (let k = 0; k < s.text.length; k++) mask.push(s.changed);
  }
  return mask;
}

interface Row {
  kind: DiffLine["kind"];
  oldNumber: number | null;
  newNumber: number | null;
  text: string;
  /** Per-character diff highlight, for a paired modified line. */
  changed: boolean[] | undefined;
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
      rows.push({ ...base(line), changed: undefined });
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
        ...base(del),
        changed: paired ? changedMask(paired.old) : undefined,
      });
    }
    for (let k = 0; k < adds.length; k++) {
      const add = adds[k]!;
      const paired =
        k < pairs ? wordDiff(dels[k]!.content, add.content) : undefined;
      rows.push({
        ...base(add),
        changed: paired ? changedMask(paired.new) : undefined,
      });
    }
  }
  return rows;
}

function base(line: DiffLine): Omit<Row, "changed"> {
  return {
    kind: line.kind,
    oldNumber: line.oldNumber,
    newNumber: line.newNumber,
    text: line.content,
    noNewline: line.noNewline,
  };
}

function renderRow(row: Row, ctx: RowCtx): Html {
  const mark = row.kind === "add" ? "+" : row.kind === "del" ? "-" : " ";
  const { tokens, path, opts } = ctx;
  // Del lines are colored from the old blob; add and context from the new.
  const tokenLine =
    row.kind === "del"
      ? row.oldNumber !== null
        ? tokens.old?.[row.oldNumber - 1]
        : undefined
      : row.newNumber !== null
        ? tokens.new?.[row.newNumber - 1]
        : undefined;

  // A row is commentable on the side git shows it: del on old, else new.
  const side: Side = row.kind === "del" ? "old" : "new";
  const lineNo = side === "old" ? row.oldNumber : row.newNumber;

  const gutter = (n: number | null, isAnchorSide: boolean) => {
    if (n === null) return html`<td class="dn"></td>`;
    if (!opts.reviewBase || !isAnchorSide)
      return html`<td class="dn">${n}</td>`;
    const href = `${opts.reviewBase}?rc=${encodeURIComponent(path)}~${side}~${n}#rc`;
    return html`<td class="dn">
      <a class="dn-comment" href="${href}" title="Comment on this line">${n}</a>
    </td>`;
  };

  const rowHtml = html`<tr class="dl" data-k="${row.kind}">
    ${gutter(row.oldNumber, side === "old")}${gutter(
      row.newNumber,
      side === "new",
    )}
    <td class="dc" data-mark="${mark}">
      <span class="dcx">${composeLine(row.text, tokenLine, row.changed)}</span
      >${when(
        row.noNewline,
        () =>
          html`<span class="nonl" title="No newline at end of file">↵</span>`,
      )}
    </td>
  </tr>`;

  // Existing comments and a form, if any, ride under the row.
  const extras =
    lineNo === null ? html`` : reviewRows(path, side, lineNo, row.text, ctx);
  return html`${rowHtml}${extras}`;
}

/** Comment thread and (when active) a compose form, as full-width rows. */
function reviewRows(
  path: string,
  side: Side,
  line: number,
  currentText: string,
  ctx: RowCtx,
): Html {
  const { opts } = ctx;
  const key = anchorKey(path, side, line);
  const comments = opts.comments?.get(key) ?? [];
  const isActive =
    opts.active !== undefined &&
    opts.active.path === path &&
    opts.active.side === side &&
    opts.active.line === line;
  if (comments.length === 0 && !isActive) return html``;

  const currentHash = hashLine(currentText);
  const thread = comments.map((c) => {
    const outdated = c.lineHash !== currentHash;
    return html`<div class="rc">
      <div class="rc-head">
        <strong>${c.authorName}</strong>
        ${when(
          outdated,
          () => html`<span class="badge rc-outdated">outdated</span>`,
        )}
      </div>
      <div class="md rc-body">${renderMarkdown(c.body)}</div>
    </div>`;
  });

  const form = isActive
    ? html`<form
        class="rc-form"
        method="post"
        action="${opts.reviewBase}/review"
        id="rc"
      >
        <input type="hidden" name="path" value="${path}" />
        <input type="hidden" name="side" value="${side}" />
        <input type="hidden" name="line" value="${line}" />
        <input type="hidden" name="lineHash" value="${currentHash}" />
        <textarea
          class="input"
          name="body"
          rows="3"
          placeholder="Comment on this line"
          required
          autofocus
        ></textarea>
        <div class="form-actions">
          <button
            class="btn"
            data-variant="primary"
            data-size="sm"
            type="submit"
          >
            Add comment
          </button>
        </div>
      </form>`
    : html``;

  return html`<tr class="dl-review">
    <td class="dn"></td>
    <td class="dn"></td>
    <td class="dc-review">${thread}${form}</td>
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

function fileBody(file: FileDiff, ctx: RowCtx): Html {
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
        (hunk) =>
          html`${hunkHeader(hunk)}${rowsForHunk(hunk).map((row) =>
            renderRow(row, ctx),
          )}`,
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

function fileView(file: FileDiff, opts: DiffViewOptions): Html {
  // Generated/lockfiles start collapsed; everything else is open. A file with
  // an active comment or existing comments is forced open so it's visible.
  const ctx: RowCtx = {
    path: file.path,
    tokens: opts.syntax?.get(file.path) ?? {},
    opts,
  };
  const collapsed = GENERATED.test(file.path) && !fileHasReview(file, opts);
  const openAttr = collapsed ? null : raw("open");
  return html`<details
    class="diff-file card"
    id="${fileAnchor(file)}"
    ${openAttr}
  >
    ${fileHeader(file)}
    <div class="diff-body">${fileBody(file, ctx)}</div>
  </details>`;
}

function fileHasReview(file: FileDiff, opts: DiffViewOptions): boolean {
  if (opts.active?.path === file.path) return true;
  if (!opts.comments) return false;
  for (const key of opts.comments.keys()) {
    if (key.startsWith(`${file.path}\0`)) return true;
  }
  return false;
}

/**
 * The whole diff: a summary line, then one collapsible view per file. Options
 * add syntax color and inline review comments; omit them and the diff still
 * renders. Accepts a bare SyntaxMap too, for the read-only (commit) case.
 */
export function renderDiff(
  diff: Diff,
  options?: DiffViewOptions | SyntaxMap,
): Html {
  const opts: DiffViewOptions =
    options instanceof Map ? { syntax: options } : (options ?? {});
  if (diff.files.length === 0) {
    return html`<div class="card empty">No changes.</div>`;
  }
  const shown = diff.files.slice(0, MAX_DIFF_FILES);
  const hidden = diff.files.length - shown.length;
  return html`<div class="diff">
    <div class="diff-summary card">
      <strong>${diff.files.length}</strong> ${diff.files.length === 1
        ? "file"
        : "files"}
      changed <span class="add">+${diff.additions}</span>
      <span class="del">−${diff.deletions}</span>
    </div>
    ${shown.map((file) => fileView(file, opts))}
    ${when(
      hidden > 0,
      () =>
        html`<div class="card diff-note">
          ${hidden.toLocaleString()} more ${hidden === 1 ? "file" : "files"} not
          shown.
        </div>`,
    )}
  </div>`;
}
