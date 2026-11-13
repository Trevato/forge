/**
 * An app's durable job runs, in the terminal (#11596): the page's rows
 * (`web/studio/jobs.ts`) from the same actions (`actions/jobs.ts`), gated the
 * same way: a writer reads and steers. The runs live in the app itself, so
 * the screen asks it (waking it) on open and after each write, and keeps the
 * answer; `c` cancels the run under the cursor, `t` retries a failed one from
 * its failed step, `g` reads again. A write is an event on the bus, so an
 * open web page redraws.
 */

import { requireWriter } from "../../actions/access.ts";
import { JOB_WORDS, jobRows, jobTimers, steerJob, type JobError, type JobRunRow } from "../../actions/jobs.ts";
import type { Repo } from "../../core/repos.ts";
import type { Ctx, Screen } from "../app/app.ts";
import type { Command } from "../app/palette.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { fill, len, split } from "../ui/layout.ts";
import { ListState, drawList, type ListRow } from "./common.ts";

export const JOB_TUI_WORDS: Record<JobError, string> = {
  ...JOB_WORDS,
  not_found: "No such app.",
  unauthorized: "Sign in to see job runs.",
  forbidden: "A writer reads and steers job runs.",
};

export function jobsScreen(f: Session, ctx: Ctx, repo: Repo): Screen {
  const state = new ListState();
  let rows: JobRunRow[] = [];
  let note = "Reading the runs from the app…";
  const read = async (): Promise<void> => {
    const got = await jobRows(f.app, f.user, repo);
    rows = got.ok ? got.value : [];
    note = got.ok ? (rows.length === 0 ? "This app has no job runs." : "c cancels an unfinished run, t retries a failed one, g reads again.") : JOB_TUI_WORDS[got.error];
    ctx.invalidate();
  };
  const steer = async (action: "cancel" | "retry"): Promise<void> => {
    const at = rows[state.index];
    if (at === undefined) return;
    const done = await steerJob(f.app, f.user, repo, at.id, action);
    ctx.toast(done.ok ? `${at.job} ${at.key}: ${action === "cancel" ? "cancelled" : "retrying"}.` : JOB_TUI_WORDS[done.error], done.ok ? undefined : "danger");
    await read();
  };
  return {
    title: `${repo.ownerName}/${repo.name} — Job runs`,
    keys: [binding(["j", "k"], "move cursor"), binding(["c"], "cancel"), binding(["t"], "retry from the failed step"), binding(["g"], "read again")],
    async load() {
      await read();
    },
    render(area, s) {
      const c = ctx.theme.c;
      const [head, list] = split(area, "v", [len(1), fill(1)]);
      s.text(head!.x, head!.y, truncate(note, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      const lines: ListRow[] = rows.map((r) => ({
        title: `${r.job} ${r.key}`,
        meta: r.now,
        ...(r.error === null ? {} : { note: r.error }),
      }));
      drawList(s, list!, c, state, lines);
    },
    key(e) {
      if (state.key(e, rows.length)) return true;
      if (e.ctrl || e.alt) return false;
      if (e.key === "g") void read();
      else if (e.key === "c") void steer("cancel");
      else if (e.key === "t") void steer("retry");
      else return false;
      return true;
    },
  };
}

/** The palette's command while a repository whose app holds job timers is open; a writer's only. */
export function jobsCommands(f: Session, ctx: Ctx, repo: Repo | undefined): Command[] {
  if (repo === undefined || !requireWriter(f.app, f.user, repo).ok || jobTimers(f.app, repo) === 0) return [];
  return [
    {
      id: "jobs-app",
      title: `${repo.ownerName}/${repo.name} — Job runs`,
      hint: "this app's durable job runs: cancel one, retry a failed one",
      run: () => ctx.push(jobsScreen(f, ctx, repo)),
    },
  ];
}
