/**
 * Deploys: an app's production deploys, each with the pulls it carries.
 *
 * A production deploy is a `kind=deploy` run with no issue, so no run list
 * a pull or an issue shows holds one. This is the list that does, read
 * through `listRepoRuns` (so it is gated like every other run read) and
 * joined to `deploy_pull` in one grouped read for `carries #3 #5`.
 */

import { listRepoRuns } from "../../actions/runs.ts";
import { carriedByRuns, carriesText } from "../../core/carried.ts";
import type { Repo } from "../../core/repos.ts";
import type { Run } from "../../core/runs.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { fill, len, split } from "../ui/layout.ts";
import { emptyState } from "../ui/widgets.ts";
import { drawList, hitList } from "./common.ts";
import { RunList, openRunLog, runRows } from "./runlist.ts";

const LIMIT = 50;

/** Production deploys the actor may read, newest first. */
function readDeploys(f: Session, repo: Repo): Run[] {
  const listed = listRepoRuns(f.app, f.user, repo, {
    kind: "deploy",
    env: "production",
    limit: LIMIT,
  });
  return listed.ok ? listed.value : [];
}

export function deploysScreen(f: Session, ctx: Ctx, repo: Repo): Screen {
  const list = new RunList(f);
  let carries = new Map<string, number[]>();
  let loaded = false;

  const read = (): void => {
    const runs = readDeploys(f, repo);
    list.set(runs);
    carries = carriedByRuns(
      f.db,
      runs.map((r) => r.id),
    );
    loaded = true;
    ctx.invalidate();
  };

  const open = (run: Run): void => openRunLog(f, ctx, repo, run);

  return {
    title: "Deploys",
    keys: [
      binding(["j", "k"], "move"),
      binding(["enter"], "open the log"),
      binding(["r"], "refresh"),
    ],
    load: async () => read(),
    render(area, s) {
      const c = ctx.theme.c;
      const [head, body] = split(area, "v", [len(1), fill(1)]);
      s.text(
        head!.x,
        head!.y,
        truncate(`${repo.ownerName}/${repo.name} · production deploys`, head!.w),
        style(c.mutedFg, c.bg),
        head!.x + head!.w,
      );
      if (list.runs.length === 0) {
        emptyState(s, body!, c, {
          title: loaded ? "No deploys" : "Reading…",
          body: loaded
            ? "Nothing has been deployed to production yet."
            : "Reading the deploys",
        });
        return;
      }
      const rows = runRows(list.runs, new Map(), ctx.icons).map((row, i) => {
        const text = carriesText(carries.get(list.runs[i]!.id) ?? []);
        return text === ""
          ? row
          : { ...row, secondary: [row.secondary, text].filter((t) => t !== "").join(" · ") };
      });
      drawList(s, body!, c, list.state, rows);
      hitList(ctx, body!, list.state, rows.length, {
        open: (index) => {
          const run = list.runs[index];
          if (run !== undefined) open(run);
        },
      });
    },
    key(e) {
      if (list.state.key(e, list.runs.length)) return true;
      if (e.key === "enter") {
        const run = list.selected;
        if (run !== undefined) open(run);
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
