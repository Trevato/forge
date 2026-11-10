/**
 * The crew's five knobs in the terminal (#10461), a forge admin's: the same
 * rows the crew page and the MCP `knobs` tool print (`readKnobs`). `e` turns
 * the one under the cursor through `setKnob`, the one place that turns them,
 * so the page and the feed see it as they see the page's own change.
 */

import { setKnob } from "../../actions/knobs.ts";
import { knobLines, readKnobs, type KnobRow } from "../../crew/knobs.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { fill, len, split } from "../ui/layout.ts";
import { ListState, drawList, later, promptScreen, type ListRow } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

const REFUSED = "That value is outside what this knob takes.";

function bounds(r: KnobRow): string {
  return r.control === "words" ? (r.words ?? []).join(" / ") : `${r.min ?? 0}–${r.max ?? 100}${r.control === "percent" ? " %" : ""}`;
}

export function knobsScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  const allowed = f.user?.isAdmin === true && f.user.kind !== "agent";
  const read = (): KnobRow[] => (allowed ? readKnobs(f.app) : []);
  let rows = read();
  const screen: Screen = {
    title: "Knobs",
    keys: allowed ? [binding(["e"], "turn the knob"), binding(["j", "k"], "move cursor")] : [binding(["j", "k"], "move cursor")],
    render(area, s) {
      const c = ctx.theme.c;
      const [head, list] = split(area, "v", [len(1), fill(1)]);
      const text = allowed ? "Five dials for the crew; e turns the one under the cursor." : "The knobs are a forge admin's.";
      s.text(head!.x, head!.y, truncate(text, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      const lines: ListRow[] = knobLines(rows).map((title) => ({ title }));
      drawList(s, list!, c, state, lines);
    },
    key(e) {
      if (e.key !== "e") return state.key(e, rows.length);
      const row = rows[state.index];
      if (row === undefined) return true;
      if (row.control === "fixed") return ctx.toast(`${row.name} is always on.`, "success"), true;
      later(ctx, () =>
        promptScreen(ctx, screen, {
          title: row.name,
          label: `${row.repo ?? row.name} (${bounds(row)})`,
          value: row.value,
          onSubmit: async (typed) => {
            const done = await setKnob(f.app, f.user, row.id, typed, row.repo);
            if (!done.ok) return ctx.toast(done.error === "invalid_value" ? REFUSED : "That could not be done.", "danger");
            rows = read();
            ctx.toast(`${row.name}: ${done.value.value}, from the next pump on.`, "success");
            ctx.invalidate();
          },
        }),
      );
      return true;
    },
  };
  return screen;
}

export const entry: PaletteEntry = {
  id: "knobs",
  title: "Knobs",
  hint: "speed, weekly budget, polish, autonomy, feedback first",
  after: ["crew-scorecard", "usage"],
  offered: (session) => session.user?.isAdmin === true,
  run: (session, ctx) => ctx.push(knobsScreen(session, ctx)),
};
