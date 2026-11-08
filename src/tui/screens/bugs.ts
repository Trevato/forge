/**
 * Bugs on a clock in the terminal (#8709): the figure home's Open bugs tile
 * shows and the bug_clock alarm, from `flow/bugs.ts`. Gated as the page is:
 * the count is a person-admin's (the tile counts every repository), and any
 * other reader, an agent or a guest included, sees only the alarm cut to
 * public repositories (`publicOnly`). Read-only; Esc closes it.
 */

import { bugClockAlarm, countBugs } from "../../flow/bugs.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { style } from "../term/style.ts";
import { truncate, wrap } from "../term/width.ts";
import type { Session } from "../session.ts";
import { fill, len, split } from "../ui/layout.ts";
import type { PaletteEntry } from "./entries.ts";

/** What the screen says, one line each. */
export function bugLines(f: Session, now = new Date()): string[] {
  const admin = f.user?.isAdmin === true && f.user.kind !== "agent";
  const alarm = bugClockAlarm(f.db, now, admin ? {} : { publicOnly: true });
  const count = admin ? countBugs(f.db, now) : undefined;
  return [
    ...(count === undefined
      ? []
      : [`Open bugs: ${count.open}, ${count.overdue > 0 ? `${count.overdue} past its clock` : "none past its clock"}`, ""]),
    alarm.says,
    "",
    "Clocks: 4 h for a bug labelled high, 48 h otherwise.",
  ];
}

export function bugsScreen(f: Session, ctx: Ctx): Screen {
  return {
    title: "Bugs",
    keys: [],
    render(area, s) {
      const c = ctx.theme.c;
      const [body] = split(area, "v", [fill(1), len(0)]);
      const lines = bugLines(f).flatMap((l) => (l === "" ? [""] : wrap(l, Math.max(10, body!.w))));
      lines.slice(0, body!.h).forEach((l, i) =>
        s.text(body!.x, body!.y + i, truncate(l, body!.w), style(c.fg, c.bg), body!.x + body!.w),
      );
    },
    key: () => false,
  };
}

/** Offered to everyone: what a reader sees is cut inside, as the page cuts it. */
export const entry: PaletteEntry = {
  id: "bugs",
  title: "Bugs",
  hint: "open bugs and the bug clock",
  after: ["boards"],
  offered: () => true,
  run: (session, ctx) => ctx.push(bugsScreen(session, ctx)),
};
