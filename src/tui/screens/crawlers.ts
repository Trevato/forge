/**
 * What crawlers cost the forge in the terminal, a forge admin's who is a
 * person: their share of the last quarter hour's answering time, which budget
 * refused them, and each agent refused, as GET /api/v1/admin/crawlers says it.
 * Read-only.
 */

import { crawlReport } from "../../perf/crawlers.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { fill, len, split } from "../ui/layout.ts";
import { ListState, drawList, type ListRow } from "./common.ts";
import { mayCapacity } from "./capacity.ts";

export function crawlersScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  const lines = (): ListRow[] => {
    if (!mayCapacity(f)) return [];
    const r = crawlReport(f.app);
    const b = r.refused_by_budget;
    return [
      { title: `Share of answering time: ${Math.round(r.share * 100)}%`, meta: `${r.crawler_ms} of ${r.ms} ms, ${r.crawler_requests} of ${r.requests} requests, last ${r.window_minutes} min` },
      { title: `Browser-looking strangers on deep git pages: ${r.deep_stranger_requests} requests`, meta: `${r.deep_stranger_ms} ms, last ${r.window_minutes} min` },
      { title: "Refused (429) by budget", meta: `address ${b.address} · agent ${b.agent} · all crawlers ${b.shared} · browser strangers ${b.stranger}` },
      ...r.refused.map((a) => ({ title: a.agent, meta: `${a.refused} refused` })),
    ];
  };
  const screen: Screen = {
    title: "Crawlers",
    keys: [binding(["j", "k"], "move cursor")],
    render(area, s) {
      const c = ctx.theme.c;
      const [head, list] = split(area, "v", [len(1), fill(1)]);
      s.text(head!.x, head!.y, truncate("unauthenticated crawlers: counted per address, per agent, and all together", head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      drawList(s, list!, c, state, lines());
    },
    key(e) {
      return state.key(e, lines().length);
    },
  };
  return screen;
}
