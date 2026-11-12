/** What this forge's cores mean for builds, in the terminal (#11694): the Settings row's own words (`coresLine`). Admins only, as the row is. */

import { coresLine } from "../../spawn/cores.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { style } from "../term/style.ts";
import { wrap } from "../term/width.ts";
import type { Session } from "../session.ts";
import type { PaletteEntry } from "./entries.ts";

export function coresScreen(f: Session, ctx: Ctx, line: string | undefined = coresLine()): Screen {
  const allowed = f.user?.isAdmin === true;
  return {
    title: "Cores",
    keys: [],
    render(area, s) {
      const c = ctx.theme.c;
      const text = !allowed ? "Only admins see this." : (line ?? "This forge is no sized child: its cores are the machine's.");
      wrap(text, Math.max(20, area.w - 2)).forEach((l, i) => {
        if (i < area.h) s.text(area.x + 1, area.y + i, l, style(c.fg, c.bg), area.x + area.w);
      });
    },
    key: () => false,
  };
}

export const entry: PaletteEntry = {
  id: "cores",
  title: "Cores",
  hint: "what this forge's cores mean for builds",
  after: ["plan-row", "limits"],
  offered: (session) => session.user?.isAdmin === true && coresLine() !== undefined,
  run: (session, ctx) => {
    if (session.user?.isAdmin === true) ctx.push(coresScreen(session, ctx));
  },
};
