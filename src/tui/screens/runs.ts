/**
 * Runs: every run of a repository, newest first, narrowed by state with `s`
 * (All, Failed, Running, Succeeded) — the web runs page's `?state=` row.
 * Read through `listRepoRuns`, so it is gated like every other run read.
 * `x` cancels a run that has not finished; `a` queues a failed or cancelled
 * agent run's task again (`requeueRepoRun`), each after a confirm; `S` says a
 * word to a run while an agent runs it (`s` is the state row here; the crew
 * cards steer with `s`).
 */

import { cancelRepoRun, listRepoRuns, requeueRepoRun } from "../../actions/runs.ts";
import { lacks } from "../../core/roles.ts";
import { canWrite, type Repo } from "../../core/repos.ts";
import { taskOf } from "../../crew/dispatch.ts";
import { words } from "../../fleet/verbs.ts";
import type { Run, RunState } from "../../core/runs.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { fill, len, split } from "../ui/layout.ts";
import { emptyState } from "../ui/widgets.ts";
import { confirmScreen } from "./common.ts";
import { RunList, maySteer, openRunLog, runTitle, steerPrompt } from "./runlist.ts";

const LIMIT = 50;

/** The states `s` cycles through, in the words the web row uses. */
export const RUN_STATE_CYCLE: readonly [RunState | undefined, string][] = [
  [undefined, "All"],
  ["failed", "Failed"],
  ["running", "Running"],
  ["ok", "Succeeded"],
];

export function runsScreen(f: Session, ctx: Ctx, repo: Repo): Screen {
  const list = new RunList(f, { nameIssues: true });
  let at = 0;
  let loaded = false;

  const read = (): void => {
    const listed = listRepoRuns(f.app, f.user, repo, {
      state: RUN_STATE_CYCLE[at]![0],
      limit: LIMIT,
    });
    list.set(listed.ok ? listed.value : []);
    loaded = true;
    ctx.invalidate();
  };

  const open = (run: Run): void => openRunLog(f, ctx, repo, run);

  /** The selected run, when it has not finished and the viewer may write. */
  const cancellable = (): Run | undefined => {
    const run = list.selected;
    if (run === undefined || (run.state !== "queued" && run.state !== "running"))
      return undefined;
    return canWrite(f.app.db, repo, f.user) ? run : undefined;
  };

  /**
   * The selected run, when it is a failed or cancelled agent run whose task
   * is still there and the viewer is a person who may run the crew — the
   * cases `requeueRepoRun` would not refuse before asking the crew.
   */
  const requeueable = (): Run | undefined => {
    const run = list.selected;
    const user = f.user;
    if (run === undefined || user === undefined || user.kind !== "user") return undefined;
    if (run.kind !== "agent" || (run.state !== "failed" && run.state !== "cancelled"))
      return undefined;
    if (repo.archivedAt !== null || !canWrite(f.app.db, repo, user)) return undefined;
    if (lacks(f.app.db, user, "run_crew")) return undefined;
    return taskOf(f.app, run) === undefined ? undefined : run;
  };

  const askRequeue = (): void => {
    const run = requeueable();
    if (run === undefined) return;
    const names = new Map<string, { username: string }>();
    const what = `${runTitle(run, names)} (${run.id.slice(0, 8)})`;
    ctx.push(
      confirmScreen(ctx, self, {
        title: "Run again",
        body: [`Queue ${what} again?`, "The new run reads the whole conversation and carries on."],
        actions: [{ label: "Run again", variant: "default" }, { label: "Keep" }],
        selected: 1,
        onChoose: (choice) => {
          if (choice !== 0) return;
          const done = requeueRepoRun(f.app, f.user, repo, run.id);
          if (done.ok) ctx.toast(`Queued ${what} again.`);
          else ctx.toast(`Could not run it again: ${words(done.error)}.`, "danger");
          read();
        },
      }),
    );
  };

  const ask = (): void => {
    const run = cancellable();
    if (run === undefined) return;
    const names = new Map<string, { username: string }>();
    const what = `${runTitle(run, names)} (${run.id.slice(0, 8)})`;
    ctx.push(
      confirmScreen(ctx, self, {
        title: "Cancel run",
        body: [`Cancel ${what}?`],
        actions: [{ label: "Cancel run", variant: "danger" }, { label: "Keep" }],
        selected: 1,
        onChoose: (choice) => {
          if (choice !== 0) return;
          const done = cancelRepoRun(f.app, f.user, repo, run.id);
          if (done.ok) ctx.toast(`Cancelled ${what}.`);
          else
            ctx.toast(
              done.error === "finished"
                ? "That run already finished."
                : `Could not cancel: ${done.error}.`,
              "danger",
            );
          read();
        },
      }),
    );
  };

  const self: Screen = {
    title: "Runs",
    get keys() {
      return [
        binding(["j", "k"], "move"),
        binding(["enter"], "open the log"),
        ...(cancellable() === undefined ? [] : [binding(["x"], "cancel")]),
        ...(maySteer(f, repo, list.selected) ? [binding(["S"], "steer")] : []),
        ...(requeueable() === undefined ? [] : [binding(["a"], "run again")]),
        binding(["s"], "state: All, Failed, Running, Succeeded (cycle)"),
        binding(["r"], "refresh"),
      ];
    },
    load: async () => read(),
    render(area, s) {
      const c = ctx.theme.c;
      const [head, body] = split(area, "v", [len(1), fill(1)]);
      s.text(
        head!.x,
        head!.y,
        truncate(`${repo.ownerName}/${repo.name} · runs · ${RUN_STATE_CYCLE[at]![1]}`, head!.w),
        style(c.mutedFg, c.bg),
        head!.x + head!.w,
      );
      if (list.runs.length === 0) {
        emptyState(s, body!, c, {
          title: loaded ? "No runs" : "Reading…",
          body: loaded
            ? at === 0
              ? "Nothing has run here yet."
              : `No ${RUN_STATE_CYCLE[at]![1].toLowerCase()} runs.`
            : "Reading the runs",
        });
        return;
      }
      list.render(s, body!, c, ctx, true, open);
    },
    key(e) {
      if (list.state.key(e, list.runs.length)) return true;
      if (e.key === "enter") {
        const run = list.selected;
        if (run !== undefined) open(run);
        return true;
      }
      if (e.key === "x") {
        ask();
        return true;
      }
      if (e.key === "S") {
        const run = list.selected;
        if (run !== undefined && maySteer(f, repo, run))
          steerPrompt(f, ctx, self, repo, run, read);
        return true;
      }
      if (e.key === "a") {
        askRequeue();
        return true;
      }
      if (e.key === "s") {
        at = (at + 1) % RUN_STATE_CYCLE.length;
        read();
        return true;
      }
      if (e.key === "r") {
        read();
        return true;
      }
      return false;
    },
  };
  return self;
}
