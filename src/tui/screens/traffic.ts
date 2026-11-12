/**
 * Settings › Traffic in the terminal, a forge admin's who is a person: the
 * 15 minutes' requests and answering time, and the top readers by repository,
 * user agent, address prefix, country and signature, as /settings/traffic shows
 * them. Read-only; the 24 hour and 7 day charts are on the page.
 */

import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { trafficShare, TRAFFIC_WORDS } from "../../flow/kpi_words.ts";
import { perfRecord } from "../../perf/live.ts";
import { TRAFFIC_CLASSES } from "../../perf/traffic.ts";
import { trafficHistory } from "../../perf/traffic_store.ts";
import type { Session } from "../session.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { fill, len, split } from "../ui/layout.ts";
import { ListState, drawList, type ListRow } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

const may = (f: Session): boolean => f.user?.isAdmin === true && f.user.kind !== "agent";

export function trafficScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  const lines = (): ListRow[] => {
    if (!may(f)) return [];
    const t = trafficHistory(f.app.db, perfRecord.ledger, Date.now(), "15m");
    if (t.requests === 0) return [{ title: "No requests in the last 15 minutes", meta: "each finished minute is written down" }];
    const rows: ListRow[] = [
      { title: `${t.requests} requests, ${(t.ms / 1000).toFixed(1)} s of answering time`, meta: `${t.refused} refused, about ${t.addresses} client addresses` },
    ];
    for (const c of TRAFFIC_CLASSES)
      rows.push({ title: `Who: ${TRAFFIC_WORDS[c]}`, meta: `${trafficShare(t, t.classes[c].ms)} of time · ${t.classes[c].requests} requests · ${t.classes[c].refused} refused` });
    const kinds = [
      ["Repository read", t.tops.repos],
      ["User agent", t.tops.families],
      ["Address prefix", t.tops.prefixes],
      ["Country", t.tops.countries],
      ["Request signature", t.tops.signatures],
    ] as const;
    for (const [name, top] of kinds)
      for (const r of top) rows.push({ title: `${name}: ${r.key}`, meta: `${trafficShare(t, r.ms)} of time · ${r.requests} requests · ${r.anonymous} anonymous` });
    return rows;
  };
  return {
    title: "Traffic",
    keys: [binding(["j", "k"], "move cursor")],
    render(area, s) {
      const c = ctx.theme.c;
      const [head, list] = split(area, "v", [len(1), fill(1)]);
      s.text(head!.x, head!.y, truncate("who is using the forge's answering time, the last 15 minutes; 24 hours and 7 days are on the page", head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      drawList(s, list!, c, state, lines());
    },
    key(e) {
      return state.key(e, lines().length);
    },
  };
}

export const entry: PaletteEntry = {
  id: "traffic",
  title: "Traffic",
  hint: "who is using the forge's answering time, and the top readers",
  after: ["crawlers", "scrapes"],
  offered: may,
  run: (session, ctx) => ctx.push(trafficScreen(session, ctx)),
};
