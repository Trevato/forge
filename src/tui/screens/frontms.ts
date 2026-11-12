/**
 * The milestones at the front door as a screen (#1083): the few biggest open
 * milestones, each with how far it is, what landed in 7 days and its
 * estimate. The same read as the home's lines (`biggestMilestones` over
 * `frontApps`): a guest sees the public apps' only, a signed-in person their
 * own apps', and no spend, which is the owner's and has its own page. Enter
 * opens the milestone on the web.
 */

import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { biggestMilestones, frontApps, lineFacts } from "../../web/studio/milestone_lines.ts";
import { milestoneHref } from "../../web/pages/milestones.ts";
import { repoBase } from "../../web/chrome.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { fill, len, split } from "../ui/layout.ts";
import { ListState, drawList, openOnWeb, type ListRow } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

/** The lines the screen draws, read each time so a change shows on the next key. */
export function frontLines(f: Session) {
  return biggestMilestones(f, frontApps(f, f.user));
}

export function frontMilestonesScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  return {
    title: "Milestones",
    keys: [binding(["j", "k"], "move cursor"), binding(["enter"], "open on the web")],
    render(area, s) {
      const c = ctx.theme.c;
      const lines = frontLines(f);
      const [head, list] = split(area, "v", [len(1), fill(1)]);
      const note = lines.length === 0 ? "No open milestones." : f.user ? "The biggest open milestones of your apps." : "The biggest open milestones of the public apps.";
      s.text(head!.x, head!.y, truncate(note, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      const rows: ListRow[] = lines.map((r) => ({ title: r.limb.name, secondary: lineFacts(r, false) }));
      drawList(s, list!, c, state, rows);
    },
    key(e) {
      const lines = frontLines(f);
      if (state.key(e, lines.length)) return true;
      const at = lines[state.index];
      if (e.key === "enter" && !e.ctrl && !e.alt && at !== undefined) {
        openOnWeb(f, ctx, milestoneHref(repoBase(at.repo), at.limb.issue.number), "That milestone");
        return true;
      }
      return false;
    },
  };
}

/** Offered to everyone: what it lists is gated as the page's lines are. */
export const entry: PaletteEntry = {
  id: "front-milestones",
  title: "Milestones",
  hint: "the biggest open milestones: how far, what landed this week",
  after: ["now"],
  offered: () => true,
  run: (session, ctx) => ctx.push(frontMilestonesScreen(session, ctx)),
};
