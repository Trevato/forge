/**
 * "Start my forge" in the terminal: the home page's start form for a guest.
 * One field, the name; **Enter** goes through `spawnDoor` as a stranger, as
 * `POST /forges/start` does, so the free plan, the name rules and the visitor
 * limits are the door's (counted under the SSH client's address). A refusal is
 * one of the fixed sentences the home page shows (`web/start_refusal.ts`); a
 * made forge's claim link is shown once and kept nowhere. Signed in, "New
 * forge" is the fuller form, so this command is a guest's.
 */

import { notePeer } from "../../http/peer.ts";
import { spawnDoor } from "../../spawn/door.ts";
import { START_REFUSALS, startRefusalOf } from "../../web/start_refusal.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate, wrap } from "../term/width.ts";
import { field } from "../ui/widgets.ts";
import type { Session } from "../session.ts";
import { linkScreen, runAsync } from "./common.ts";

const HINT = "Lowercase letters, digits and dashes. Enter starts it.";

export function startForgeScreen(f: Session, ctx: Ctx): Screen {
  let name = "";
  let error: string | undefined;
  let busy = false;

  const start = (): void => {
    if (busy) return;
    busy = true;
    error = undefined;
    runAsync(ctx, async () => {
      try {
        const url = new URL(f.app.config.url ?? `http://${f.app.config.host ?? "localhost"}`);
        const request = new Request(new URL("/forges/start", url).href, { method: "POST" });
        notePeer(request, f.identity.remoteAddress);
        const hctx = { app: f.app, request, url, params: {}, auth: { user: undefined, scope: undefined, via: "none" as const }, theme: undefined };
        const made = await spawnDoor(hctx, undefined, { name: name.trim().toLowerCase(), dryRun: false });
        const link = made.body["claimUrl"];
        if (made.status >= 400 || typeof link !== "string") {
          error = START_REFUSALS[made.status >= 400 ? startRefusalOf(made) : "taken"];
          return;
        }
        ctx.toast(`${String(made.body["name"] ?? name)} is ready`, "success");
        ctx.replace(linkScreen(ctx, link));
      } finally {
        busy = false;
        ctx.invalidate();
      }
    });
  };

  return {
    title: "Start my forge",
    keys: [binding(["enter"], "start"), binding(["esc"], "back")],
    render(area, s) {
      const c = ctx.theme.c;
      s.text(area.x, area.y, truncate("Start your own forge, free. Next you choose a username and password.", area.w), style(c.fg, c.bg), area.x + area.w);
      const at = field(s, { x: area.x, y: area.y + 2, w: Math.min(60, area.w), h: 3 }, c, {
        label: "Forge name",
        value: name,
        focused: true,
        cursor: [...name].length,
        hint: busy ? "Setting up…" : HINT,
      });
      if (error !== undefined)
        wrap(error, Math.max(20, Math.min(60, area.w))).forEach((line, i) => {
          if (6 + i < area.h) s.text(area.x, area.y + 6 + i, line, style(c.danger, c.bg), area.x + area.w);
        });
      ctx.setCursor(at);
    },
    paste(text) {
      name += text.replace(/\s+/g, "");
      error = undefined;
      return true;
    },
    key(e) {
      if (e.key === "esc") {
        ctx.pop();
        return true;
      }
      if (e.key === "enter") {
        start();
        return true;
      }
      if (e.key === "backspace") {
        name = [...name].slice(0, -1).join("");
        error = undefined;
        return true;
      }
      if (!e.ctrl && !e.alt && [...e.key].length === 1 && e.key !== " ") {
        name += e.key;
        error = undefined;
        return true;
      }
      return false;
    },
  };
}

/** A guest's: a signed-in person has "New forge". */
export const startForgeCommand = (session: Session, ctx: Ctx) =>
  session.signedIn
    ? []
    : [{ id: "start-forge", title: "Start my forge", hint: "a free forge of your own; you choose a username and password next", run: () => ctx.push(startForgeScreen(session, ctx)) }];
