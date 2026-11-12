/**
 * The crew scorecard in the terminal, a forge admin's (#2682): agent runs
 * cut by the model they ran on, by prompt version, by model per day and wasted runs per day, as Settings → Crew
 * has them (`agentSplits`). The gate is the page's: an admin.
 */

import { modelDays, type ModelDay } from "../../core/model_days.ts";
import { wastedDays, type WastedDay } from "../../core/wasted_days.ts";
import { agentSplits, type SplitTotals } from "../../core/runs.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { fill, len, split } from "../ui/layout.ts";
import { ListState, drawList, type ListRow } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

export function splitRows(
  label: string,
  blank: string,
  splits: readonly SplitTotals[],
): ListRow[] {
  return splits.map((r) => ({
    title: `${label}: ${r.key === "" ? blank : r.key}`,
    secondary: `${r.runs} runs`,
    meta: `${r.ok} landed  ${r.failed} failed  $${r.spentUsd.toFixed(2)} spent  $${(r.spentUsd / r.runs).toFixed(2)} per run`,
  }));
}

export function modelDayRows(days: readonly ModelDay[]): ListRow[] {
  return days.map((d) => ({
    title: `day ${d.day}: ${d.model === "" ? "default" : d.model}`,
    secondary: `${d.runs} runs`,
    meta: `${d.landed} landed  $${d.spentUsd.toFixed(2)} spent`,
  }));
}

export function wastedDayRows(days: readonly WastedDay[]): ListRow[] {
  return days.map((d) => ({
    title: `wasted ${d.day}`,
    secondary: `${d.wasted} of ${d.runs} runs`,
    meta: `$${d.spentUsd.toFixed(2)} spent`,
  }));
}

export function crewSplitsScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  const allowed = f.user?.isAdmin === true;
  // Read once when the screen opens, not per frame.
  const rows: ListRow[] = allowed
    ? [
        ...splitRows("model", "default", agentSplits(f.db, "model")),
        ...splitRows("prompt", "not recorded", agentSplits(f.db, "prompt_version")),
        ...modelDayRows(modelDays(f.db)),
        ...wastedDayRows(wastedDays(f.db)),
      ]
    : [];
  return {
    title: "Crew scorecard",
    keys: [binding(["j", "k"], "move cursor")],
    render(area, s) {
      const c = ctx.theme.c;
      const [head, list] = split(area, "v", [len(1), fill(1)]);
      const text = !allowed
        ? "The crew scorecard is read by a forge admin."
        : rows.length === 0
          ? "No agent runs yet."
          : "Agent runs per model, then per prompt version, then per model per day.";
      s.text(head!.x, head!.y, truncate(text, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      drawList(s, list!, c, state, rows);
    },
    key: (e) => state.key(e, rows.length),
  };
}

/** Settings → Crew's scorecard by model and prompt version: an admin (#2682). */
export const entry: PaletteEntry = {
  id: "crew-scorecard",
  title: "Crew scorecard",
  hint: "agent runs per model and per prompt version",
  after: ["usage", "trusted-hosts", "secrets"],
  offered: (session) => session.user?.isAdmin === true,
  run: (session, ctx) => ctx.push(crewSplitsScreen(session, ctx)),
};
