/**
 * Every repository's flows in the terminal (#9594): the rows of the web page
 * `/admin/flows` (`flows/all.ts`), gated the same way. A site admin who is a
 * person is offered it in the palette and sees every line; anyone else is
 * offered nothing and, were the screen reached, sees no rows.
 *
 * `k` cycles the kind filter, `s` flips stale only. Read-only.
 */

import { ALL_KINDS, readAllFlows, type AllKind } from "../../flows/all.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { style } from "../term/style.ts";
import { pad } from "../term/width.ts";
import { Scroll, drawLines, hitScroll } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

const mayRead = (session: Session): boolean => session.user?.isAdmin === true && session.user.kind !== "agent";

/** Lines drawn at once, as on the page. */
const SHOWN = 500;

/** The header, then a line a row; empty for anyone the gate refuses. */
export function flowLines(session: Session, kind?: AllKind, stale = false, now = Date.now()): string[] {
  if (!mayRead(session)) return [];
  const rows = readAllFlows(session.db, { ...(kind ? { kind } : {}), stale }, now).slice(0, SHOWN);
  return [
    `${pad("Repository", 28)}${pad("Kind", 10)}${pad("State", 34)}Last moved`,
    ...rows.map((l) => `${pad(l.repo, 28)}${pad(l.kind, 10)}${pad(l.state, 34)}${l.at ?? "never moved"}`),
  ];
}

export function flowsAllScreen(session: Session, ctx: Ctx): Screen {
  const scroll = new Scroll();
  let kind: AllKind | undefined;
  let stale = false;
  return {
    title: "Flows across the forge",
    keys: [binding(["j", "k"], "scroll"), binding(["f"], "kind"), binding(["s"], "stale only"), binding(["esc", "q"], "back")],
    render(area, s) {
      const c = ctx.theme.c;
      const lines = flowLines(session, kind, stale);
      const head = `Kind: ${kind ?? "all"} · ${stale ? "stale only" : "all states"}`;
      const spans = [head, ...lines].map((text, i) => [{ text, style: style(i <= 1 ? c.fg : c.mutedFg, c.bg) }]);
      drawLines(s, area, c, scroll, spans);
      hitScroll(ctx, area, scroll, spans.length);
    },
    key(e) {
      if (scroll.key(e, flowLines(session, kind, stale).length + 1)) return true;
      if (e.key === "f") {
        const i = kind === undefined ? -1 : ALL_KINDS.indexOf(kind);
        kind = ALL_KINDS[i + 1];
        return true;
      }
      if (e.key === "s") {
        stale = !stale;
        return true;
      }
      if (e.key === "esc" || e.key === "q") {
        ctx.pop();
        return true;
      }
      return false;
    },
  };
}

export const entry: PaletteEntry = {
  id: "flows-all",
  title: "Flows across the forge",
  hint: "every repository's flow lines, by kind and stale",
  after: ["limits"],
  offered: mayRead,
  run: (session, ctx) => ctx.push(flowsAllScreen(session, ctx)),
};
