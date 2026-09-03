/**
 * The commit dialog: the last screen between an edit and a commit.
 *
 * It asks the three questions `editFiles` takes and nothing else — what to say,
 * where to put it, and whether to propose it — because those three *are* the
 * action's shape, and a dialog that collected them separately would invent the
 * half-finished states (a branch with no commit, a commit with no pull) that
 * one call exists to prevent.
 *
 * The default target is a new branch. On a repo whose default branch is
 * protected that is the only thing that can work for a non-admin, and even
 * where it is not, "write straight to main from a terminal file browser" is not
 * a default anybody should have to notice they chose.
 */

import type { EditFilesError, EditResult } from "../../actions/contents.ts";
import type { Repo } from "../../core/repos.ts";
import type { Result } from "../../kernel/result.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style, BOLD } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { center, fill, len, split } from "../ui/layout.ts";
import { card, input, type CursorPos } from "../ui/widgets.ts";
import { Textarea } from "../ui/textarea.ts";
import type { Session } from "../session.ts";
import { errorText, runAsync } from "./common.ts";

export interface CommitPlan {
  readonly message: string;
  /** Commit onto a fresh branch instead of the one being browsed. */
  readonly newBranch?: string;
  readonly pull?: { title: string; body?: string };
  /**
   * The paths the ticked boxes left in. Empty when the caller offered no
   * file list at all — a dialog over a single implicit file.
   */
  readonly paths: readonly string[];
}

/** One line of the change list: what is happening to which path. */
export interface CommitFile {
  readonly path: string;
  readonly kind: "add" | "edit" | "delete";
}

export interface CommitDialogOptions {
  readonly repo: Repo;
  /** The branch being browsed — the "current branch" target. */
  readonly branch: string;
  readonly title: string;
  /** Prefills the subject line. */
  readonly subject: string;
  readonly defaultBranchName: string;
  /**
   * Everything this commit could carry, ticked on. A workspace hands over
   * every modified buffer and every pending deletion at once, because that
   * is what `editFiles` takes — one call, one commit, no half state.
   */
  readonly files?: readonly CommitFile[];
  commit(plan: CommitPlan): Promise<Result<EditResult, EditFilesError>>;
  onDone(result: EditResult): void;
}

type Field =
  | "subject"
  | "body"
  | "files"
  | "target"
  | "branch"
  | "pull"
  | "submit";

/** `+ src/new.ts`, `~ src/lamp.ts`, `- old.md` — the change, in one column. */
const KIND_MARK: Record<CommitFile["kind"], string> = {
  add: "+",
  edit: "~",
  delete: "-",
};

/** `editFiles` errors are a union of bare codes and tagged objects. */
export function editErrorText(error: EditFilesError): string {
  if (typeof error === "string") return errorText(error);
  switch (error.kind) {
    case "protected_branch":
      return `${error.branch} is protected — commit to a new branch instead`;
    case "file_too_large":
      return `${error.path} is too large (${Math.round(error.bytes / 1024)} KB)`;
    case "commit_too_large":
      return "that commit is too large";
    case "too_many_files":
      return `too many files (${error.count})`;
    case "duplicate_path":
      return `${error.path} is named twice in this edit`;
    case "path_conflict":
      return `${error.path} collides with a file or directory already there`;
    case "branch_failed":
      return `the branch could not be created: ${errorText(error.reason)}`;
    case "pull_failed":
      return `committed, but the pull did not open: ${errorText(error.reason)}`;
    default:
      return errorText(error.kind);
  }
}

export function commitScreen(
  f: Session,
  ctx: Ctx,
  parent: Screen,
  o: CommitDialogOptions,
): Screen {
  let subject = o.subject;
  const body = new Textarea();
  let onNewBranch = true;
  let branchName = o.defaultBranchName;
  let openPull = false;
  let field: Field = "subject";
  let error = "";
  let busy = false;
  const all = o.files ?? [];
  const chosen = new Set(all.map((file) => file.path));
  let fileAt = 0;

  const fields = (): Field[] => [
    "subject",
    "body",
    ...(all.length > 0 ? (["files"] as Field[]) : []),
    "target",
    ...(onNewBranch ? (["branch", "pull"] as Field[]) : []),
    "submit",
  ];

  const step = (delta: number): void => {
    const list = fields();
    const at = Math.max(0, list.indexOf(field));
    field = list[(at + delta + list.length) % list.length]!;
  };

  const submit = (): void => {
    if (busy) return;
    if (subject.trim() === "") {
      error = "a commit message is required";
      field = "subject";
      return;
    }
    if (onNewBranch && branchName.trim() === "") {
      error = "a branch name is required";
      field = "branch";
      return;
    }
    if (all.length > 0 && chosen.size === 0) {
      error = "tick at least one file";
      field = "files";
      return;
    }
    busy = true;
    error = "";
    const plan: CommitPlan = {
      paths: all.filter((file) => chosen.has(file.path)).map((file) => file.path),
      message: body.isEmpty
        ? subject.trim()
        : `${subject.trim()}\n\n${body.value.trim()}`,
      ...(onNewBranch ? { newBranch: branchName.trim() } : {}),
      ...(onNewBranch && openPull
        ? {
            pull: {
              title: subject.trim(),
              ...(body.isEmpty ? {} : { body: body.value.trim() }),
            },
          }
        : {}),
    };
    runAsync(ctx, async () => {
      const done = await o.commit(plan);
      busy = false;
      if (!done.ok) {
        error = editErrorText(done.error);
        ctx.invalidate();
        return;
      }
      ctx.pop();
      const made = done.value;
      ctx.toast(
        made.pull === undefined
          ? `committed to ${made.branch}`
          : `committed to ${made.branch} · pull #${made.pull.number} opened`,
        "success",
      );
      o.onDone(made);
    });
  };

  return {
    title: o.title,
    get keys() {
      return [
        binding(["tab", "shift+tab"], "next field"),
        binding(["ctrl+s", "enter"], busy ? "committing…" : "commit"),
        binding(["space"], "toggle"),
        binding(["esc"], "cancel"),
      ];
    },
    render(area, s) {
      parent.render(area, s);
      const c = ctx.theme.c;
      // Tall enough for what is actually in it and no taller: two rows for
      // the frame, the message block, the change list, the target, and one
      // spare for the error line.
      const r = center(
        area,
        Math.min(66, area.w - 4),
        Math.min(
          all.length === 0 ? 20 : 17 + Math.min(all.length, 6),
          area.h,
        ),
      );
      const inner = card(s, r, c, {
        title: o.title,
        footer: `${o.repo.ownerName}/${o.repo.name}`,
        focused: true,
      });
      const [head, bodyBox, rest] = split(inner, "v", [
        len(2),
        len(Math.max(3, Math.min(5, inner.h - 11))),
        fill(1),
      ]);
      let caret: CursorPos | null = null;

      s.text(
        head!.x,
        head!.y,
        "Message",
        style(c.mutedFg, c.card),
        head!.x + head!.w,
      );
      const subjectCaret = input(s, { ...head!, y: head!.y + 1, h: 1 }, c, {
        value: subject,
        placeholder: "a one-line summary",
        focused: field === "subject",
        ...(field === "subject" ? { cursor: [...subject].length } : {}),
        ...(error !== "" && field === "subject" ? { invalid: true } : {}),
      });
      if (field === "subject") caret = subjectCaret;

      const bodyCaret = body.render(s, bodyBox!, c, field === "body");
      if (field === "body") caret = bodyCaret;
      if (body.isEmpty && field !== "body")
        s.text(
          bodyBox!.x + 2,
          bodyBox!.y,
          truncate("optional longer description", bodyBox!.w - 2),
          style(c.faint, c.card),
          bodyBox!.x + bodyBox!.w,
        );

      let y = rest!.y;
      const right = rest!.x + rest!.w;
      const line = (text: string, active: boolean, tone = c.fg): void => {
        if (y >= rest!.y + rest!.h) return;
        s.fill(
          { x: rest!.x, y, w: rest!.w, h: 1 },
          " ",
          style(c.fg, active ? c.muted : c.card),
        );
        s.text(
          rest!.x,
          y,
          truncate(text, rest!.w),
          style(tone, active ? c.muted : c.card, active ? BOLD : 0),
          right,
        );
        y++;
      };
      // The change itself, ticked on, before the questions about it: what is
      // going in is the thing to check, and a dialog that hid it behind a
      // count would be asking somebody to trust a number.
      if (all.length > 0) {
        line(
          `Files · ${chosen.size} of ${all.length}`,
          false,
          field === "files" ? c.fg : c.mutedFg,
        );
        const room = Math.max(1, rest!.y + rest!.h - y - 5);
        const from = Math.max(0, Math.min(fileAt - room + 1, all.length - room));
        for (let i = Math.max(0, from); i < all.length; i++) {
          const file = all[i]!;
          if (i >= from + room) {
            line(`  … ${all.length - i} more`, false, c.faint);
            break;
          }
          line(
            `[${chosen.has(file.path) ? "x" : " "}] ${KIND_MARK[file.kind]} ${file.path}`,
            field === "files" && i === fileAt,
            file.kind === "delete" ? c.danger : c.fg,
          );
        }
      }
      line(
        `${onNewBranch ? "( )" : "(o)"} commit to ${o.branch}`,
        field === "target" && !onNewBranch,
      );
      line(
        `${onNewBranch ? "(o)" : "( )"} commit to a new branch`,
        field === "target" && onNewBranch,
      );
      if (onNewBranch) {
        if (y < rest!.y + rest!.h) {
          const branchCaret = input(s, { x: rest!.x, y, w: rest!.w, h: 1 }, c, {
            value: branchName,
            placeholder: "branch name",
            focused: field === "branch",
            ...(field === "branch" ? { cursor: [...branchName].length } : {}),
          });
          if (field === "branch") caret = branchCaret;
          y++;
        }
        line(`[${openPull ? "x" : " "}] open a pull request`, field === "pull");
      }
      line(
        busy ? "  Committing…  " : "  Commit  ",
        field === "submit",
        c.accent,
      );
      if (error !== "" && y < rest!.y + rest!.h)
        s.text(
          rest!.x,
          y,
          truncate(error, rest!.w),
          style(c.danger, c.card),
          right,
        );
      ctx.setCursor(caret);
    },
    paste(text) {
      if (field === "body") body.paste(text);
      else if (field === "subject") subject += text.replace(/\s+/g, " ");
      else if (field === "branch") branchName += text.trim();
      return true;
    },
    key(e) {
      if (e.key === "esc") {
        ctx.pop();
        return true;
      }
      if (e.ctrl && e.key === "s") {
        submit();
        return true;
      }
      if (e.key === "tab") {
        step(e.shift ? -1 : 1);
        return true;
      }
      if (field === "body") {
        // The body is a real textarea, so Enter is a newline there and the
        // only way out is Tab — which is what every commit box does.
        body.key(e);
        return true;
      }
      if (field === "files") {
        if (e.key === "up" || e.key === "k")
          fileAt = Math.max(0, fileAt - 1);
        else if (e.key === "down" || e.key === "j")
          fileAt = Math.min(all.length - 1, fileAt + 1);
        else if (e.key === " ") {
          const file = all[fileAt];
          if (file !== undefined) {
            if (chosen.has(file.path)) chosen.delete(file.path);
            else chosen.add(file.path);
            error = "";
          }
        } else if (e.key === "enter") step(1);
        return true;
      }
      if (field === "target") {
        if (
          e.key === "up" ||
          e.key === "k" ||
          e.key === "down" ||
          e.key === "j" ||
          e.key === " "
        )
          onNewBranch = !onNewBranch;
        else if (e.key === "enter") step(1);
        return true;
      }
      if (field === "pull") {
        if (e.key === " " || e.key === "enter") openPull = !openPull;
        else if (e.key === "down") step(1);
        else if (e.key === "up") step(-1);
        return true;
      }
      if (field === "submit") {
        if (e.key === "enter" || e.key === " ") submit();
        else if (e.key === "up") step(-1);
        return true;
      }
      // The two plain text fields.
      const value = field === "subject" ? subject : branchName;
      const set = (next: string): void => {
        if (field === "subject") subject = next;
        else branchName = next;
        error = "";
      };
      if (e.key === "enter") {
        if (field === "subject") step(1);
        else submit();
        return true;
      }
      if (e.key === "backspace") {
        set([...value].slice(0, -1).join(""));
        return true;
      }
      if (e.key === "down") {
        step(1);
        return true;
      }
      if (e.key === "up") {
        step(-1);
        return true;
      }
      if (!e.ctrl && !e.alt && [...e.key].length === 1) {
        set(value + e.key);
        return true;
      }
      return true;
    },
  };
}

/** `alice/edit-src-main-ts` — the branch name the dialog offers by default. */
export function suggestBranch(
  f: Session,
  verb: string,
  slugged: string,
): string {
  const who = f.user?.username ?? "edit";
  return `${who}/${verb}-${slugged}`;
}
