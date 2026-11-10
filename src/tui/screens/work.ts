/**
 * "work (read-only)" in the terminal: the same data as the owner's profile
 * section (`readOnlyWork`, `src/origins/read-only-work.ts`) — each origin's
 * mirrors, their last fetch and, when it failed, why in one line.
 */

import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { readOnlyWork, type WorkOrigin } from "../../origins/read-only-work.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { Scroll } from "./common.ts";
import type { Session } from "../session.ts";

/** The section as text lines. */
export function workLines(origins: readonly WorkOrigin[]): string[] {
  if (origins.length === 0) return ["Nothing mirrored from a read-only origin."];
  return origins.flatMap((o, i) => [
    ...(i > 0 ? [""] : []),
    URL.parse(o.webUrl)?.host ?? o.webUrl,
    ...o.repos.map((r) =>
      `  ${r.fullName}  ${
        r.problem !== ""
          ? `Last fetch failed: ${r.problem}`
          : r.lastFetchAt === null
            ? "Not fetched yet"
            : `Last fetch ${r.lastFetchAt}`
      }`,
    ),
  ]);
}

export function workScreen(session: Session, ctx: Ctx): Screen {
  const scroll = new Scroll();
  let lines: string[] = [];
  return {
    title: "work (read-only)",
    keys: [binding(["j", "k"], "scroll"), binding(["esc"], "back")],
    render(area, s) {
      const c = ctx.theme.c;
      lines = session.user === undefined ? [] : workLines(readOnlyWork(session.app.db, session.user.id));
      const from = scroll.window(area.h, lines.length);
      for (let i = 0; i < area.h; i++) {
        const line = lines[from + i];
        if (line !== undefined) s.text(area.x + 1, area.y + i, truncate(line, area.w - 2), style(c.fg, c.bg), area.x + area.w);
      }
    },
    key(e) {
      if (e.key === "esc" || e.key === "q") {
        ctx.pop();
        return true;
      }
      return scroll.key(e, lines.length);
    },
  };
}

export const workCommand = (session: Session, ctx: Ctx) => ({
  id: "work",
  title: "work (read-only)",
  hint: "repositories mirrored from read-only origins, last fetch and why one failed",
  run: () => ctx.push(workScreen(session, ctx)),
});
