/**
 * Editing a file in the terminal, and committing it.
 *
 * The editor itself is `ui/editor.ts`; this is the screen around it — the
 * status line, find and replace, and the one keystroke (`ctrl+s`) that turns a
 * buffer into a commit through `actions/contents.ts`. Nothing here writes a
 * byte: `editFiles` is the only path to the object store, it authorizes, it
 * refuses a protected default for a non-admin, and on a mirror it pushes the
 * commit upstream before the local ref moves. A screen that spawned git would
 * be a way around all three.
 *
 * `esc` with unsaved changes asks. An editor that discards work because a key
 * is overloaded with "go back" is an editor nobody trusts twice.
 */

import { editFiles } from "../../actions/contents.ts";
import type { RepoSource } from "../../view/source.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding, type Binding } from "../app/keys.ts";
import { style, BOLD } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { fill, len, split } from "../ui/layout.ts";
import { Editor } from "../ui/editor.ts";
import { input } from "../ui/widgets.ts";
import type { Session } from "../session.ts";
import { confirmScreen, promptScreen, slug } from "./common.ts";
import { commitScreen, suggestBranch } from "./commit.ts";
import { localRepo, sourceName } from "./where.ts";

export interface EditorScreenOptions {
  readonly ref: string;
  readonly path: string;
  readonly body: Uint8Array;
  /** Called after a successful commit, so the browser can re-read the file. */
  onSaved?(): void;
  /** A file that does not exist yet — the commit says "Add" not "Update". */
  readonly creating?: boolean;
}

type Mode = "edit" | "find" | "replace";

export function editorScreen(
  f: Session,
  ctx: Ctx,
  src: RepoSource,
  o: EditorScreenOptions,
): Screen {
  const buffer = new Editor(o.body, o.path);
  let mode: Mode = "edit";
  let needle = "";
  let replacement = "";
  let replaceField: "find" | "with" = "find";
  let note = "";

  const repo = localRepo(src);

  const commit = (): void => {
    if (repo === undefined) {
      ctx.toast(
        "this browse is read-only — W opens the workbench copy",
        "danger",
      );
      return;
    }
    if (buffer.readOnly) {
      ctx.toast(buffer.readOnlyReason, "attn");
      return;
    }
    const bytes = buffer.toBytes();
    const verb = o.creating === true ? "Add" : "Update";
    ctx.push(
      commitScreen(f, ctx, screen, {
        repo,
        branch: o.ref,
        title: `Commit ${o.path}`,
        subject: `${verb} ${o.path}`,
        defaultBranchName: suggestBranch(f, "edit", slug(o.path)),
        commit: (plan) =>
          editFiles(f.app, f.user, repo, {
            branch: o.ref,
            base: o.ref,
            ...(plan.newBranch === undefined
              ? {}
              : { newBranch: plan.newBranch }),
            message: plan.message,
            files: [{ path: o.path, content: bytes }],
            ...(plan.pull === undefined ? {} : { openPull: plan.pull }),
          }),
        onDone: () => {
          buffer.markSaved();
          o.onSaved?.();
        },
      }),
    );
  };

  const discard = (): void => {
    if (!buffer.modified) {
      ctx.pop();
      return;
    }
    ctx.push(
      confirmScreen(ctx, screen, {
        title: "Discard changes?",
        body: [
          `${o.path} has unsaved changes.`,
          "They are not committed anywhere.",
        ],
        actions: [
          { label: "Keep editing", variant: "ghost" },
          { label: "Discard", variant: "danger" },
        ],
        selected: 0,
        onChoose: (index) => {
          if (index === 1) ctx.pop();
        },
      }),
    );
  };

  const screen: Screen = {
    // The crumb trail already carries the path (the browser underneath is
    // titled with it); this says what is being done to it.
    title: o.creating === true ? "New file" : "Edit",
    get keys(): Binding[] {
      if (mode !== "edit")
        return [
          binding(["enter"], mode === "find" ? "next match" : "replace all"),
          ...(mode === "replace" ? [binding(["tab"], "find / with")] : []),
          binding(["esc"], "back to the text"),
        ];
      return [
        binding(["ctrl+s"], "commit", { disabled: buffer.readOnly }),
        binding(["ctrl+f"], "find"),
        binding(["ctrl+r"], "replace"),
        binding(["ctrl+z", "ctrl+y"], "undo/redo", {
          disabled: buffer.readOnly,
        }),
        binding(["ctrl+c", "ctrl+x", "ctrl+v"], "copy/cut/paste"),
        binding(["esc"], "close"),
      ];
    },
    render(area, s) {
      const c = ctx.theme.c;
      const [head, body, foot] = split(area, "v", [len(1), fill(1), len(1)]);
      const right = head!.x + head!.w;
      let x = s.text(
        head!.x,
        head!.y,
        truncate(sourceName(src), Math.max(0, head!.w - 20)),
        style(c.mutedFg, c.bg),
        right,
      );
      x = s.text(x, head!.y, " · ", style(c.faint, c.bg), right);
      s.text(
        x,
        head!.y,
        truncate(o.ref, Math.max(0, right - x)),
        style(c.accent, c.bg),
        right,
      );

      const caret = buffer.render(s, body!, c, mode === "edit");
      if (mode === "edit") ctx.setCursor(caret);

      s.fill(foot!, " ", style(c.mutedFg, c.muted));
      if (mode === "edit") {
        s.text(
          foot!.x + 1,
          foot!.y,
          buffer.statusFor(Math.max(0, foot!.w - 2)),
          style(
            buffer.modified ? c.attn : c.mutedFg,
            c.muted,
            buffer.modified ? BOLD : 0,
          ),
          foot!.x + foot!.w,
        );
        if (note !== "")
          s.text(
            foot!.x + foot!.w - note.length - 1,
            foot!.y,
            note,
            style(c.faint, c.muted),
            foot!.x + foot!.w,
          );
        return;
      }
      // Find / replace share the footer row rather than a floating box: the
      // text under it is the thing being searched, and covering it would be
      // the one thing a search box must not do.
      // "no match" belongs beside the box you typed into, not on a status
      // line the box is currently covering.
      const noteW = note === "" ? 0 : note.length + 2;
      if (noteW > 0)
        s.text(
          foot!.x + foot!.w - noteW + 1,
          foot!.y,
          note,
          style(c.attn, c.muted),
          foot!.x + foot!.w,
        );
      const room = Math.max(6, foot!.w - noteW);
      const half = mode === "replace" ? room >> 1 : room;
      const findCaret = input(s, { x: foot!.x, y: foot!.y, w: half, h: 1 }, c, {
        value: needle,
        placeholder: "find",
        focused: replaceField === "find",
        ...(replaceField === "find" ? { cursor: [...needle].length } : {}),
      });
      let withCaret = null;
      if (mode === "replace")
        withCaret = input(
          s,
          { x: foot!.x + half, y: foot!.y, w: room - half, h: 1 },
          c,
          {
            value: replacement,
            placeholder: "replace with",
            focused: replaceField === "with",
            ...(replaceField === "with"
              ? { cursor: [...replacement].length }
              : {}),
          },
        );
      ctx.setCursor(replaceField === "find" ? findCaret : withCaret);
    },
    paste(text) {
      if (mode === "edit") buffer.insert(text);
      else if (replaceField === "find") needle += text.replace(/\n/g, "");
      else replacement += text.replace(/\n/g, "");
      return true;
    },
    key(e) {
      if (mode !== "edit") {
        if (e.key === "esc") {
          mode = "edit";
          return true;
        }
        if (e.key === "tab" && mode === "replace") {
          replaceField = replaceField === "find" ? "with" : "find";
          return true;
        }
        if (e.key === "enter") {
          if (mode === "find") {
            note = buffer.seek(needle, !e.shift) ? "" : "no match";
          } else {
            const n = buffer.replaceAll(needle, replacement);
            note = `${n} replaced`;
            mode = "edit";
          }
          return true;
        }
        const value = replaceField === "find" ? needle : replacement;
        const set = (next: string): void => {
          if (replaceField === "find") needle = next;
          else replacement = next;
        };
        if (e.key === "backspace") {
          set([...value].slice(0, -1).join(""));
          return true;
        }
        if (!e.ctrl && !e.alt && [...e.key].length === 1) {
          set(value + e.key);
          return true;
        }
        return true;
      }

      if (e.ctrl && e.key === "s") {
        commit();
        return true;
      }
      if (e.ctrl && e.key === "f") {
        // A fresh box each time; `ctrl+g` is what repeats the last search.
        mode = "find";
        replaceField = "find";
        needle = "";
        note = "";
        return true;
      }
      if (e.ctrl && e.key === "r") {
        mode = "replace";
        replaceField = "find";
        needle = "";
        replacement = "";
        note = "";
        return true;
      }
      if (e.ctrl && e.key === "g") {
        note = buffer.seek(needle, true) ? "" : "no match";
        return true;
      }
      if (e.key === "esc") {
        discard();
        return true;
      }
      if (e.ctrl && e.key === "c") {
        // Copy goes to the editor's register *and* the user's own clipboard,
        // because over SSH those are two different places.
        const text = buffer.copy();
        ctx.copy(text);
        note = "copied";
        return true;
      }
      const handled = buffer.key(e);
      if (handled) note = "";
      return handled;
    },
  };
  return screen;
}

/**
 * `n` in the explorer: ask for a path, then open an empty buffer at it. The
 * file does not exist until the commit dialog says so — creating one is a
 * commit like any other, not a separate kind of act.
 */
export function newFileScreen(
  f: Session,
  ctx: Ctx,
  parent: Screen,
  _src: RepoSource,
  _ref: string,
  dir: string,
  onCreate: (path: string, body: Uint8Array) => void,
): Screen {
  return promptScreen(ctx, parent, {
    title: "New file",
    label: "path",
    value: dir === "" ? "" : `${dir}/`,
    placeholder: "src/thing.ts",
    hint: "the file is created by the commit, not by this prompt",
    onSubmit: (value) => {
      const path = value.replace(/^\/+/, "").trim();
      if (path === "" || path.endsWith("/")) return "give the file a name";
      onCreate(path, new Uint8Array(0));
      return undefined;
    },
  });
}

/**
 * A file that came back changed from an external editor. The bytes are already
 * on disk in a temp directory; all that is left is the commit, so this goes
 * straight to the dialog rather than back through the buffer.
 */
export function openSaved(
  f: Session,
  ctx: Ctx,
  src: RepoSource,
  ref: string,
  path: string,
  bytes: Uint8Array,
): void {
  const repo = localRepo(src);
  if (repo === undefined) {
    ctx.toast("this browse is read-only — nothing was written", "danger");
    return;
  }
  const blank: Screen = {
    title: path,
    keys: [],
    render: () => undefined,
    key: () => false,
  };
  ctx.push(
    commitScreen(f, ctx, blank, {
      repo,
      branch: ref,
      title: `Commit ${path}`,
      subject: `Update ${path}`,
      defaultBranchName: suggestBranch(f, "edit", slug(path)),
      commit: (plan) =>
        editFiles(f.app, f.user, repo, {
          branch: ref,
          base: ref,
          ...(plan.newBranch === undefined
            ? {}
            : { newBranch: plan.newBranch }),
          message: plan.message,
          files: [{ path, content: bytes }],
          ...(plan.pull === undefined ? {} : { openPull: plan.pull }),
        }),
      onDone: () => undefined,
    }),
  );
}
