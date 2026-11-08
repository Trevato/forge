/**
 * What was scraped, in the terminal, a forge admin's who is a person: the last
 * day's reads by repository (paths, commits, key-looking files) and the groups
 * of requests a running capture sees, as /settings/traffic/scrapes shows them.
 * Read-only: a capture is started and exported on the page, where the abuse
 * report is a download.
 */

import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { groupRequests } from "../../perf/actors.ts";
import { captureStore, readLedger } from "../../perf/live.ts";
import { readsReport } from "../../perf/reads.ts";
import type { Session } from "../session.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { fill, len, split } from "../ui/layout.ts";
import { ListState, drawList, type ListRow } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

const may = (f: Session): boolean => f.user?.isAdmin === true && f.user.kind !== "agent";

export function scrapesScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  const lines = (): ListRow[] => {
    if (!may(f)) return [];
    const rows: ListRow[] = readsReport(f.app.db, readLedger, Date.now(), 1).map((r) => ({
      title: r.repo,
      meta: `${r.requests} reads (${r.anonymous} anonymous) · ${r.paths} paths${r.secrets.length > 0 ? ` · ${r.secrets.length} key-looking: ${r.secrets.map((s) => s.path).slice(0, 3).join(", ")}` : ""}`,
    }));
    const cap = captureStore.current(Date.now());
    if (cap !== null)
      for (const g of groupRequests(cap.entries).filter((x) => x.size >= 3))
        rows.push({ title: `Group ${g.id}: ${g.size} requests from ${g.addresses.length} addresses`, meta: `confidence ${g.confidence}` });
    return rows;
  };
  return {
    title: "Scrapes",
    keys: [binding(["j", "k"], "move cursor")],
    render(area, s) {
      const c = ctx.theme.c;
      const [head, list] = split(area, "v", [len(1), fill(1)]);
      s.text(head!.x, head!.y, truncate("reads in the last day, and groups in a running capture; networks and the abuse export are on the page", head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      drawList(s, list!, c, state, lines());
    },
    key(e) {
      return state.key(e, lines().length);
    },
  };
}

export const entry: PaletteEntry = {
  id: "scrapes",
  title: "Scrapes",
  hint: "what was read by repository, and groups in a running capture",
  after: ["crawlers", "limits"],
  offered: may,
  run: (session, ctx) => ctx.push(scrapesScreen(session, ctx)),
};
