/**
 * How close each open milestone of the forge's own repository is, as plain
 * data: the changelog page and the terminal's Changelog screen read it, so
 * both doors say the same lines. Deferred and closed limbs are left out, and a
 * repository the reader may not open yields none.
 */

import type { App } from "../../app.ts";
import { canRead, getRepo, type Repo } from "../../core/repos.ts";
import type { User } from "../../core/users.ts";
import { planFor } from "./milestones.ts";

/** One open milestone's line: its number, name and how far it is. */
export type Near = { number: number; name: string; done: number; total: number };

/** The open milestones of `slug` ("owner/name"), for `user` (undefined is a guest), with the repository read for them. */
export function nearMilestones(app: App, slug: string | undefined, user: User | undefined): { repo: Repo; near: Near[] } | undefined {
  const [owner = "", name = ""] = (slug ?? "").split("/");
  if (owner === "" || name === "") return undefined;
  const repo = getRepo(app.db, owner, name);
  if (repo === undefined || !canRead(app.db, repo, user)) return undefined;
  const near = planFor({ app }, repo, false, new Date(), false)
    .limbs.filter((l) => l.issue.state === "open" && !l.deferred)
    .map((l) => ({ number: l.issue.number, name: l.name, done: l.weight.done, total: l.weight.total }));
  return { repo, near };
}

/** One line of words for a milestone, as the trail says it. */
export const nearWords = (m: Near): string => `${m.done} of ${m.total} done`;
