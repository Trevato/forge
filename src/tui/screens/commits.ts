/**
 * History: the log for any ref, and one commit's diff.
 *
 * The log pages with `--skip`, which is what git gives us; the "load more"
 * row is a real row so the cursor can land on it and the list never lies
 * about having reached the end.
 */

import { checkOfCommit, verdictsOfCommits } from "../../actions/runs.ts";
import type { CommitCheck } from "../../checks/commit_check.ts";
import type { FileDiff } from "../../git/diff.ts";
import type { Commit, RepoSource } from "../../view/source.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Screen as Surface, Rect, Span } from "../term/screen.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { fill, len, split } from "../ui/layout.ts";
import type { Tokens } from "../ui/theme.ts";
import { numberWidth, renderFileDiff } from "../ui/diff.ts";
import type { KeyEvent } from "../term/input.ts";
import { card, emptyState } from "../ui/widgets.ts";
import type { Session } from "../session.ts";
import {
  ListState,
  Scroll,
  drawList,
  drawLines,
  errorText,
  hitList,
  plural,
  relTime,
  runAsync,
} from "./common.ts";
import { refPickerScreen } from "./refs.ts";
import { localRepo, sourceName, whereRows, whereStrip } from "./where.ts";

/** A log row's mark: ✓ green, ✗ red, blank where the commit's own check has no verdict. */
const markOf = (check: CommitCheck | undefined): string =>
  check === undefined ? " " : check.state === "ok" ? "✓" : "✗";

/**
 * One line for a commit's check: green, red with the failing step, or not
 * run. When a later main commit's check answers (`checkedCommit`), it says
 * whose, so a row the log left unmarked never opens to a bare "green".
 */
export function checkLine(check: CommitCheck | null): string {
  if (check === null) return "";
  const step = check.summary.split("\n")[0]?.trim() ?? "";
  const via = check.checkedCommit === check.commit ? "" : ` · via ${check.checkedCommit.slice(0, 8)}`;
  switch (check.state) {
    case "ok":
      return `check: green${via}`;
    case "failed":
      return step === "" ? `check: red${via}` : `check: red · ${step}${via}`;
    case "pending":
      return `check: running${via}`;
    case "superseded":
      return "check: superseded";
    default:
      return "check: not run";
  }
}

export function commitsScreen(
  f: Session,
  ctx: Ctx,
  src: RepoSource,
  ref: string,
): Screen {
  let commits: Commit[] = [];
  let cursor: string | undefined;
  let more = true;
  /** "No commits" is a claim, and it waits for the first page to answer. */
  let loaded = false;
  const state = new ListState();
  /** Green or red marks for the log, one query per page; empty where the viewer may not read runs. */
  const marks = new Map<string, CommitCheck>();

  const page = async (): Promise<void> => {
    const result = await src.commits(ref, cursor);
    if (!result.ok) {
      more = false;
      if (commits.length === 0)
        ctx.toast(`no commits on ${ref}: ${errorText(result.error)}`, "danger");
    } else {
      const repo = localRepo(src);
      if (repo !== undefined)
        for (const [oid, check] of verdictsOfCommits(
          f.app,
          f.user,
          repo,
          result.value.items.map((commit) => commit.oid),
        ))
          marks.set(oid, check);
      commits = [...commits, ...result.value.items];
      cursor = result.value.next ?? undefined;
      more = result.value.next !== null;
    }
    loaded = true;
    ctx.invalidate();
  };

  /** `enter`, a click, and the "Load more…" row — one function for all three. */
  const openAt = (index: number): void => {
    const commit = commits[index];
    if (commit === undefined) runAsync(ctx, page);
    else ctx.push(commitScreen(f, ctx, src, commit));
  };

  const screen: Screen = {
    title: "Commits",
    keys: [
      binding(["j", "k"], "move"),
      binding(["enter"], "open"),
      binding(["b"], "ref"),
      binding(["r"], "refresh"),
    ],
    load: page,
    render(area, s) {
      const c = ctx.theme.c;
      const [strip, head, body] = split(area, "v", [
        len(whereRows(src)),
        len(1),
        fill(1),
      ]);
      whereStrip(s, strip!, c, f, src);
      s.text(
        head!.x,
        head!.y,
        truncate(`${sourceName(src)} · ${ref}`, head!.w),
        style(c.mutedFg, c.bg),
        head!.x + head!.w,
      );
      if (commits.length === 0) {
        emptyState(s, body!, c, {
          title: loaded ? "No commits" : "Reading…",
          body: loaded
            ? `Nothing has landed on ${ref} yet.`
            : `Reading the log of ${ref}`,
        });
        return;
      }
      const rows = commits.map((commit) => ({
        title: commit.subject,
        secondary: commit.login ?? commit.author,
        meta: `${markOf(marks.get(commit.oid))} ${commit.oid.slice(0, 8)}  ${relTime(commit.date)}`,
      }));
      if (more) rows.push({ title: "Load more…", secondary: "", meta: "" });
      drawList(s, body!, c, state, rows);
      hitList(ctx, body!, state, rows.length, { open: openAt });
    },
    key(e) {
      const total = commits.length + (more ? 1 : 0);
      if (state.key(e, total)) return true;
      if (e.key === "enter") {
        openAt(state.index);
        return true;
      }
      if (e.key === "b") {
        ctx.push(
          refPickerScreen(f, ctx, screen, src, (chosen) =>
            ctx.replace(commitsScreen(f, ctx, src, chosen)),
          ),
        );
        return true;
      }
      if (e.key === "r") {
        commits = [];
        marks.clear();
        cursor = undefined;
        more = true;
        loaded = false;
        runAsync(ctx, page);
        return true;
      }
      return false;
    },
  };
  return screen;
}

export function commitScreen(
  f: Session,
  ctx: Ctx,
  src: RepoSource,
  commit: Commit,
): Screen {
  const view = new DiffView();
  let check: CommitCheck | null = null;
  return {
    title: commit.oid.slice(0, 8),
    keys: view.keys,
    async load() {
      const result = await src.commit(commit.oid);
      view.setFiles(result.ok ? result.value.diff.files : []);
      const repo = localRepo(src);
      if (repo !== undefined) {
        try {
          const answer = await checkOfCommit(f.app, f.user, repo, commit.oid);
          check = answer.ok ? answer.value : null;
        } catch {
          check = null; // the diff still draws without its check line
        }
      }
      ctx.invalidate();
    },
    render(area, s) {
      const c = ctx.theme.c;
      const meta = Math.min(6, Math.max(0, area.h - whereRows(src)));
      const [strip, top, body] = split(area, "v", [
        len(whereRows(src)),
        len(meta),
        fill(1),
      ]);
      whereStrip(s, strip!, c, f, src);
      const inner = card(s, top!, c, { title: commit.oid.slice(0, 12) });
      s.text(
        inner.x,
        inner.y,
        truncate(commit.subject, inner.w),
        style(c.fg, c.card, 1),
        inner.x + inner.w,
      );
      const verdict = checkLine(check);
      const at = verdict === "" ? 0 : 1;
      if (verdict !== "" && inner.h > 1)
        s.text(
          inner.x,
          inner.y + 1,
          truncate(verdict, inner.w),
          style(
            check?.state === "ok"
              ? c.success
              : check?.state === "failed"
                ? c.danger
                : c.mutedFg,
            c.card,
          ),
          inner.x + inner.w,
        );
      if (inner.h > 1 + at)
        s.text(
          inner.x,
          inner.y + 1 + at,
          truncate(
            `${commit.author} <${commit.email}> · ${relTime(commit.date)} · ${view.summary()}`,
            inner.w,
          ),
          style(c.mutedFg, c.card),
          inner.x + inner.w,
        );
      if (inner.h > 2 + at && commit.body !== "")
        s.text(
          inner.x,
          inner.y + 2 + at,
          truncate(commit.body.split("\n")[0] ?? "", inner.w),
          style(c.faint, c.card),
          inner.x + inner.w,
        );
      view.render(s, body!, c);
    },
    key: (e) => view.key(e, ctx),
  };
}

/**
 * A diff as a scrolling document with per-file collapsing, hunk jumps, and a
 * row → (path, side, line) mapping. That mapping is the whole reason this is
 * a class: a review comment is anchored to a diff row, so the view must be
 * able to say what the cursor is standing on, and to splice existing comments
 * back in at the row they belong to.
 */
export class DiffView {
  files: FileDiff[] = [];
  private collapsed = new Set<number>();
  private lines: Span[][] = [];
  /** Parallel to `lines`: the file each row belongs to. */
  private owner: number[] = [];
  /** Parallel to `lines`: the diff anchor a row carries, if any. */
  private anchors: (DiffAnchor | null)[] = [];
  private hunkRows: number[] = [];
  private fileRows: number[] = [];
  private notes = new Map<string, DiffNote>();
  /** Parallel to `lines`: the thread a spliced row belongs to, if any. */
  private threads: (DiffThread | null)[] = [];
  /** First row of each unresolved thread — what `n`/`p` step through. */
  private openThreadRows: number[] = [];
  private width = 0;
  readonly scroll = new Scroll();

  readonly keys = [
    binding(["j", "k"], "scroll"),
    binding(["n", "p"], "hunk"),
    binding(["]", "["], "file"),
    binding(["enter"], "collapse"),
  ];

  setFiles(files: FileDiff[]): void {
    this.files = files;
    this.collapsed.clear();
    this.invalidate();
  }

  /** Rows to splice in after the diff row at `anchorKey(path, side, line)`. */
  setNotes(notes: Map<string, DiffNote>): void {
    this.notes = notes;
    this.invalidate();
  }

  /** The thread the viewport is standing in, or null. */
  threadHere(row = this.scroll.top): DiffThread | null {
    return this.threads[row] ?? null;
  }

  /** How many unresolved threads are anchored in what is on screen. */
  get openThreads(): number {
    return this.openThreadRows.length;
  }

  /** Rendered rows — what a scroll region has to clamp against. */
  get length(): number {
    return this.lines.length;
  }

  invalidate(): void {
    this.width = 0;
    this.lines = [];
  }

  summary(): string {
    const add = this.files.reduce((n, file) => n + file.additions, 0);
    const del = this.files.reduce((n, file) => n + file.deletions, 0);
    return `${plural(this.files.length, "file")} +${add} -${del}`;
  }

  /**
   * Rebuild the rendered rows. `renderFileDiff` emits, per file, one header
   * row and then per hunk one header plus one row per diff line — walking the
   * same structure here is what keeps `anchors` exactly parallel to `lines`.
   */
  private build(width: number, c: Tokens): void {
    if (width === this.width && this.lines.length > 0) return;
    this.width = width;
    this.lines = [];
    this.owner = [];
    this.anchors = [];
    this.hunkRows = [];
    this.fileRows = [];

    this.threads = [];
    this.openThreadRows = [];

    const push = (
      row: Span[],
      file: number,
      anchor: DiffAnchor | null,
      thread: DiffThread | null = null,
    ): void => {
      this.lines.push(row);
      this.owner.push(file);
      this.anchors.push(anchor);
      this.threads.push(thread);
    };

    // One gutter width for every file in the view: the numbers must not step
    // when the reader scrolls from one file into the next.
    const nw = numberWidth(this.files);
    this.files.forEach((file, i) => {
      this.fileRows.push(this.lines.length);
      const collapsed = this.collapsed.has(i);
      const rendered = renderFileDiff(
        collapsed ? { ...file, hunks: [] } : file,
        width,
        c,
        nw,
      );
      if (collapsed) {
        for (const row of rendered) push(row, i, null, null);
        push([], i, null, null);
        return;
      }
      let at = 0;
      push(rendered[at++] ?? [], i, null); // the file header
      for (const hunk of file.hunks) {
        this.hunkRows.push(this.lines.length);
        push(rendered[at++] ?? [], i, null); // the hunk header
        for (const line of hunk.lines) {
          const side: DiffAnchor["side"] = line.kind === "del" ? "old" : "new";
          const number = side === "old" ? line.oldNumber : line.newNumber;
          const anchor =
            number === null ? null : { path: file.path, side, line: number };
          const note =
            anchor === null
              ? undefined
              : this.notes.get(
                  `${anchor.path}\0${anchor.side}\0${anchor.line}`,
                );
          const thread = note?.thread ?? null;
          // The *line the comment is about* is part of the thread, not just
          // the rows under it: standing on it is standing on the
          // conversation, which is what a reader means by "this one".
          if (thread !== null && !thread.resolved)
            this.openThreadRows.push(this.lines.length);
          push(rendered[at++] ?? [], i, anchor, thread);
          if (note === undefined) continue;
          for (const row of note.rows) push(row, i, null, thread);
        }
      }
      push([], i, null);
    });
  }

  render(s: Surface, r: Rect, c: Tokens): void {
    if (this.files.length === 0) {
      emptyState(s, r, c, {
        title: "No changes",
        body: "This revision touches no files.",
      });
      return;
    }
    this.build(Math.max(20, r.w - 1), c);
    drawLines(s, r, c, this.scroll, this.lines);
  }

  /** The file the viewport is sitting in. */
  currentFile(): number {
    return this.owner[this.scroll.top] ?? 0;
  }

  /** What the top row is anchored to — where a new review comment lands. */
  anchorAt(row = this.scroll.top): DiffAnchor | null {
    return this.anchors[row] ?? null;
  }

  key(e: KeyEvent, ctx: Ctx): boolean {
    // Standing in a thread changes what "next" means. A reviewer walking the
    // unanswered comments is doing one thing; a reader walking the change is
    // doing another, and the cursor already says which.
    const stops =
      this.threadHere() !== null && this.openThreadRows.length > 0
        ? this.openThreadRows
        : this.hunkRows;
    if (e.key === "n") return this.jump(stops, 1);
    if (e.key === "p") return this.jump(stops, -1);
    if (e.key === "]") return this.jump(this.fileRows, 1);
    if (e.key === "[") return this.jump(this.fileRows, -1);
    if (e.key === "enter") {
      const i = this.currentFile();
      if (this.collapsed.has(i)) this.collapsed.delete(i);
      else this.collapsed.add(i);
      this.invalidate();
      ctx.invalidate();
      return true;
    }
    return this.scroll.key(e, this.lines.length);
  }

  private jump(stops: readonly number[], dir: 1 | -1): boolean {
    const at = this.scroll.top;
    const next =
      dir === 1
        ? stops.find((row) => row > at)
        : [...stops].reverse().find((row) => row < at);
    if (next !== undefined) this.scroll.to(next, this.lines.length);
    return true;
  }
}

/** A review thread, as the diff view has to know it: an id and a state. */
export interface DiffThread {
  readonly anchor: string;
  readonly resolved: boolean;
}

/** What hangs under one anchored diff row: some rows, and maybe a thread. */
export interface DiffNote {
  readonly rows: Span[][];
  readonly thread?: DiffThread;
}

export interface DiffAnchor {
  readonly path: string;
  readonly side: "old" | "new";
  readonly line: number;
}
