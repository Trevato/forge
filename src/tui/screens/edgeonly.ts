/**
 * Edge-only accounts in the terminal, a forge admin's: the same dry run the
 * Capacity page and the API run (`edgeOffDryRun`): how many sign in without
 * the platform edge, who would be locked out if `signin.edge` went off, and
 * whether that includes the admin looking. Names the people the Accounts card
 * names, from the same `signinReach`. Changes nothing.
 */

import { edgeOffDryRun } from "../../actions/capacity.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { fill, len, split } from "../ui/layout.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { emptyState } from "../ui/widgets.ts";
import { ListState, drawList, type ListRow } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

const isAdmin = (f: Session): boolean => f.user?.isAdmin === true && f.user.kind !== "agent";

export function edgeOnlyScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  const dry = edgeOffDryRun(f.db, f.user);
  const accounts = dry.ok ? dry.value.lockedOut : [];
  const summary = dry.ok
    ? `${dry.value.own} of ${dry.value.total} can sign in without the edge${dry.value.youLockedOut ? "; you would be locked out too, so the switch is refused" : ""}`
    : "";
  return {
    title: "Edge-only accounts",
    keys: [binding(["j", "k"], "move cursor")],
    render(area, s) {
      const c = ctx.theme.c;
      const [head, body] = split(area, "v", [len(1), fill(1)]);
      if (accounts.length === 0) {
        emptyState(s, body!, c, { title: "Nobody would be locked out.", body: summary });
        return;
      }
      const line = `${summary}; ask each to add a passkey`;
      s.text(head!.x, head!.y, truncate(line, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      const rows: ListRow[] = accounts.map((a) => ({
        title: a.username,
        secondary: "",
        meta: a.isAdmin ? "admin" : "",
      }));
      drawList(s, body!, c, state, rows);
    },
    key(e) {
      return state.key(e, accounts.length);
    },
  };
}

/** Who would be locked out if the platform edge sign-in went off. */
export const entry: PaletteEntry = {
  id: "edge-only-accounts",
  title: "Edge-only accounts",
  hint: "who would be locked out if the platform edge sign-in went off",
  offered: isAdmin,
  run: (session, ctx) => ctx.push(edgeOnlyScreen(session, ctx)),
};
