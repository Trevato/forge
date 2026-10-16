/**
 * The Resilience command's dialog, a forge admin's: one line per THREATS.md
 * protection with its standing in the last gate, as /resilience says it.
 * Read-only; Enter, Esc or q closes it.
 */

import { readResilience } from "../../checks/resilience.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { pad, wrap } from "../term/width.ts";
import { dialog } from "../ui/widgets.ts";

const WIDTH = 72;

export function resilienceLines(dataDir: string): string[] {
  const rows = readResilience(dataDir);
  const inner = WIDTH - 6;
  return rows.flatMap(({ p, s }) => wrap(`${pad(s, 11)} ${p.text}`, inner));
}

export function resilienceScreen(ctx: Ctx, lines: readonly string[]): Screen {
  return {
    title: "Resilience",
    keys: [binding(["enter", "esc", "q"], "close")],
    render(area, s) {
      const buttons = dialog(s, area, ctx.theme.c, {
        title: "Resilience",
        body: lines,
        actions: [{ label: "Close" }],
        selected: 0,
        width: WIDTH,
      });
      buttons.forEach((rect) => ctx.hit(rect, () => ctx.pop()));
    },
    key(e) {
      if (e.key === "enter" || e.key === "esc" || e.key === "q") ctx.pop();
      return true;
    },
  };
}
