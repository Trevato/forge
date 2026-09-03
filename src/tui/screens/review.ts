/**
 * The verdict card: approve, request changes, or just say something.
 *
 * A review is one decision and one optional paragraph, so it is one card and
 * not a screen — the pull is still behind it, which is the thing being judged.
 * Three radios rather than three keys, because the choice must be *visible*
 * before it is made: "did I just approve or request changes" is not a question
 * a reviewer should ever have to ask a toast.
 *
 * Approve is absent, not disabled, when the viewer wrote the change. The
 * server refuses it too (`submitReview` → `self_review`); the card simply
 * declines to offer a thing that cannot happen, which is the same rule every
 * other disabled-versus-absent binding in the terminal follows.
 */

import type { ReviewState } from "../../core/reviews.ts";
import type { Result } from "../../kernel/result.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { BOLD, style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { center, fill, len, split } from "../ui/layout.ts";
import { Textarea } from "../ui/textarea.ts";
import { card } from "../ui/widgets.ts";
import { runAsync } from "./common.ts";

/** What each verdict is called, in the order a reviewer thinks about them. */
const CHOICES: readonly { state: ReviewState; label: string }[] = [
  { state: "approved", label: "approve" },
  { state: "changes_requested", label: "request changes" },
  { state: "commented", label: "comment" },
];

export interface ReviewCardOptions {
  /** Drawn behind the card. */
  readonly parent: Screen;
  readonly title: string;
  /** False when the viewer is the author: approving is not on offer. */
  readonly mayApprove: boolean;
  /** The head the verdict is being passed on, for the footer. */
  readonly head: string;
  submit(input: {
    state: ReviewState;
    body: string;
  }): Promise<Result<unknown, string>>;
}

export function reviewScreen(ctx: Ctx, o: ReviewCardOptions): Screen {
  const choices = o.mayApprove
    ? CHOICES
    : CHOICES.filter((choice) => choice.state !== "approved");
  const body = new Textarea();
  let at = 0;
  let focus: "state" | "body" = "state";
  let error = "";
  let busy = false;

  const send = (): void => {
    if (busy) return;
    const chosen = choices[at];
    if (chosen === undefined) return;
    busy = true;
    error = "";
    runAsync(ctx, async () => {
      const done = await o.submit({ state: chosen.state, body: body.value });
      busy = false;
      if (!done.ok) {
        // Keep the text: a refused verdict must not cost somebody the
        // paragraph they wrote explaining it.
        error = done.error;
        ctx.invalidate();
        return;
      }
      ctx.pop();
    });
  };

  return {
    title: o.title,
    get keys() {
      return [
        binding(["left", "right"], "verdict"),
        binding(["tab"], focus === "state" ? "write a note" : "back"),
        binding(["ctrl+d"], busy ? "submitting…" : "submit"),
        binding(["esc"], "cancel"),
      ];
    },
    render(area, s) {
      o.parent.render(area, s);
      const c = ctx.theme.c;
      const r = center(area, Math.min(64, area.w - 4), Math.min(10, area.h));
      const inner = card(s, r, c, {
        title: o.title,
        footer:
          o.head === ""
            ? "ctrl+d submit · esc cancel"
            : `on ${o.head.slice(0, 8)} · ctrl+d submit · esc cancel`,
        focused: true,
      });
      const [row, note] = split(inner, "v", [len(2), fill(1)]);
      let x = row!.x;
      const right = row!.x + row!.w;
      choices.forEach((choice, i) => {
        const on = i === at;
        const active = on && focus === "state";
        x = s.text(
          x,
          row!.y,
          `${on ? "(o)" : "( )"} ${choice.label}`,
          style(
            on ? c.accent : c.mutedFg,
            active ? c.muted : c.card,
            active ? BOLD : 0,
          ),
          right,
        );
        x += 2;
      });
      const caret = body.render(s, note!, c, focus === "body");
      if (focus === "body") ctx.setCursor(caret);
      else ctx.setCursor(null);
      if (body.isEmpty && focus !== "body")
        s.text(
          note!.x + 2,
          note!.y,
          truncate("optional — why", Math.max(0, note!.w - 2)),
          style(c.faint, c.card),
          note!.x + note!.w,
        );
      if (error !== "")
        s.text(
          inner.x,
          inner.y + inner.h - 1,
          truncate(error, inner.w),
          style(c.danger, c.card),
          inner.x + inner.w,
        );
    },
    paste(text) {
      body.paste(text);
      return true;
    },
    key(e) {
      if (e.ctrl && e.key === "d") {
        send();
        return true;
      }
      if (e.key === "esc") {
        ctx.pop();
        return true;
      }
      if (e.key === "tab") {
        focus = focus === "state" ? "body" : "state";
        return true;
      }
      if (focus === "body") {
        const out = body.key(e);
        if (out === "submit") send();
        else if (out === "cancel") ctx.pop();
        return true;
      }
      if (e.key === "left" || e.key === "h" || e.key === "k" || e.key === "up")
        at = (at + choices.length - 1) % choices.length;
      else if (
        e.key === "right" ||
        e.key === "l" ||
        e.key === "j" ||
        e.key === "down"
      )
        at = (at + 1) % choices.length;
      else if (e.key === "enter" || e.key === " ") focus = "body";
      return true;
    },
  };
}
