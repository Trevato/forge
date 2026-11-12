/**
 * "Mirror the packs' upstreams" in the terminal (#10530): the button on
 * /packs, through the same action (`packs/mirror.ts`). Offered to site admins
 * only; the action refuses anyone else. Enter runs it, Esc or q closes.
 */

import { MIRROR_FORBIDDEN, mirrorPacks, reportWords } from "../../packs/mirror.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { wrap } from "../term/width.ts";
import { dialog } from "../ui/widgets.ts";
import { runAsync } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

const WIDTH = 72;
const INNER = WIDTH - 6;

export function mirrorPacksScreen(f: Session, ctx: Ctx): Screen {
  let note = "";
  let busy = false;
  const go = (): void => {
    if (busy) return;
    busy = true;
    note = "Working…";
    ctx.invalidate();
    runAsync(ctx, async () => {
      try {
        const done = await mirrorPacks(f.app, f.user);
        note = done.ok ? reportWords(done.value) : MIRROR_FORBIDDEN;
      } finally {
        busy = false;
        ctx.invalidate();
      }
    });
  };
  return {
    title: "Mirror the packs' upstreams",
    keys: [...(busy ? [] : [binding(["enter"], "mirror")]), binding(["esc", "q"], "close")],
    render(area, s) {
      const buttons = dialog(s, area, ctx.theme.c, {
        title: "Mirror the packs' upstreams",
        body: [
          ...wrap("Copy each pack's upstream projects here as read-only packs/<app> repositories that keep up with the original. Press Enter to run it; running it again makes nothing new.", INNER),
          ...(note === "" ? [] : ["", ...wrap(note, INNER)]),
        ],
        actions: [{ label: "Mirror" }, { label: "Close" }],
        selected: 0,
        width: WIDTH,
      });
      buttons[0] && ctx.hit(buttons[0], go);
      buttons[1] && ctx.hit(buttons[1], () => ctx.pop());
    },
    key(e) {
      if (e.ctrl || e.alt) return true;
      if (e.key === "esc" || e.key === "q") ctx.pop();
      else if (e.key === "enter") go();
      return true;
    },
  };
}

/** Bring the packs' upstreams in as read-only mirrors: a site admin's, as the button on /packs is. */
export const entry: PaletteEntry = {
  id: "mirror-packs",
  title: "Mirror the packs' upstreams",
  hint: "bring each pack's upstream projects in as read-only repositories",
  after: ["packs"],
  offered: (session) => session.user?.isAdmin === true && session.user.kind !== "agent",
  run: (session, ctx) => ctx.push(mirrorPacksScreen(session, ctx)),
};
