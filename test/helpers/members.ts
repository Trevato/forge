import type { Database } from "bun:sqlite";
import { setMember } from "../../src/core/roles.ts";

/**
 * Make accounts members. A guest cannot own a repository, make an app their
 * own or start a crew run (`test/guests.test.ts` holds that); suites about
 * something else whose people make things promote them first, as an owner
 * would. With no accounts named, every person not yet a member is promoted:
 * for suites whose people sign up over HTTP.
 */
export function promote(db: Database, ...users: readonly { readonly id: string }[]): void {
  const now = new Date();
  const ids =
    users.length > 0
      ? users.map((u) => u.id)
      : db
          .query<{ id: string }, []>(
            "SELECT id FROM user WHERE kind = 'user' AND is_agent = 0 AND id NOT IN (SELECT user_id FROM member)",
          )
          .all()
          .map((r) => r.id);
  for (const id of ids) setMember(db, id, true, id, now);
}
