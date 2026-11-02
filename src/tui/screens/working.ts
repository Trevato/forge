/**
 * Working now, from a repository screen's `:` palette (#810): the terminal's
 * door to the toolbar page's live line. One row per agent run running on
 * this repository, naming the agent, the work and how long it has run;
 * choosing one opens that run's address. A run on work the person may not
 * see (a sealed report) is left out, as on the page. Read when the palette
 * opens, which is as often as the page reads it.
 */

import { getIssueById } from "../../core/issues.ts";
import type { Repo } from "../../core/repos.ts";
import { listRuns } from "../../core/runs.ts";
import { mayViewId } from "../../core/sealed.ts";
import { getUserById } from "../../core/users.ts";
import type { Ctx } from "../app/app.ts";
import type { Command } from "../app/palette.ts";
import type { Session } from "../session.ts";
import { truncate } from "../term/width.ts";
import { openRunLog } from "./runlist.ts";

export function workingCommands(f: Session, ctx: Ctx, repo: Repo | undefined): Command[] {
  const viewer = f.user;
  if (repo === undefined || viewer === undefined) return [];
  const now = Date.now();
  return listRuns(f.db, repo.id, { kind: "agent", state: "running", limit: 200 })
    .filter((r) => mayViewId(f.db, repo, r.issueId, viewer))
    .map((run) => {
      const agent = run.actorId === null ? undefined : getUserById(f.db, run.actorId)?.username;
      const issue = run.issueId === null ? undefined : getIssueById(f.db, run.issueId);
      const full =
        issue !== undefined ? `#${issue.number} ${run.summary || issue.title}` : run.summary;
      const on = full ? ` on ${truncate(full, 60)}` : "";
      const since = Date.parse(run.startedAt ?? run.createdAt);
      const minutes = Number.isFinite(since) ? Math.max(0, Math.floor((now - since) / 60_000)) : 0;
      const line = `Working now: ${agent ?? "the crew"}${on} · ${
        minutes < 1 ? "under a minute" : `${minutes} min`
      }`;
      return {
        id: `working:${run.id}`,
        title: `${repo.ownerName}/${repo.name} — ${line}`,
        hint: "the crew is running",
        run: () => openRunLog(f, ctx, repo, run),
      };
    });
}
