/**
 * Runs: every run of a repository, newest first, narrowed by state with `s`
 * (All, Failed, Running, Succeeded) — the web runs page's `?state=` row.
 * Read through `listRepoRuns`, so it is gated like every other run read.
 */

import { listRepoRuns } from "../../actions/runs.ts";
import type { Repo } from "../../core/repos.ts";
import type { Run, RunState } from "../../core/runs.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { fill, len, split } from "../ui/layout.ts";
import { emptyState } from "../ui/widgets.ts";
import { RunList, openRunLog } from "./runlist.ts";

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

  return {
    title: "Runs",
    keys: [
      binding(["j", "k"], "move"),
      binding(["enter"], "open the log"),
      binding(["s"], "state: All, Failed, Running, Succeeded (cycle)"),
      binding(["r"], "refresh"),
    ],
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
}
