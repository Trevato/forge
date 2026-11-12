/**
 * An app's schedules, in the terminal (#11595): the app page's rows
 * (`web/studio/schedules.ts`) from the same actions (`actions/schedules.ts`),
 * gated the same way. Anyone who can read the repository sees the rows; the
 * run's error and answer are a writer's, so a reader's rows carry none. `r`
 * runs the schedule under the cursor now, `p` pauses it or resumes it, both
 * for a writer only. Each write is an event on the bus, so an open web page
 * redraws, and this screen follows a write made there.
 */

import { scheduleRows, steerSchedule, type ScheduleRow, type SteerError } from "../../actions/schedules.ts";
import { requireWriter } from "../../actions/access.ts";
import type { Repo } from "../../core/repos.ts";
import type { Ctx, Screen } from "../app/app.ts";
import type { Command } from "../app/palette.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { fill, len, split } from "../ui/layout.ts";
import { ListState, drawList, live, type ListRow } from "./common.ts";

const WORDS: Record<SteerError, string> = {
  not_found: "No such schedule.",
  unauthorized: "Sign in to steer a schedule.",
  forbidden: "A writer steers a schedule.",
};

/** The rows this viewer may see; none when the repository is not theirs to read or has no schedule. */
export function rowsFor(f: Session, repo: Repo): ScheduleRow[] {
  const rows = scheduleRows(f.app, f.user, repo);
  return rows.ok ? rows.value : [];
}

export function schedulesScreen(f: Session, ctx: Ctx, repo: Repo): Screen {
  const state = new ListState();
  const mayWrite = (): boolean => requireWriter(f.app, f.user, repo).ok;
  return {
    title: `${repo.ownerName}/${repo.name} — Schedules`,
    keys: [binding(["j", "k"], "move cursor"), binding(["r"], "run now"), binding(["p"], "pause or resume")],
    async load(signal) {
      live(f, signal, { repoId: repo.id, where: (e) => e.kind === "schedule.steered" || e.kind === "run.finished" }, () => ctx.invalidate());
    },
    render(area, s) {
      const c = ctx.theme.c;
      const all = rowsFor(f, repo);
      const [head, list] = split(area, "v", [len(1), fill(1)]);
      s.text(
        head!.x,
        head!.y,
        truncate(all.length === 0 ? "This app has no schedule." : mayWrite() ? "r runs it now, p pauses or resumes it." : "A writer runs and pauses schedules.", head!.w),
        style(c.mutedFg, c.bg),
        head!.x + head!.w,
      );
      const lines: ListRow[] = all.map((r) => ({
        title: r.line,
        ...(r.last?.error ? { note: r.last.error } : {}),
        ...(r.env === "production" ? {} : { meta: r.env }),
      }));
      drawList(s, list!, c, state, lines);
    },
    key(e) {
      const all = rowsFor(f, repo);
      if (state.key(e, all.length)) return true;
      if (e.ctrl || e.alt || (e.key !== "r" && e.key !== "p")) return false;
      const at = all[state.index];
      if (at === undefined) return true;
      const action = e.key === "r" ? "run" : at.paused ? "resume" : "pause";
      const done = steerSchedule(f.app, f.user, repo, at.name, at.env, action);
      ctx.toast(done.ok ? `${at.name}: ${action === "run" ? "running now" : action === "pause" ? "paused" : "resumed"}.` : WORDS[done.error], done.ok ? undefined : "danger");
      ctx.invalidate();
      return true;
    },
  };
}

/** The palette's command while a repository with a schedule is open. */
export function schedulesCommands(f: Session, ctx: Ctx, repo: Repo | undefined): Command[] {
  if (repo === undefined || rowsFor(f, repo).length === 0) return [];
  return [
    {
      id: "schedules-app",
      title: `${repo.ownerName}/${repo.name} — Schedules`,
      hint: "this app's schedules: run one now, pause or resume it",
      run: () => ctx.push(schedulesScreen(f, ctx, repo)),
    },
  ];
}
