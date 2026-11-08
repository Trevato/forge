/**
 * Your phone notify URL in the terminal: the host notifications go to, or
 * that they are off. `s` asks for a URL and saves it, `t` sends a test
 * line, `x` turns it off after a confirm. The URL may carry a secret in
 * its path (an ntfy topic is a password), so only its host is ever drawn;
 * the rules and the words are `crew/notify.ts`'s, as Settings and MCP
 * `notify` use them.
 */

import { NOTIFY_ERRORS, claimTest, notifyHost, notifyUrlOf, post, sendTest, setNotifyUrl, type Sender } from "../../crew/notify.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { confirmScreen, promptScreen } from "./common.ts";

/** The sender `t` uses; a test swaps it for a fake. */
export const testSender: { current: Sender } = { current: post };

export function notifyScreen(f: Session, ctx: Ctx): Screen {
  let note = "";
  const host = () =>
    f.user === undefined ? undefined : notifyHost(notifyUrlOf(f.app.db, f.user.id));
  const save = (raw: string) => {
    if (f.user === undefined) return undefined;
    const done = setNotifyUrl(f.app.db, f.user.id, raw);
    if (!done.ok) return NOTIFY_ERRORS[done.error];
    f.app.bus.append({ kind: "account.notify_set", actorId: f.user.id });
    note = done.value === "set" ? "Saved." : "Turned off.";
    return undefined;
  };

  const screen: Screen = {
    title: "Phone notifications",
    get keys() {
      return [
        binding(["s"], "set the URL"),
        ...(host() === undefined ? [] : [binding(["t"], "send a test")]),
        binding(["x"], "turn off"),
      ];
    },
    render(area, s) {
      const c = ctx.theme.c;
      const h = host();
      const lines = [
        h === undefined ? "Off. s sets a URL (an ntfy topic, https)." : `On: notifications go to ${h}.`,
        "The address is a secret and is never shown past its host.",
        ...(note === "" ? [] : ["", note]),
      ];
      lines.forEach((l, i) => {
        if (i < area.h) s.text(area.x, area.y + i, truncate(l, area.w), style(c.mutedFg, c.bg), area.x + area.w);
      });
    },
    key(e) {
      if (e.ctrl || e.alt) return false;
      if (e.key === "s") {
        ctx.push(
          promptScreen(ctx, screen, {
            title: "Phone notifications",
            label: "an https URL that takes a POST",
            mask: true,
            onSubmit: (raw) => {
              if (raw.trim() === "") return "Type a URL, or x to turn it off.";
              return save(raw);
            },
          }),
        );
        return true;
      }
      if (e.key === "t") {
        const h = host();
        if (h === undefined || f.user === undefined) return true;
        if (!claimTest(f.user.id)) {
          ctx.toast("just sent — wait a moment");
          return true;
        }
        const id = f.user.id;
        void sendTest(f.app.db, id, testSender.current).then((r) => {
          if (r === "sent") ctx.toast(`sent to ${h}`);
          else ctx.toast(`${h} did not take it`, "danger");
          ctx.invalidate();
        });
        return true;
      }
      if (e.key === "x") {
        if (host() === undefined) {
          note = "Already off.";
          ctx.invalidate();
          return true;
        }
        ctx.push(
          confirmScreen(ctx, screen, {
            title: "Turn off phone notifications",
            body: [`Stop sending to ${host()}?`],
            actions: [{ label: "Cancel", variant: "ghost" }, { label: "Turn off", variant: "danger" }],
            onChoose: (i) => {
              if (i !== 1) return;
              save("");
              ctx.invalidate();
            },
          }),
        );
        return true;
      }
      return false;
    },
  };
  return screen;
}
