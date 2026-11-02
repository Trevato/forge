/**
 * The fleet graph in the terminal: your repositories' runs and spend, one
 * sparkline row per series (`FLEET_GRAPH_MAX_SERIES` at most, the rest folded
 * as "N others"), over the last 24 hours by hour or 14 days by day, `w`
 * toggling. It reads `readFleetGraph`, the page's, CSV's and API's own data,
 * so who may see spend is that action's rule, never this screen's.
 */

import { FLEET_GRAPH_MAX_SERIES, readFleetGraph, type FleetWindow, type FleetWindowName } from "../../actions/fleet-graph.ts";
import { usd } from "../../core/money.ts";
import { spark } from "../../system/format.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { style } from "../term/style.ts";
import { pad, truncate } from "../term/width.ts";
import { fill, len, split } from "../ui/layout.ts";

/** The graph is never narrower than this many columns. */
const MIN_GRAPH = 10;
/** A name is never padded past this, so the rows stay together on a wide terminal. */
const NAME_MAX = 32;

/** At most `n` readings, each the sum of its stretch, so a narrow terminal still shows the whole window. */
function shrink(xs: readonly number[], n: number): number[] {
  if (xs.length <= n) return [...xs];
  return Array.from({ length: n }, (_, i) =>
    xs.slice(Math.floor((i * xs.length) / n), Math.floor(((i + 1) * xs.length) / n)).reduce((a, b) => a + b, 0),
  );
}

/** One row: name, sparkline scaled to its own peak, total at the right; the graph keeps `MIN_GRAPH` columns, the name gives way. */
export function graphRow(label: string, xs: readonly number[], total: string, width: number): string {
  const totalW = total.length;
  const graphW = Math.max(MIN_GRAPH, Math.min(xs.length, width - totalW - 2 - 8));
  const nameW = Math.max(0, Math.min(NAME_MAX, width - graphW - totalW - 2));
  const cells = shrink(xs, graphW);
  const peak = Math.max(0, ...cells);
  const line = spark(cells.map((x) => (peak > 0 ? (x / peak) * 100 : 0)));
  return `${pad(truncate(label, nameW), nameW)} ${pad(line, graphW)} ${total}`;
}

/** The screen's lines for one window: runs, then spend; or the empty sentence. */
export function fleetLines(w: FleetWindow, labels: readonly string[], width: number): { runs: string[]; spend: string[] } | undefined {
  const any = w.totals.runs.some((n) => n > 0) || w.totals.costUsd.some((n) => n > 0);
  if (!any) return undefined;
  const rows = (pick: "runs" | "costUsd", say: (n: number) => string): string[] => {
    const totals = labels.map((_, i) => say(w.totals[pick][i]!));
    const wide = Math.max(0, ...totals.map((t) => t.length));
    return labels.map((label, i) => graphRow(label, w.buckets.map((b) => b[pick][i]!), pad(totals[i]!, wide, "right"), width));
  };
  return { runs: rows("runs", (n) => `${n} ${n === 1 ? "run" : "runs"}`), spend: rows("costUsd", usd) };
}

export function fleetGraphScreen(f: Session, ctx: Ctx): Screen {
  let which: FleetWindowName = "24h";
  // Read once when the screen opens; a frame or a key never re-runs the ledger scan.
  const graph = f.user === undefined ? undefined : readFleetGraph(f.app, f.user, null);
  const labels = (graph?.series ?? []).slice(0, FLEET_GRAPH_MAX_SERIES).map((s) => s.label);
  return {
    title: "Fleet graph",
    keys: [binding(["w"], "24 h / 14 d")],
    render(area, s) {
      const c = ctx.theme.c;
      const w = graph?.windows[which === "24h" ? 0 : 1];
      const [head, body] = split(area, "v", [len(1), fill(1)]);
      const unit = which === "24h" ? "per hour over 24 h" : "per day over 14 d";
      s.text(head!.x, head!.y, truncate(`Runs and spend ${unit} (w: 24 h / 14 d), UTC`, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      const lines = w === undefined ? undefined : fleetLines(w, labels, body!.w);
      const out: [string, boolean][] =
        lines === undefined
          ? [["Nothing spent in this window.", false]]
          : [["Runs", true], ...lines.runs.map((l): [string, boolean] => [l, false]), ["", false], ["Spend", true], ...lines.spend.map((l): [string, boolean] => [l, false])];
      // A short terminal says what it cut rather than dropping rows silently.
      const shown: [string, boolean][] =
        out.length <= body!.h ? out : [...out.slice(0, Math.max(0, body!.h - 1)), [`+${out.length - Math.max(0, body!.h - 1)} more rows (make the terminal taller)`, false]];
      shown.forEach(([text, heading], i) => {
        s.text(body!.x, body!.y + i, truncate(text, body!.w), style(heading ? c.fg : c.mutedFg, c.bg), body!.x + body!.w);
      });
    },
    key(e) {
      if (e.ctrl || e.alt || e.key !== "w") return false;
      which = which === "24h" ? "14d" : "24h";
      return true;
    },
  };
}
