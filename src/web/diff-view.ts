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

import type { Mark } from "../core/marks.ts";
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
import { btn, card, disclosure, icon, time, userLink } from "./ui.ts";
import { renderMarkdown } from "./markdown.ts";
import { wordDiff, type Segment } from "./worddiff.ts";

/** Highlighted tokens per side for a file, keyed by path in a SyntaxMap. */
export interface FileTokens {
  old?: Token[][];
  new?: Token[][];
}
export type SyntaxMap = Map<string, FileTokens>;

/**
 * One review thread's settled-ness, as the viewer may act on it.
 *
 * A thread is every review comment sharing one anchor, and "resolved" is a
 * property of the conversation rather than of any line in it — so it is
 * rendered once, above the comments, and it is what decides whether they are
 * shown at all.
 */
export interface ThreadView {
  /** The digest that addresses this thread in a URL (`anchorId`). */
  readonly anchor: string;
  readonly resolvedAt: string | null;
  /** Who settled it, by username. */
  readonly resolvedBy: string | null;
  /** Whether this viewer may settle it, or take that back. */
  readonly mayResolve: boolean;
}

/** Everything the viewer needs beyond the diff itself. */
export interface DiffViewOptions {
  syntax?: SyntaxMap;
  /** Review comments, grouped by `anchorKey(path, side, line)`. */
  comments?: Map<string, ReviewComment[]>;
  /** Thread state, under the same key as `comments`. */
  threads?: Map<string, ThreadView>;
  /** Who each reviewer is, by username (`core/marks.ts`). */
  marks?: ReadonlyMap<string, Mark>;
  /** Render an inline comment form at this anchor (from a `?rc=` link). */
  active?: { path: string; side: Side; line: number };
  /** Base path for comment forms and "+" links, e.g. `/owner/repo/pulls/3`.
   * When set, lines become commentable. */
  reviewBase?: string;
  /** The page the diff is read on, for the "+" links and Cancel, when it
   * is not `reviewBase` itself — e.g. `/owner/repo/pulls/3/files`. */
  reviewPage?: string;
  /** Base path for a stubbed file's "View file" link, e.g.
   * `/owner/repo/blob/<oid>` — the file's path is appended. Omit to render
   * the stub without a link (a live/origin diff has no local blob route). */
  fileLinkBase?: string;
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

// A file's diff renders as a stub, not a table, once it holds this many
// bytes — a bound on the diff's own content, independent of MAX_FILE_LINES,
// because a committed bundle can carry megabytes in only a handful of lines.
export const MAX_FILE_BYTES = 100_000;

// ...or once any single line is this wide. Catches a minified file even when
// MAX_FILE_LINES and MAX_FILE_BYTES both pass — a page must never grow wider
// than its viewport because one line happened to be short in count.
export const MAX_LINE_WIDTH = 2000;

const GENERATED =
  /(^|\/)(package-lock\.json|bun\.lock|yarn\.lock|pnpm-lock\.yaml|go\.sum|Cargo\.lock)$/;

/** Why a file's diff was replaced with a stub, in one sentence fragment. */
export interface FileStub {
  readonly reason: string;
}

/** Total bytes and the widest single line across a file's hunks. The hunks
 * are already parsed in memory, so this costs nothing extra to compute. */
function diffSize(file: FileDiff): { bytes: number; longestLine: number } {
  let bytes = 0;
  let longestLine = 0;
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      bytes += line.content.length;
      if (line.content.length > longestLine) longestLine = line.content.length;
    }
  }
  return { bytes, longestLine };
}

/** Whether a file's diff exceeds the render budget, and why — checked before
 * building rows so an oversized file never reaches the syntax highlighter
 * (diff-syntax.ts) or the page (fileBody below). Binary files have their own
 * short-circuit and are never stubbed. */
export function stubFor(file: FileDiff): FileStub | null {
  const changed = file.additions + file.deletions;
  if (changed > MAX_FILE_LINES) {
    return {
      reason: `${changed.toLocaleString()} changed lines (limit ${MAX_FILE_LINES.toLocaleString()})`,
    };
  }
  const { bytes, longestLine } = diffSize(file);
  if (bytes > MAX_FILE_BYTES) {
    return {
      reason: `${bytes.toLocaleString()} bytes of diff (limit ${MAX_FILE_BYTES.toLocaleString()})`,
    };
  }
  if (longestLine > MAX_LINE_WIDTH) {
    return {
      reason: `a line ${longestLine.toLocaleString()} characters wide (limit ${MAX_LINE_WIDTH.toLocaleString()})`,
    };
  }
  return null;
}

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

export function pathAnchor(path: string): string {
  // Stable per-path id for deep-linking; not security-sensitive.
  return "d-" + escapeHtml(path).replace(/[^a-zA-Z0-9]+/g, "-");
}

function fileAnchor(file: FileDiff): string {
  return pathAnchor(file.path);
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
    const href = `${opts.reviewPage ?? opts.reviewBase}?rc=${encodeURIComponent(path)}~${side}~${n}#rc`;
    return html`<td class="dn">
      <a class="dn-comment" href="${href}" title="Comment on this line">${n}</a>
    </td>`;
  };

  // `.dc` is `white-space: pre`, so the cell's contents are assembled here,
  // in one value, and interpolated whole. A pretty-printed newline between
  // `<td>` and its span would render as a literal blank line and an indent —
  // which is exactly how this viewer once lost its density.
  const cell = html`<span class="dcx"
      >${composeLine(row.text, tokenLine, row.changed)}</span
    >${when(
      row.noNewline,
      () => html`<span class="nonl" title="No newline at end of file">↵</span>`,
    )}`;
  const rowHtml = html`<tr class="dl" data-k="${row.kind}">
    ${gutter(row.oldNumber, side === "old")}${gutter(
      row.newNumber,
      side === "new",
    )}
    <td class="dc" data-mark="${mark}">${cell}</td>
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

  const state = opts.threads?.get(key);
  const currentHash = hashLine(currentText);
  const thread = comments.map((c) => {
    const outdated = c.lineHash !== currentHash;
    return html`<div class="card comment">
      <div class="card-head">
        ${userLink(c.authorName, { mark: opts.marks?.get(c.authorName) })}
        ${time(c.createdAt)}
        ${when(
          outdated,
          () => html`<span class="badge" data-variant="danger">outdated</span>`,
        )}
      </div>
      <div class="comment-body prose">${renderMarkdown(c.body)}</div>
    </div>`;
  });

  const form = isActive
    ? html`<form
        class="card comment-form"
        data-submit-key
        method="post"
        action="${opts.reviewBase}/review"
        id="rc"
      >
        <input type="hidden" name="path" value="${path}" />
        <input type="hidden" name="side" value="${side}" />
        <input type="hidden" name="line" value="${line}" />
        <label class="sr-only" for="rc-text">Comment on this line</label>
        <textarea
          class="input"
          id="rc-text"
          name="body"
          rows="3"
          data-grow
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
          <a
            class="btn"
            data-size="sm"
            data-variant="ghost"
            href="${opts.reviewPage ?? opts.reviewBase}"
            >Cancel</a
          >
        </div>
      </form>`
    : html``;

  // A settled thread collapses to one line: who settled it and when, with
  // the conversation itself one click away. The point of resolving is to get
  // an answered question out of the way of the unanswered ones, and a
  // "resolved" badge above the same wall of text does not do that. It is the
  // card's muted state; the control to take it back sits in the card's foot.
  const resolved = state?.resolvedAt != null;
  const toggle = threadToggle(opts, state, !resolved);
  const body = resolved
    ? card(
        html`<span class="muted small"
            >${icon("check")}
            resolved${state.resolvedBy === null
              ? null
              : html` by
                  ${userLink(state.resolvedBy, {
                    mark: opts.marks?.get(state.resolvedBy),
                  })}`}
            · ${time(state.resolvedAt)}</span
          >
          ${disclosure(
            html`Show ${comments.length}
            ${comments.length === 1 ? "comment" : "comments"}`,
            html`${thread}`,
            { small: true },
          )}`,
        toggle ? { foot: toggle } : {},
      )
    : card(html`${thread}`, toggle ? { foot: toggle } : {});

  return html`<tr>
    <td class="dn"></td>
    <td class="dn"></td>
    <td class="dc-review">${body}${form}</td>
  </tr>`;
}

/**
 * Resolve, or take it back. A writer may settle any thread; so may whoever
 * commented in it — the reviewer who raised a point is exactly the person
 * who can say it is answered (`resolveReviewThread` enforces both).
 */
function threadToggle(
  opts: DiffViewOptions,
  state: ThreadView | undefined,
  resolve: boolean,
): Html | undefined {
  if (state === undefined || !state.mayResolve || !opts.reviewBase)
    return undefined;
  const verb = resolve ? "resolve" : "unresolve";
  return html`<form
    method="post"
    action="${opts.reviewBase}/threads/${state.anchor}/${verb}"
  >
    ${btn(resolve ? "Resolve" : "Unresolve", { size: "sm", variant: "outline" })}
  </form>`;
}

function hunkHeader(hunk: Hunk): Html {
  const at = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
  // One value, one line — see the note on `cell` above: `.dc` is `pre`.
  const cell = html`<span class="mono muted">${at}</span>${when(
      hunk.section !== "",
      () => html` <span class="muted">${hunk.section}</span>`,
    )}`;
  return html`<tr class="dh">
    <td class="dn"></td>
    <td class="dn"></td>
    <td class="dc">${cell}</td>
  </tr>`;
}

/** A stub in place of hunks: the path is already in the header above this,
 * inside the same `<details>`; this adds why, the real counts, and a way to
 * read the file without paying for it here. No hunks reach the HTML. */
function stubBody(file: FileDiff, stub: FileStub, opts: DiffViewOptions): Html {
  const href = opts.fileLinkBase ? `${opts.fileLinkBase}/${file.path}` : null;
  return html`<div class="diff-note diff-stub">
    <p>
      Diff not shown — ${stub.reason}.
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
    </p>
    ${when(
      href,
      (h) =>
        html`<a class="btn" data-size="sm" data-variant="outline" href="${h}"
          >${icon("file")} View file</a
        >`,
    )}
  </div>`;
}

function fileBody(file: FileDiff, ctx: RowCtx): Html {
  if (file.binary) {
    return html`<div class="diff-note">Binary file not shown.</div>`;
  }
  if (file.hunks.length === 0) {
    return html`<div class="diff-note">No content changes.</div>`;
  }
  const stub = stubFor(file);
  if (stub && !fileHasReview(file, ctx.opts)) {
    return stubBody(file, stub, ctx.opts);
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
    <span class="diff-path mono" title="${file.path}">${name}</span>
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
    <label class="diff-viewed" title="Mark this file reviewed">
      <input type="checkbox" />
      <span class="hide-sm">Viewed</span>
    </label>
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

/** The diff's own totals as the summary line words them: "3 files", "+12", "−4". */
export function diffTotals(diff: {
  files: { length: number };
  additions: number;
  deletions: number;
}): Html {
  const n = diff.files.length;
  return html`<strong>${n}</strong> ${n === 1 ? "file" : "files"}
    <span class="add">+${diff.additions}</span>
    <span class="del">−${diff.deletions}</span>`;
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
    return html`<div class="empty">No changes.</div>`;
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
        html`<p class="muted small">
          ${hidden.toLocaleString()} more ${hidden === 1 ? "file" : "files"} not
          shown.
        </p>`,
    )}
  </div>`;
}
