/**
 * Who comes back, in the terminal (#11265): the same figures as the block on
 * Settings → Traffic (`perf/visitor_report.ts`), for a forge admin only, and
 * `t` turns the setting `traffic.returning` on or off. The setting is the one
 * row the web page reads on every request, so a change here is seen there at once.
 */

import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { ledReport, visitorsReport } from "../../perf/visitor_report.ts";
import { getReturning, setReturning } from "../../settings/returning.ts";
import type { Session } from "../session.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { fill, len, split } from "../ui/layout.ts";
import { ListState, drawList, type ListRow } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

const DAYS = 30;
const may = (f: Session): boolean => f.user?.isAdmin === true && f.user.kind !== "agent";

export function returningLines(f: Session, now = Date.now()): ListRow[] {
  if (!may(f)) return [];
  if (!getReturning(f.db)) return [{ title: "Off: no visitor id is kept for this forge's visitors", meta: "t turns it on" }];
  const r = visitorsReport(f.db, DAYS, now);
  const rows: ListRow[] = [{ title: `${r.newVisitors} new and ${r.returningVisitors} returning visitors in the last ${r.days} days`, meta: "returning is two visits or more" }];
  for (const v of r.returning)
    rows.push({
      title: `${v.id}${v.probable ? " (guessed)" : ""}: ${v.visits} visits`,
      meta: `first ${v.firstSeen} from ${v.firstRef} · last ${v.lastSeen} · got as far as ${v.step}`,
    });
  for (const l of ledReport(f.db))
    rows.push({ title: `Forge ${l.forge}: ${l.step}`, meta: `first came from ${l.firstRef} on ${l.firstSeen} · ${l.visits.map((v) => `${v.day} ${v.pages.join(" → ")}`).join("; ")}` });
  return rows;
}

export function returningScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  return {
    title: "Who comes back",
    keys: [binding(["j", "k"], "move cursor"), binding(["t"], "turn on or off")],
    render(area, s) {
      const c = ctx.theme.c;
      const [head, list] = split(area, "v", [len(1), fill(1)]);
      s.text(head!.x, head!.y, truncate(`visitor ids for this forge: ${getReturning(f.db) ? "on" : "off"}; a visitor with no cookie is guessed`, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      drawList(s, list!, c, state, returningLines(f));
    },
    key(e) {
      if (!may(f)) return false;
      if (e.key === "t") {
        const to = !getReturning(f.db);
        setReturning(f.db, to, f.user!.id);
        ctx.toast(to ? "Returning visitors are on." : "Returning visitors are off.", "success");
        return true;
      }
      return state.key(e, returningLines(f).length);
    },
  };
}

export const entry: PaletteEntry = {
  id: "returning-visitors",
  title: "Who comes back",
  hint: "new and returning visitors, and the setting that keeps them",
  after: ["traffic"],
  offered: may,
  run: (session, ctx) => ctx.push(returningScreen(session, ctx)),
};
