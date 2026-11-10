/**
 * Security controls in the terminal, a forge admin's: the same lines as
 * /settings/security/controls (`checks/controls.ts`), each safeguard and when
 * it was last tested, then what the page policy blocked this week by
 * directive (the security page's "Blocked by the page policy" line), absent
 * when nothing was. Read-only.
 */

import type { Database } from "bun:sqlite";
import { controlStandings } from "../../checks/controls.ts";
import { violationsByDirective } from "../../http/csp_report.ts";
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

/** One row per directive the Content-Security-Policy blocked in the last 7 days; none when nothing was. */
export function cspRows(db: Database, nowMs: number): ListRow[] {
  return violationsByDirective(db, 7 * 24, new Date(nowMs)).map((w) => ({
    title: `Blocked by the page policy: ${w.directive}`,
    secondary: "",
    meta: `${w.n} in 7 days`,
  }));
}

export function controlsScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  const now = Date.now();
  const rows = [...controlRows(f.app.config.dataDir, now), ...cspRows(f.app.db, now)];
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
