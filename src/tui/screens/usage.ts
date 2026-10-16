/**
 * Usage in the terminal, a forge admin's (#1565): every route pattern with
 * its requests over the last 30 days by role and by surface, unused ones
 * first with their last use or `never`, as Settings → Usage lists them
 * (`routeUsage`). The gate is the page's: an admin who is not an agent;
 * anyone else sees nothing.
 */

import { mayManageFlags } from "../../core/flags.ts";
import { ROLES, SURFACES } from "../../core/usage_count.ts";
import { routeUsage, WINDOW_DAYS, type RouteUsage } from "../../core/usage_report.ts";
import { knownPatterns } from "../../http/server.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { fill, len, split } from "../ui/layout.ts";
import { ListState, drawList, type ListRow } from "./common.ts";

const part = (counts: Readonly<Record<string, number>>, keys: readonly string[]) =>
  keys.map((k) => `${k} ${counts[k] ?? 0}`).join(" ");

export function usageRows(r: readonly RouteUsage[]): ListRow[] {
  return r.map((u) => ({
    title: u.pattern,
    secondary: `${u.total}`,
    meta: `${part(u.roles, ROLES)}  ${part(u.surfaces, SURFACES)}  last ${u.last === null ? "never" : `${u.last.replace("T", " ")}:00`}`,
  }));
}

export function usageScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  const allowed = mayManageFlags(f.user);
  // Read once when the screen opens: the report scans the whole table, so a frame or a key never re-runs it.
  const rows: RouteUsage[] = allowed ? routeUsage(f.db, knownPatterns(), new Date()) : [];
  return {
    title: "Usage",
    keys: [binding(["j", "k"], "move cursor")],
    render(area, s) {
      const c = ctx.theme.c;
      const [head, list] = split(area, "v", [len(1), fill(1)]);
      const all = rows;
      const text = !allowed
        ? "Usage is read by a forge admin."
        : `${all.filter((r) => r.total === 0).length} of ${all.length} routes had no request in ${WINDOW_DAYS} days; unused first.`;
      s.text(head!.x, head!.y, truncate(text, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      drawList(s, list!, c, state, usageRows(all));
    },
    key: (e) => state.key(e, rows.length),
  };
}
