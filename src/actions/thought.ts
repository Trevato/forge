/**
 * Keep a thought exactly as it was typed (#1658). The text is stored
 * verbatim — never trimmed, normalised or deduplicated; an empty one and a
 * repeat are kept like any other. A thought is appended and nothing in
 * `src/` changes or removes one (`test/thoughts.test.ts` greps for it).
 */

import type { App } from "../app.ts";
import type { User } from "../core/users.ts";
import { id } from "../kernel/id.ts";
import { err, ok, type Result } from "../kernel/result.ts";

/** The longest thought kept, in characters (UTF-16 code units). */
export const THOUGHT_MAX = 20_000;

export type ThoughtSource = "composer" | "api" | "mcp" | "share";
export type ThoughtError = "unauthorized" | "not_text" | "too_long";

export function keepThought(
  app: App,
  actor: User | undefined,
  text: unknown,
  source: ThoughtSource,
): Result<{ id: string; receivedAt: string }, ThoughtError> {
  if (!actor) return err("unauthorized");
  if (typeof text !== "string") return err("not_text");
  if (text.length > THOUGHT_MAX) return err("too_long");
  const thoughtId = id();
  const receivedAt = new Date().toISOString();
  app.db.transaction(() => {
    app.db
      .query(
        "INSERT INTO thought (id, author, text, source, received_at) VALUES (?1, ?2, ?3, ?4, ?5)",
      )
      .run(thoughtId, actor.id, text, source, receivedAt);
    // The text stays out of the outbox: the event says one arrived.
    app.bus.append({
      kind: "thought.received",
      actorId: actor.id,
      payload: { id: thoughtId, source },
    });
  })();
  return ok({ id: thoughtId, receivedAt });
}
