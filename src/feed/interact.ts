/**
 * What an act on a feed item is about, and whether the viewer may act on it.
 * The route and the MCP tool both ask here, so they refuse the same things.
 */

import type { Database } from "bun:sqlite";
import { audienceFilter } from "../core/event_audience.ts";
import { getEvent } from "../core/events.ts";
import { ITEM_ID, type InteractionKind } from "../core/interactions.ts";
import { canRead, getRepo, getRepoById } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";

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

/** Why an act on the feed was refused: the same code and words at every door. */
export interface InteractionRefusal {
  readonly code: "invalid_item" | "invalid_kind" | "not_found";
  readonly message: string;
}

export interface InteractionAct<K extends string = InteractionKind> {
  readonly itemId: string;
  readonly kind: K;
  readonly target: InteractionTarget;
}

/** An item the viewer cannot read is refused in the same words as one that does not exist. */
export const NO_SUCH_ITEM = "no such item, or it is not visible to you";

const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/**
 * An act as a door received it (`{ item, kind, app? }`), checked: the item is
 * a feed item id, the kind is one of `kinds` (the door's own), and the
 * viewer may act on what the item is about.
 */
export function readInteraction<K extends string = InteractionKind>(
  db: Database,
  viewer: User,
  input: { readonly item?: unknown; readonly kind?: unknown; readonly app?: unknown },
  kinds: readonly K[],
): Result<InteractionAct<K>, InteractionRefusal> {
  const itemId = text(input.item);
  if (!ITEM_ID.test(itemId))
    return err({ code: "invalid_item", message: "item is a feed item id" });
  const kind = kinds.find((k) => k === input.kind);
  if (kind === undefined)
    return err({ code: "invalid_kind", message: `kind is one of ${kinds.join(", ")}` });
  const target = interactionTarget(db, viewer, itemId, text(input.app));
  if (!target) return err({ code: "not_found", message: NO_SUCH_ITEM });
  return ok({ itemId, kind, target });
}
