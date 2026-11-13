/**
 * Runs the host stopped until it was given up on, in the terminal (#11583): the same
 * lines Home prints on the web, from `interruptedOutRuns`, read on every draw so
 * a Try again made on the page shows here at once. Enter (or r) queues the run
 * again through `requeueRepoRun`, the web route's own door, which announces the
 * new run so web viewers see it live. Gated like the page: only repositories
 * this person may write are listed.
 */

import { requeueRepoRun } from "../../actions/runs.ts";
import { listReposWritableTo } from "../../core/repos.ts";
import { words } from "../../fleet/verbs.ts";
import { interruptedOutRuns } from "../../runs/interrupted_out.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";

export function interruptedOutScreen(session: Session, ctx: Ctx): Screen {
  let at = 0;
  const rows = () => interruptedOutRuns(session.app.db, listReposWritableTo(session.app.db, session.user, { withoutArchived: true, limit: 200 }));
  return {
    title: "Stopped runs",
    keys: [binding(["j", "k"], "move"), binding(["enter", "r"], "try again"), binding(["esc"], "back")],
    render(area, s) {
      const c = ctx.theme.c;
      const list = rows();
      at = Math.min(at, Math.max(0, list.length - 1));
      if (list.length === 0) s.text(area.x + 1, area.y, "No run was stopped by the host in the last day.", style(c.mutedFg, c.bg), area.x + area.w);
      list.forEach((r, i) => {
        if (i >= area.h) return;
        const text = `${i === at ? "> " : "  "}${r.repo.name}#${r.number} ${r.title}: ${r.reason}`;
        s.text(area.x + 1, area.y + i, truncate(text, area.w - 2), i === at ? style(c.accent, c.bg) : style(c.fg, c.bg), area.x + area.w);
      });
    },
    key(e) {
      if (e.ctrl || e.alt) return false;
      const list = rows();
      if (e.key === "esc" || e.key === "q") ctx.pop();
      else if (e.key === "j" || e.key === "down") at = Math.min(Math.max(0, list.length - 1), at + 1);
      else if (e.key === "k" || e.key === "up") at = Math.max(0, at - 1);
      else if (e.key === "enter" || e.key === "r") {
        const row = list[at];
        if (row === undefined) return true;
        const done = requeueRepoRun(session.app, session.user, row.repo, row.runId);
        if (done.ok) ctx.toast(`Queued ${row.repo.name}#${row.number} again.`);
        else ctx.toast(`Could not try again: ${words(done.error)}.`, "danger");
        ctx.invalidate();
      } else return false;
      return true;
    },
  };
}

export const interruptedOutCommand = (session: Session, ctx: Ctx) => ({
  id: "interrupted-out",
  title: "Stopped runs",
  hint: "runs the host stopped five times, with Try again",
  run: () => ctx.push(interruptedOutScreen(session, ctx)),
});
