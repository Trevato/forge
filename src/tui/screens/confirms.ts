/**
 * Confirms in the terminal (#7650): what the forge's agent asked to do and
 * waits for your yes, one sentence each, as Settings → Confirms lists them.
 * `y` says yes to the one under the cursor after a dialog that repeats the
 * sentence, through the same action the web and the API call
 * (`actions/conversation_confirms.ts`): it does the stored call once. A
 * result shown only once (a link, a credential) opens in a dialog and is not
 * kept in the conversation. `n` cancels the one under the cursor the same way
 * (`sayNo`): the confirm is spent, nothing runs, and the conversation says so.
 */

import { REFUSED, sayNo, sayYes, waitingConfirms } from "../../actions/conversation_confirms.ts";
import { ASKING } from "../../crew/conversation_confirm.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { fill, len, split } from "../ui/layout.ts";
import { ListState, ago, confirmScreen, drawList, linkScreen, runAsync, type ListRow } from "./common.ts";

export function confirmsScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  let note = "";
  const items = () => (f.user === undefined ? [] : waitingConfirms(f, f.user));

  const rows = (): ListRow[] =>
    items().map((w) => ({ title: w.does, secondary: w.tool, meta: `asked ${ago(w.createdAt)}` }));

  const screen: Screen = {
    title: "Confirms",
    keys: [binding(["j", "k"], "move cursor"), binding(["y"], "yes"), binding(["n"], "cancel")],
    render(area, s) {
      const c = ctx.theme.c;
      const [head, body] = split(area, "v", [len(1), fill(1)]);
      const text =
        note !== ""
          ? note
          : items().length === 0
            ? "Nothing waiting for your yes."
            : "What the forge's agent asked to do; y does it once, as you; n cancels it.";
      s.text(head!.x, head!.y, truncate(text, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      drawList(s, body!, c, state, rows());
    },
    key(e) {
      if (state.key(e, items().length)) return true;
      if (e.ctrl || e.alt || (e.key !== "y" && e.key !== "n")) return false;
      const w = items()[state.index];
      const user = f.user;
      if (w === undefined || user === undefined) return false;
      if (e.key === "n") {
        ctx.push(
          confirmScreen(ctx, screen, {
            title: "Cancel this",
            body: [w.does],
            actions: [{ label: "Keep", variant: "ghost" }, { label: "Cancel it", variant: "default" }],
            onChoose: (i) => {
              if (i !== 1) return;
              const no = sayNo(f, user, w.id);
              note = no.ok ? `Cancelled: ${w.tool}.` : `Nothing was done: ${REFUSED[no.error][1]}.`;
              ctx.invalidate();
            },
          }),
        );
        return true;
      }
      ctx.push(
        confirmScreen(ctx, screen, {
          title: "Say yes",
          body: [w.does, ...w.arguments.split("\n")],
          actions: [{ label: "Cancel", variant: "ghost" }, { label: "Yes", variant: "default" }],
          onChoose: (i) => {
            if (i !== 1) return;
            runAsync(ctx, async () => {
              const url = new URL(f.app.config.url ?? `http://${f.app.config.host ?? "localhost"}`);
              const yes = await sayYes(
                {
                  app: f.app,
                  request: new Request(url.href, { method: "POST" }),
                  url,
                  params: {},
                  auth: { user, scope: undefined, via: "none" as const },
                  theme: undefined,
                },
                user,
                w.id,
              );
              if (!yes.ok) note = `Nothing was done: ${REFUSED[yes.error][1]}.`;
              else if (!yes.done) note = `${w.tool} did not go through: ${String(yes.turn["message"] ?? yes.turn["error"])}`;
              else {
                const undo = typeof yes.turn["undo"] === "string" ? ` To undo: ${yes.turn["undo"]}.` : "";
                note = `Done: ${w.tool}.${undo}`;
                if (ASKING[w.tool]?.once !== undefined) ctx.push(linkScreen(ctx, JSON.stringify(yes.result), screen));
              }
              ctx.invalidate();
            });
          },
        }),
      );
      return true;
    },
  };
  return screen;
}
