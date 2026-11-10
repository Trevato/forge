/**
 * Security controls in the terminal, a forge admin's: the same lines as
 * /settings/security/controls (`checks/controls.ts`), each safeguard and when
 * it was last tested. Read-only.
 */

import { controlStandings } from "../../checks/controls.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { ListState, drawList, type ListRow } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

const isAdmin = (f: Session): boolean => f.user?.isAdmin === true && f.user.kind !== "agent";

export function controlRows(dataDir: string, nowMs: number): ListRow[] {
  return controlStandings(dataDir, nowMs).map(({ control, check, attention }) => ({
    title: control.name,
    secondary: "",
    meta:
      check === null
        ? "No check recorded"
        : `${attention ? (check.ok ? "Out of date, " : "Failed, ") : ""}checked ${check.at.slice(0, 10)}`,
  }));
}

export function controlsScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  const rows = controlRows(f.app.config.dataDir, Date.now());
  return {
    title: "Security controls",
    keys: [binding(["j", "k"], "move cursor")],
    render(area, s) {
      drawList(s, area, ctx.theme.c, state, rows);
    },
    key(e) {
      return state.key(e, rows.length);
    },
  };
}

/** Each safeguard, and when it was last tested. */
export const entry: PaletteEntry = {
  id: "security-controls",
  title: "Security controls",
  hint: "each safeguard, and when it was last tested",
  offered: isAdmin,
  run: (session, ctx) => ctx.push(controlsScreen(session, ctx)),
};
