/**
 * Working now, from a repository screen's `:` palette (#810): the terminal's
 * door to the toolbar page's live line. The row is there while an agent run
 * is running on this repository and names it; a run on work the person may
 * not see (a sealed report) is left out, as on the page. Read when the
 * palette opens, which is as often as the page reads it.
 */

import type { Repo } from "../../core/repos.ts";
import { listRuns } from "../../core/runs.ts";
import { mayViewId } from "../../core/sealed.ts";
import type { Ctx } from "../app/app.ts";
import type { Command } from "../app/palette.ts";
import type { Session } from "../session.ts";

export function workingCommands(f: Session, ctx: Ctx, repo: Repo | undefined): Command[] {
  if (repo === undefined || f.user === undefined) return [];
  const live = listRuns(f.db, repo.id, { kind: "agent", state: "running", limit: 200 }).find((r) =>
    mayViewId(f.db, repo, r.issueId, f.user),
  );
  if (live === undefined) return [];
  const summary = live.summary || "the crew is on this";
  return [
    {
      id: "working",
      title: `${repo.ownerName}/${repo.name} — Working now: ${summary}`,
      hint: "the crew is running",
      run: () => ctx.toast(`Working now: ${summary}`, "success"),
    },
  ];
}
