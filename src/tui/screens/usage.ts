/**
 * Usage in the terminal, a forge admin's (#1565): every route pattern with
 * its requests over the last 30 days by role and by surface, unused ones
 * first with their last use or `never`, as Settings → Usage lists them
 * (`routeUsage`). The gate is the page's: an admin who is not an agent;
 * anyone else sees nothing.
 *
 * Above it, what the crew's tokens bought (#7271), as MCP `returns` reads
 * it (`readReturns`): dollars, runs, changes landed and cost per change over
 * 1, 7, 30 or 90 days, `[`/`]` to move. A repository's usage narrows it to
 * that app and lists no routes; someone `readReturns` refuses sees no block.
 */

import { USAGE_ADMIN_ONLY } from "../../actions/admin_limits_words.ts";
import { readReturns } from "../../actions/returns.ts";
import { mayManageFlags } from "../../core/flags.ts";
import { ROLES, SURFACES } from "../../core/usage_count.ts";
import { usd } from "../../core/money.ts";
import type { Repo } from "../../core/repos.ts";
import type { Returns } from "../../core/returns.ts";
import { routeUsage, WINDOW_DAYS, type RouteUsage } from "../../core/usage_report.ts";
import { knownPatterns } from "../../http/server.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { fill, len, split } from "../ui/layout.ts";
import { fleetGraphScreen } from "./fleetgraph.ts";
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

/** The windows `[`/`]` move between, in days; 7 is where the screen opens. */
export const RETURNS_SPANS = [1, 7, 30, 90] as const;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The returns block's one line, in words: "nothing spent" when no run ran, never a NaN. */
export function returnsLine(r: Returns, days: number): string {
  const span = `Returns, ${plural(days, "day", "days")}: `;
  if (r.spent.runs === 0) return `${span}nothing spent · ${plural(r.landed, "change", "changes")} landed`;
  const per = r.onLanded.perChange;
  return `${span}${usd(r.spent.usd)} over ${plural(r.spent.runs, "run", "runs")} · ${plural(r.landed, "change", "changes")} landed · ${
    per.changes === 0 ? "no landed change to cost" : `${usd(per.median)} a landed change (median)`
  }`;
}

export function usageScreen(f: Session, ctx: Ctx, repo?: Repo): Screen {
  const state = new ListState();
  const allowed = repo === undefined && mayManageFlags(f.user);
  // Read once when the screen opens: the report scans the whole table, so a frame or a key never re-runs it.
  const rows: RouteUsage[] = allowed ? routeUsage(f.db, knownPatterns(), new Date()) : [];
  const scope = repo === undefined ? {} : { repo: `${repo.ownerName}/${repo.name}` };
  let span = RETURNS_SPANS.indexOf(7);
  // Read when the window moves, never per frame; undefined is a refusal, and then there is no block.
  const read = (): string | undefined => {
    const days = RETURNS_SPANS[span]!;
    const r = readReturns(f.app, f.user, { ...scope, days });
    return r.ok ? returnsLine(r.value, days) : undefined;
  };
  let returns = read();
  return {
    title: repo === undefined ? "Usage" : `Usage · ${repo.ownerName}/${repo.name}`,
    keys: [
      binding(["j", "k"], "move cursor", { hidden: rows.length === 0 }),
      binding(["[", "]"], "returns window", { hidden: returns === undefined }),
      binding(["f"], "fleet graph", { hidden: repo !== undefined }),
    ],
    render(area, s) {
      const c = ctx.theme.c;
      const [top, head, list] = split(area, "v", [len(returns === undefined ? 0 : 1), len(1), fill(1)]);
      if (returns !== undefined)
        s.text(top!.x, top!.y, truncate(returns, top!.w), style(c.fg, c.bg), top!.x + top!.w);
      const all = rows;
      const text =
        repo !== undefined
          ? returns === undefined ? "Nothing here is yours to see." : "Routes are counted forge-wide: Usage, without a repository."
          : !allowed
            ? USAGE_ADMIN_ONLY
            : `${all.filter((r) => r.total === 0).length} of ${all.length} routes had no request in ${WINDOW_DAYS} days; unused first.`;
      s.text(head!.x, head!.y, truncate(text, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      // A repository's usage has no routes to list: no empty pane under the line.
      if (repo === undefined) drawList(s, list!, c, state, usageRows(all));
    },
    key: (e) => {
      if (repo === undefined && !e.ctrl && !e.alt && e.key === "f") {
        ctx.push(fleetGraphScreen(f, ctx));
        return true;
      }
      if (returns !== undefined && !e.ctrl && !e.alt && (e.key === "[" || e.key === "]")) {
        const next = Math.max(0, Math.min(RETURNS_SPANS.length - 1, span + (e.key === "]" ? 1 : -1)));
        if (next === span) return true;
        span = next;
        returns = read();
        return true;
      }
      return state.key(e, rows.length);
    },
  };
}
