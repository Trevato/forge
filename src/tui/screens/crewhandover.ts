/**
 * The crew's hand-overs in the terminal, a forge admin's: the issues it
 * parked twice and the last restore drill, as Settings → Crew draws them
 * (`crewHandover`) — each section only when it has something to say.
 */

import { getRepo } from "../../core/repos.ts";
import { crewHandover } from "../../crew/handed.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { fill, len, split } from "../ui/layout.ts";
import { issueScreen } from "./issue.ts";
import { local } from "./where.ts";
import { ListState, drawList, type ListRow } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

export function crewHandoverScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  const allowed = f.user?.isAdmin === true;
  let parked: ReturnType<typeof crewHandover>["parked"] = [];
  let drill: ReturnType<typeof crewHandover>["drill"];
  const read = (): void => {
    ({ parked, drill } = allowed ? crewHandover(f.db) : { parked: [], drill: undefined });
  };
  // Read when the screen opens and on `r`, not per frame.
  read();
  const build = (): ListRow[] => [
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
  let rows = build();
  const open = (): void => {
    const p = parked[state.index];
    if (!allowed || p === undefined) return;
    const [owner, name] = p.repo.split("/");
    const repo = owner === undefined || name === undefined ? undefined : getRepo(f.db, owner, name);
    if (repo !== undefined) ctx.push(issueScreen(f, ctx, local(f, repo), p.number));
  };
  return {
    title: "Crew hand-overs",
    keys: [binding(["j", "k"], "move cursor"), binding(["enter"], "open"), binding(["r"], "refresh")],
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
    key(e) {
      if (e.ctrl || e.alt) return state.key(e, rows.length);
      if (e.key === "enter") {
        open();
        return true;
      }
      if (e.key === "r") {
        read();
        rows = build();
        state.clamp(rows.length);
        return true;
      }
      return state.key(e, rows.length);
    },
  };
}

/** Settings → Crew's hand-overs: issues parked twice, the last restore drill. */
export const entry: PaletteEntry = {
  id: "crew-handover",
  title: "Crew hand-overs",
  hint: "issues parked twice, and the last restore drill",
  after: ["crew-scorecard"],
  offered: (session) => session.user?.isAdmin === true,
  run: (session, ctx) => ctx.push(crewHandoverScreen(session, ctx)),
};
