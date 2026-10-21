/**
 * The crew's hand-overs in the terminal, a forge admin's: the issues it
 * parked twice and the last restore drill, as Settings → Crew draws them
 * (`crewHandover`) — each section only when it has something to say.
 */

import { crewHandover } from "../../crew/handed.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { fill, len, split } from "../ui/layout.ts";
import { ListState, drawList, type ListRow } from "./common.ts";

export function crewHandoverScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  const allowed = f.user?.isAdmin === true;
  // Read once when the screen opens, not per frame.
  const { parked, drill } = allowed ? crewHandover(f.db) : { parked: [], drill: undefined };
  const rows: ListRow[] = [
    ...parked.map((r) => ({
      title: `Handed to the planner: ${r.repo}#${r.number} ${r.title}`,
      secondary: `parked ${r.at.slice(0, 16).replace("T", " ")} UTC`,
      meta: r.reasons.join(" · "),
    })),
    ...(drill === undefined
      ? []
      : [
          {
            title: `Restore drill: ${drill.verdict === "green" ? "passed" : "failed"}`,
            secondary: drill.at.slice(0, 16).replace("T", " ") + " UTC",
            meta: "",
          },
        ]),
  ];
  return {
    title: "Crew hand-overs",
    keys: [binding(["j", "k"], "move cursor")],
    render(area, s) {
      const c = ctx.theme.c;
      const [head, list] = split(area, "v", [len(1), fill(1)]);
      const text = !allowed
        ? "The crew's hand-overs are read by a forge admin."
        : rows.length === 0
          ? "Nothing handed to the planner, and no restore drill yet."
          : "Issues the crew parked twice, and the last restore drill.";
      s.text(head!.x, head!.y, truncate(text, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      drawList(s, list!, c, state, rows);
    },
    key: (e) => state.key(e, rows.length),
  };
}
