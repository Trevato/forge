/**
 * Writing the message. A subject field and a body, because that is what a
 * commit message is — and because a screen that shows the 50-column mark
 * produces better subjects than a comment in a template ever has.
 *
 * `ctrl+d` commits, matching the forge's own long-form editors; there is no
 * "save and quit" ceremony because there is no file.
 */

import type { Diff } from "../../git/diff.ts";
import * as git from "../../git/local.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding, type Binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { displayWidth, truncate } from "../term/width.ts";
import { fill, len, split } from "../ui/layout.ts";
import { Textarea } from "../ui/textarea.ts";
import { card, input, spinner } from "../ui/widgets.ts";
import { SEP, Task } from "./common.ts";

/** Git's own convention, and the width every log viewer assumes. */
const SUBJECT_LIMIT = 50;

export interface CommitOpts {
  readonly amend: boolean;
  readonly onDone: () => Promise<void> | void;
}

export function commitScreen(ctx: Ctx, dir: string, o: CommitOpts): Screen {
  const body = new Textarea();
  const task = new Task(ctx);
  let subject = "";
  let focus: "subject" | "body" = "subject";
  let staged = "";

  const submit = (): void => {
    const text = subject.trim();
    if (text === "") {
      ctx.toast("a subject is required", "danger");
      return;
    }
    const message = body.isEmpty ? text : `${text}\n\n${body.value.trim()}\n`;
    task.run(
      o.amend ? "amending" : "committing",
      () => git.commit(dir, message, { amend: o.amend }),
      async (oid) => {
        ctx.pop();
        ctx.toast(`committed ${oid.slice(0, 8)}`, "success");
        await o.onDone();
      },
    );
  };

  return {
    title: o.amend ? "Amend" : "Commit",
    get keys(): Binding[] {
      return [
        binding(["tab"], "subject / body"),
        binding(["ctrl+d"], o.amend ? "amend" : "commit"),
        binding(["esc"], "cancel"),
      ];
    },
    async load() {
      // What is actually about to be committed, in one line. Writing a
      // message for a diff you cannot see is how "fix tests" gets written
      // over a thirty-file refactor.
      const diff = await git.diff(dir, { staged: true, context: 1 });
      if (diff.ok) staged = statLine(diff.value);
      // An amend starts from the message it is replacing; anything else is
      // an invitation to retype what you already wrote.
      if (o.amend) {
        const head = await git.headMessage(dir);
        if (head.ok) {
          const [first = "", ...rest] = head.value.split("\n");
          subject = first;
          body.setValue(rest.join("\n").replace(/^\n+/, ""));
        }
      }
      ctx.invalidate();
    },
    render(area, s) {
      const c = ctx.theme.c;
      const inner = card(s, area, c, {
        title: o.amend ? "Amend the last commit" : "Commit",
        focused: true,
      });
      const [head, stat, gap, text] = split(inner, "v", [
        len(2),
        len(1),
        len(1),
        fill(1),
      ]);
      const cursor = input(s, { ...head!, h: 1 }, c, {
        value: subject,
        placeholder: "a short summary",
        focused: focus === "subject",
        invalid: displayWidth(subject) > SUBJECT_LIMIT,
        ...(focus === "subject" ? { cursor: [...subject].length } : {}),
      });
      const over = displayWidth(subject) - SUBJECT_LIMIT;
      s.text(
        head!.x,
        head!.y + 1,
        over > 0
          ? `${over} over the 50-column subject line`
          : `${SUBJECT_LIMIT - displayWidth(subject)} left`,
        style(over > 0 ? c.attn : c.faint, c.card),
        head!.x + head!.w,
      );
      if (task.busy) {
        const x = spinner(s, stat!.x, stat!.y, c, ctx.tick);
        s.text(
          x + 1,
          stat!.y,
          truncate(task.note, Math.max(0, stat!.w - 2)),
          style(c.accent, c.card),
          stat!.x + stat!.w,
        );
      } else
        s.text(
          stat!.x,
          stat!.y,
          truncate(staged, stat!.w),
          style(c.mutedFg, c.card),
          stat!.x + stat!.w,
        );
      s.text(
        gap!.x,
        gap!.y,
        truncate("Body — the why, wrapped", gap!.w),
        style(c.mutedFg, c.card),
        gap!.x + gap!.w,
      );
      const bodyCursor = body.render(s, text!, c, focus === "body");
      ctx.setCursor(focus === "subject" ? cursor : bodyCursor);
    },
    paste(chunk) {
      if (focus === "body") {
        body.paste(chunk);
        return true;
      }
      // A pasted message is a subject and a body: the first line stays in
      // the field, the rest moves to the body, where the cursor follows.
      const [first = "", ...rest] = chunk.replace(/\r\n?/g, "\n").split("\n");
      subject += first.replace(/\s+/g, " ");
      const more = rest.join("\n").replace(/^\n+/, "");
      if (more.trim() !== "") {
        body.paste(more);
        focus = "body";
      }
      return true;
    },
    key(e) {
      if (task.blocked) return true;
      if (e.key === "esc") {
        ctx.pop();
        return true;
      }
      if (e.ctrl && e.key === "d") {
        submit();
        return true;
      }
      if (e.key === "tab") {
        focus = focus === "subject" ? "body" : "subject";
        return true;
      }
      if (focus === "body") {
        const event = body.key(e);
        if (event === "submit") submit();
        return event !== "ignored";
      }
      if (e.key === "enter") {
        focus = "body";
        return true;
      }
      if (e.key === "backspace") {
        subject = [...subject].slice(0, -1).join("");
        return true;
      }
      if (!e.ctrl && !e.alt && [...e.key].length === 1) {
        subject += e.key;
        return true;
      }
      return true;
    },
  };
}

/** "3 files · +42 -7 staged", or what to do about there being none. */
function statLine(diff: Diff): string {
  const files = diff.files.length;
  if (files === 0) return "nothing staged";
  const noun = files === 1 ? "file" : "files";
  return `${files} ${noun} ${SEP} +${diff.additions} -${diff.deletions} staged`;
}
