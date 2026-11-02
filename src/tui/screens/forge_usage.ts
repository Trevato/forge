/**
 * Forge-wide spend in the terminal, as `GET /api/v1/usage` and MCP `usage`
 * without a repo answer it (`readForgeUsage`): today (since 00:00 UTC) and
 * the rolling last 24 hours named apart, then one row per subscription with
 * each window's headroom. The gate is theirs: a guest sees nothing, a writer
 * their own apps, an admin all. Read once when the screen opens.
 */

import { readForgeUsage, type ForgeUsage } from "../../actions/usage.ts";
import { usd } from "../../core/money.ts";
import type { SpanSpend } from "../../core/usage_report.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { fill, len, split } from "../ui/layout.ts";
import { ListState, drawList, type ListRow } from "./common.ts";

const span = (s: SpanSpend) => `${usd(s.costUsd)} over ${s.runs} ${s.runs === 1 ? "run" : "runs"}`;

export function forgeUsageRows(r: ForgeUsage): ListRow[] {
  return r.subscriptions.map((s) => ({
    title: s.subscription,
    secondary: `today ${span(s.today)} · 24h ${span(s.last24h)}`,
    meta:
      s.headroom.length === 0
        ? "no window yet"
        : s.headroom.map((h) => `${h.window} ${h.pct === null ? "no limit named" : `${h.pct}% free`}`).join("  "),
  }));
}

export function forgeUsageLine(r: ForgeUsage): string {
  return `${r.apps} ${r.apps === 1 ? "app" : "apps"} · today ${span(r.today)} · last 24 h ${span(r.last24h)}`;
}

export function forgeUsageScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  const report = f.user === undefined ? undefined : readForgeUsage(f.app, f.user);
  const rows = report === undefined ? [] : forgeUsageRows(report);
  return {
    title: "Forge spend",
    keys: [],
    render(area, s) {
      const c = ctx.theme.c;
      const [head, list] = split(area, "v", [len(1), fill(1)]);
      const text = report === undefined ? "Sign in to see what the forge spent." : forgeUsageLine(report);
      s.text(head!.x, head!.y, truncate(text, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      drawList(s, list!, c, state, rows);
    },
    key: (e) => state.key(e, rows.length),
  };
}
