/**
 * What the tokens bought, for the people who may know: owner facts only
 * (`canSeeOwnerFacts`) — the owner, their organisation's writers, a site
 * admin. Over every repository the viewer holds those facts for, or one
 * named one; a repository they do not is `not_found`, as a stranger's is.
 */

import type { App } from "../app.ts";
import {
  getRepo,
  listReposVisibleTo,
  ownerFactRepoIds,
  type Repo,
} from "../core/repos.ts";
import { tokenReturns, type Returns } from "../core/returns.ts";
import type { User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";

/** The window a reader may ask for, in days. */
export const RETURNS_DAYS = { default: 7, max: 90 } as const;

export type ReturnsError = "unauthorized" | "not_found" | "bad_days";

/** The repositories whose spend this viewer may read: those they hold owner facts for. */
export function returnsRepos(app: App, viewer: User): Repo[] {
  const visible = listReposVisibleTo(app.db, viewer, { limit: 200 });
  const facts = ownerFactRepoIds(app.db, visible, viewer);
  return visible.filter((r) => facts.has(r.id));
}

export function readReturns(
  app: App,
  viewer: User | undefined,
  options: { repo?: string | null; days?: number; now?: Date } = {},
): Result<Returns & { repos: string[] }, ReturnsError> {
  if (!viewer) return err("unauthorized");
  const days = options.days ?? RETURNS_DAYS.default;
  if (!Number.isInteger(days) || days < 1 || days > RETURNS_DAYS.max)
    return err("bad_days");
  let repos = returnsRepos(app, viewer);
  if (options.repo) {
    const [owner, name, rest] = options.repo.split("/");
    const one = owner && name && rest === undefined ? getRepo(app.db, owner, name) : undefined;
    repos = one === undefined ? [] : repos.filter((r) => r.id === one.id);
    if (repos.length === 0) return err("not_found");
  }
  const now = options.now ?? new Date();
  const returns = tokenReturns(
    app.db,
    repos.map((r) => r.id),
    { since: new Date(now.getTime() - days * 86_400_000).toISOString(), until: now.toISOString() },
  );
  return ok({ ...returns, repos: repos.map((r) => `${r.ownerName}/${r.name}`) });
}
