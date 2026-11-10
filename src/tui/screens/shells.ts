/**
 * Your shells in the terminal (#10544): the machine shells you hold, live
 * first, then the last ended ones. Read only; the rows are `myShells`, the
 * same the account page and MCP `sessions` (kind: shells) print.
 */

import { myShells, type ShellRow } from "../../machines/shell.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";

const reading = (n: number | null, unit: string): string => (n === null ? "-" : `${n}${unit}`);

/** One shell as a line of plain words. */
export function shellLine(s: ShellRow): string {
  if (s.endedAt !== null) return `${s.repository} · ${s.machine}  ended ${s.endedAt.slice(0, 16).replace("T", " ")}, ${s.endedBecause}`;
  const cpu = reading(s.cpuCores === null ? null : Math.round(s.cpuCores * 100), "%");
  return `${s.repository} · ${s.machine}  running, ${s.peers === 0 ? "nobody attached" : `${s.peers} attached`}, CPU ${cpu}, memory ${reading(s.memoryMiB, " MiB")}`;
}

export function shellsScreen(f: Session, ctx: Ctx): Screen {
  let rows: ShellRow[] = f.user === undefined ? [] : myShells(f.app, f.user.id);
  return {
    title: "Your shells",
    keys: [binding(["r"], "read again"), binding(["esc"], "close")],
    render(area, s) {
      const c = ctx.theme.c;
      if (rows.length === 0) {
        s.text(area.x + 1, area.y, "You have opened no shell on a machine yet.", style(c.mutedFg, c.bg), area.x + area.w);
        return;
      }
      rows.forEach((row, i) => {
        if (i < area.h) s.text(area.x + 1, area.y + i, truncate(shellLine(row), area.w - 2), style(row.endedAt === null ? c.fg : c.mutedFg, c.bg), area.x + area.w);
      });
    },
    key(e) {
      if (e.ctrl || e.alt) return false;
      if (e.key === "r") {
        rows = f.user === undefined ? [] : myShells(f.app, f.user.id);
        return true;
      }
      if (e.key === "esc" || e.key === "q") {
        ctx.pop();
        return true;
      }
      return false;
    },
  };
}
