/**
 * One file's diff, hunk by hunk — the screen where a commit is actually
 * shaped. `git add -p` without the yes/no/quit interrogation: the hunks are
 * a list, the cursor is on one of them, and `s`/`u`/`d` act on that one.
 *
 * The rows come from `ui/diff.ts`, so a hunk here is coloured exactly as the
 * same hunk in a pull request on the web. The only thing this file adds is
 * the notion of a *current* hunk, and the highlight that shows which.
 */

import type { FileDiff, Hunk } from "../../git/diff.ts";
import * as git from "../../git/local.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding, type Binding } from "../app/keys.ts";
import type { Rect, Screen as Surface, Span } from "../term/screen.ts";
import { BOLD, style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { confirmScreen, drawLines, Scroll } from "../screens/common.ts";
import { numberWidth, renderFileDiff } from "../ui/diff.ts";
import { emptyState, spinner } from "../ui/widgets.ts";
import type { Tokens } from "../ui/theme.ts";
import { SEP, Task } from "./common.ts";

export type Section = "staged" | "unstaged" | "untracked" | "conflicted";

/**
 * A file diff with a hunk cursor. Kept as a class rather than a screen so the
 * work screen can embed it in its preview pane and the hunk screen can own
 * it outright, from one implementation.
 */
export class HunkList {
  file: FileDiff | null = null;
  index = 0;
  /** Off in the work screen's preview pane, where there is no hunk cursor. */
  highlight = true;
  readonly scroll = new Scroll();
  private lines: Span[][] = [];
  private hunkRows: number[] = [];
  private width = 0;

  get hunks(): Hunk[] {
    return this.file?.hunks ?? [];
  }

  get current(): Hunk | undefined {
    return this.hunks[this.index];
  }

  setFile(file: FileDiff | null): void {
    this.file = file;
    this.index = Math.min(this.index, Math.max(0, this.hunks.length - 1));
    this.width = 0;
    this.lines = [];
  }

  private build(width: number, c: Tokens): void {
    if (width === this.width && this.lines.length > 0) return;
    this.width = width;
    this.lines = [];
    this.hunkRows = [];
    if (this.file === null) return;
    // Walk the same structure `renderFileDiff` emits — one file header, then
    // per hunk one header and one row per line — so the row index of each
    // hunk header is known exactly rather than guessed by pattern matching.
    const rendered = renderFileDiff(
      this.file,
      width,
      c,
      numberWidth([this.file]),
    );
    let at = 0;
    this.lines.push(rendered[at++] ?? []);
    for (const hunk of this.file.hunks) {
      this.hunkRows.push(this.lines.length);
      this.lines.push(rendered[at++] ?? []);
      for (let i = 0; i < hunk.lines.length; i++)
        this.lines.push(rendered[at++] ?? []);
    }
  }

  render(s: Surface, r: Rect, c: Tokens): void {
    if (this.file === null || this.hunks.length === 0) {
      emptyState(s, r, c, {
        title: "No changes",
        body: "Nothing in this file differs.",
      });
      return;
    }
    this.build(Math.max(20, r.w - 1), c);
    const marked = this.lines.map((row, i) =>
      this.highlight && i === this.hunkRows[this.index]
        ? row.map((span) => ({
            text: span.text,
            style: style(c.accentFg, c.accent, BOLD),
          }))
        : row,
    );
    drawLines(s, r, c, this.scroll, marked);
  }

  /** Move the hunk cursor and bring its header to the top of the viewport. */
  select(index: number): void {
    if (this.hunks.length === 0) return;
    this.index = Math.max(0, Math.min(index, this.hunks.length - 1));
    const row = this.hunkRows[this.index];
    if (row !== undefined) this.scroll.to(row, this.lines.length);
  }

  key(e: KeyOf): boolean {
    if (e.key === "n") {
      this.select(this.index + 1);
      return true;
    }
    if (e.key === "p") {
      this.select(this.index - 1);
      return true;
    }
    return this.scroll.key(e, this.lines.length);
  }
}

type KeyOf = Parameters<Screen["key"]>[0];

export interface HunkScreenOpts {
  readonly dir: string;
  readonly path: string;
  readonly origPath: string | null;
  readonly section: Section;
  /** Called after any change, so the work screen can reload its file list. */
  readonly onChange: () => void;
}

/**
 * The full-screen hunk view. Every action reloads the diff from git rather
 * than mutating the model: after `apply --cached` the hunk boundaries have
 * genuinely moved, and a stale model here would stage the wrong lines next.
 */
export function hunkScreen(ctx: Ctx, o: HunkScreenOpts): Screen {
  const view = new HunkList();
  const task = new Task(ctx);
  const staged = o.section === "staged";
  const untracked = o.section === "untracked";
  // A conflicted file is staged whole, never by hunk: the hunks here are the
  // conflict markers, and half-staging those is how a "<<<<<<<" reaches a
  // commit. Marking it resolved is the only sensible verb.
  const conflicted = o.section === "conflicted";
  const whole = untracked || conflicted;

  const reload = async (): Promise<void> => {
    const result = await git.diff(o.dir, {
      path: o.path,
      ...(staged ? { staged: true } : {}),
      ...(untracked ? { untracked: true } : {}),
      ...(conflicted ? { conflicted: true } : {}),
    });
    view.setFile(result.ok ? (result.value.files[0] ?? null) : null);
    o.onChange();
    ctx.invalidate();
    if (result.ok && result.value.files.length === 0) ctx.pop();
  };

  const act = (
    label: string,
    fn: (hunk: Hunk) => Promise<git.LocalResult<void>>,
  ): void => {
    const hunk = view.current;
    if (hunk === undefined) return;
    task.run(label, () => fn(hunk), reload);
  };

  const screen: Screen = {
    title: o.path,
    get keys(): Binding[] {
      return [
        binding(["n", "p"], "hunk"),
        binding(["j", "k"], "scroll"),
        ...(staged
          ? [binding(["u"], "unstage hunk")]
          : conflicted
            ? [binding(["s"], "stage resolved")]
            : untracked
              ? [binding(["s"], "stage file")]
              : [binding(["s"], "stage hunk"), binding(["d"], "discard hunk")]),
        binding(["esc"], "back"),
      ];
    },
    async load() {
      await reload();
    },
    render(area, s) {
      const c = ctx.theme.c;
      const head = { x: area.x, y: area.y, w: area.w, h: 1 };
      const body = { x: area.x, y: area.y + 1, w: area.w, h: area.h - 1 };
      const count = view.hunks.length;
      s.fill(head, " ", style(c.mutedFg, c.muted));
      const right = head.x + head.w;
      const room = Math.max(
        0,
        head.w - 2 - (count === 0 ? 0 : 12) - sectionNote(o.section).length - 6,
      );
      let x = s.text(
        head.x + 1,
        head.y,
        truncate(o.path, room),
        style(c.fg, c.muted, BOLD),
        right,
      );
      const say = (text: string): void => {
        x = s.text(x, head.y, ` ${SEP} `, style(c.faint, c.muted), right);
        x = s.text(x, head.y, text, style(c.mutedFg, c.muted), right);
      };
      if (count > 0) say(`hunk ${view.index + 1}/${count}`);
      say(sectionNote(o.section));
      if (task.busy) {
        s.line(
          head,
          0,
          `${truncate(task.note, Math.max(0, head.w - 4))}  `,
          style(c.accent, c.muted),
          "right",
        );
        spinner(s, head.x + head.w - 2, head.y, c, ctx.tick);
      }
      view.render(s, body, c);
    },
    key(e) {
      if (task.blocked) return true;
      if (e.key === "s" && !staged) {
        if (whole)
          task.run("stage", () => git.stagePath(o.dir, o.path), reload);
        else
          act("stage hunk", (hunk) =>
            git.stageHunk(o.dir, o.path, hunk, o.origPath ?? undefined),
          );
        return true;
      }
      if (e.key === "u" && staged) {
        act("unstage hunk", (hunk) =>
          git.unstageHunk(o.dir, o.path, hunk, o.origPath ?? undefined),
        );
        return true;
      }
      if (e.key === "d" && !staged && !whole) {
        const hunk = view.current;
        if (hunk === undefined) return true;
        ctx.push(
          confirmScreen(ctx, screen, {
            title: "Discard hunk",
            body: [
              `Throw away hunk ${view.index + 1} of ${o.path}?`,
              "",
              "This cannot be undone.",
            ],
            actions: [
              { label: "Cancel", variant: "ghost" },
              { label: "Discard", variant: "danger" },
            ],
            onChoose: (choice) => {
              if (choice === 1)
                task.run(
                  "discard hunk",
                  () =>
                    git.discardHunk(
                      o.dir,
                      o.path,
                      hunk,
                      o.origPath ?? undefined,
                    ),
                  reload,
                );
            },
          }),
        );
        return true;
      }
      return view.key(e);
    },
  };
  return screen;
}

/** The section header above a group of files: CHANGED, NEW, STAGED. */
export function sectionLabel(section: Section): string {
  switch (section) {
    case "staged":
      return "Staged";
    case "unstaged":
      return "Changed";
    case "untracked":
      return "New";
    case "conflicted":
      return "Conflicted";
  }
}

/** The same four states as a phrase, for a header read left to right. */
export function sectionNote(section: Section): string {
  switch (section) {
    case "staged":
      return "staged";
    case "unstaged":
      return "changed";
    case "untracked":
      return "new file";
    case "conflicted":
      return "conflicted";
  }
}
