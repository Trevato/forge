/**
 * Your shells in the terminal (#10544): the machine shells you hold, live
 * first, then the last ended ones. Read only; the rows are `myShells`, the
 * same the account page and MCP `sessions` (kind: shells) print. `j`/`k`
 * pick a line, `s` stops the picked live shell, `i` stops every idle one
 * (#10545), with the same receipts as the page and MCP.
 */

import { NO_SUCH_SHELL, STOPPED_ONE, myShells, stopIdleShells, stopShell, stoppedIdleSays, type ShellRow } from "../../machines/shell.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";

const reading = (n: number | null, unit: string): string => (n === null ? "-" : `${n}${unit}`);

/** One shell as a line of plain words. */
export function shellLine(s: ShellRow): string {
  if (s.endedAt !== null) return `${s.repository} · ${s.machine}  ended ${s.endedAt.slice(0, 16).replace("T", " ")}, ${s.endedBecause}`;
  if (s.kind === "app") return `${s.repository} · ${s.machine}  app terminal, running`;
  const cpu = reading(s.cpuCores === null ? null : Math.round(s.cpuCores * 100), "%");
  return `${s.repository} · ${s.machine}  running, ${s.peers === 0 ? "nobody attached" : `${s.peers} attached`}, CPU ${cpu}, memory ${reading(s.memoryMiB, " MiB")}`;
}

export function shellsScreen(f: Session, ctx: Ctx): Screen {
  const read = (): ShellRow[] => (f.user === undefined ? [] : myShells(f.app, f.user.id));
  let rows = read();
  let sel = 0;
  return {
    title: "Your shells",
    keys: [binding(["j", "k"], "pick"), binding(["s"], "stop"), binding(["i"], "stop all idle"), binding(["r"], "read again"), binding(["esc"], "close")],
    render(area, s) {
      const c = ctx.theme.c;
      if (rows.length === 0) {
        s.text(area.x + 1, area.y, "You have opened no shell on a machine yet.", style(c.mutedFg, c.bg), area.x + area.w);
        return;
      }
      rows.forEach((row, i) => {
        if (i < area.h) s.text(area.x + 1, area.y + i, truncate(shellLine(row), area.w - 2), style(i === sel ? c.accent : row.endedAt === null ? c.fg : c.mutedFg, c.bg), area.x + area.w);
      });
    },
    key(e) {
      if (e.ctrl || e.alt) return false;
      if (e.key === "r") {
        rows = read();
        sel = Math.min(sel, Math.max(0, rows.length - 1));
        return true;
      }
      if (e.key === "j" || e.key === "down") {
        sel = Math.min(sel + 1, Math.max(0, rows.length - 1));
        return true;
      }
      if (e.key === "k" || e.key === "up") {
        sel = Math.max(sel - 1, 0);
        return true;
      }
      if (e.key === "s" && f.user !== undefined) {
        const row = rows[sel];
        if (row === undefined || row.endedAt !== null) ctx.toast(NO_SUCH_SHELL, "danger");
        else if (stopShell(f.app, f.user.id, row.id)) ctx.toast(STOPPED_ONE);
        else ctx.toast(NO_SUCH_SHELL, "danger");
        rows = read();
        return true;
      }
      if (e.key === "i" && f.user !== undefined) {
        ctx.toast(stoppedIdleSays(stopIdleShells(f.app, f.user.id)));
        rows = read();
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
