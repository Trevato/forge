/**
 * Make it yours, from a repository screen's `:` palette (#810): the
 * terminal's door to the toolbar's button, for whoever cannot write the
 * repository. It is the fork screen (#606) the `F` key opens.
 */

import { canWrite, type Repo } from "../../core/repos.ts";
import type { Ctx } from "../app/app.ts";
import type { Command } from "../app/palette.ts";
import type { Session } from "../session.ts";
import { forkScreen } from "./newrepo.ts";

export function yoursCommands(f: Session, ctx: Ctx, repo: Repo | undefined): Command[] {
  if (repo === undefined || f.user === undefined || canWrite(f.db, repo, f.user)) return [];
  return [
    {
      id: "make-it-yours",
      title: `${repo.ownerName}/${repo.name} — Make it yours`,
      hint: "fork it",
      run: () => ctx.push(forkScreen(f, ctx, repo)),
    },
  ];
}
