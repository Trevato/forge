/**
 * The one action that unblocks a stalled step, shared by the web button and
 * the terminal: ask for a check at the pull's head. Write access is checked
 * here, not trusted from the list the step came from.
 */

import type { App } from "../app.ts";
import { askCheck } from "../checks/again.ts";
import { getPull } from "../core/pulls.ts";
import { canWrite, getRepoById } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import type { StalledStep } from "./stalled.ts";

export type Unblocked = { ok: true } | { ok: false; message: string };

export async function unblock(app: App, user: User, step: StalledStep): Promise<Unblocked> {
  const repo = getRepoById(app.db, step.repo);
  if (repo === undefined || !canWrite(app.db, repo, user))
    return { ok: false, message: "only someone who can write here can ask for a check" };
  const pull = getPull(app.db, repo.id, step.pull);
  if (pull === undefined) return { ok: false, message: "that pull is not here any more" };
  const asked = await askCheck(app, user, repo, pull);
  return asked.ok ? { ok: true } : { ok: false, message: asked.message };
}
