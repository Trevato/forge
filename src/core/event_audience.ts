/**
 * Who an event is for.
 *
 * The outbox records everything that happens to a repository, and most of it
 * is for anyone who may read the repository: a push, an issue, a merge. Some
 * of it is configuration — a webhook's URL, which is often a secret in
 * itself; the names of an app's variables; which settings changed — and that
 * is for the repository's admins. And some is one person's own choice, like
 * keeping a repository on their machine, which is for them.
 *
 * Every surface that hands events to a reader — the JSON outbox, the two
 * event streams, the activity rail, the terminal's feed — asks here first, so
 * a new surface cannot forget and a new kind is classified once. An event of
 * a kind nobody classified is for readers, as it always was.
 */

import type { Database } from "bun:sqlite";
import type { ForgeEvent } from "./events.ts";
import { canAdmin, getRepoById } from "./repos.ts";
import type { User } from "./users.ts";

export type EventAudience = "readers" | "admins" | "actor";

export function eventAudience(kind: string): EventAudience {
  if (
    kind.startsWith("webhook.") ||
    kind.startsWith("app.env_") ||
    kind.startsWith("app.domain.") ||
    kind.startsWith("prompt.") ||
    kind.startsWith("secret.") ||
    kind === "repo.settings_updated"
  )
    return "admins";
  // A fleet operation spans repositories; its receipt is its actor's.
  if (kind === "repo.pinned" || kind === "repo.unpinned" || kind.startsWith("fleet."))
    return "actor";
  return "readers";
}

/**
 * A reader's view of events they may already see by repository: the ones
 * meant for them. `admins` is remembered per repository for the life of the
 * returned function, so a stream asks once per repository, not per event.
 */
export function audienceFilter(
  db: Database,
  viewer: User | undefined,
): (event: ForgeEvent) => boolean {
  const admins = new Map<string, boolean>();
  const isAdmin = (repoId: string): boolean => {
    const known = admins.get(repoId);
    if (known !== undefined) return known;
    const repo = getRepoById(db, repoId);
    const yes = repo !== undefined && canAdmin(db, repo, viewer);
    admins.set(repoId, yes);
    return yes;
  };
  return (event) => {
    switch (eventAudience(event.kind)) {
      case "readers":
        return true;
      case "actor":
        return viewer !== undefined && event.actorId === viewer.id;
      case "admins":
        return event.repoId !== null && isAdmin(event.repoId);
    }
  };
}
