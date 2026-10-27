/**
 * What an act on a feed item is about, and whether the viewer may act on it.
 * The route and the MCP tool both ask here, so they refuse the same things.
 */

import type { Database } from "bun:sqlite";
import { audienceFilter } from "../core/event_audience.ts";
import { getEvent } from "../core/events.ts";
import { canRead, getRepo, getRepoById } from "../core/repos.ts";
import type { User } from "../core/users.ts";

export interface InteractionTarget {
  readonly repoId: string;
  readonly actorId: string | null;
}

/**
 * The repository (and, for an event, the actor) an item is about: read from
 * the event through the visibility the feed used, or from the named
 * `owner/name` otherwise. Anything the viewer cannot read is undefined.
 */
export function interactionTarget(
  db: Database,
  viewer: User,
  itemId: string,
  app: string,
): InteractionTarget | undefined {
  if (itemId.startsWith("event:")) {
    const event = getEvent(db, itemId.slice("event:".length));
    const repo = event?.repoId ? getRepoById(db, event.repoId) : undefined;
    if (!event || !repo || !canRead(db, repo, viewer)) return undefined;
    if (!audienceFilter(db, viewer)(event)) return undefined;
    return { repoId: repo.id, actorId: event.actorId };
  }
  const [owner, name, extra] = app.split("/");
  const repo =
    owner && name && extra === undefined ? getRepo(db, owner, name) : undefined;
  if (!repo || !canRead(db, repo, viewer)) return undefined;
  return { repoId: repo.id, actorId: null };
}
