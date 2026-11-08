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

/**
 * Every person this database ever holds is a member, for a suite whose people
 * sign up as they go and connect an origin or mirror: a guest does neither
 * (`test/guest-contribute.test.ts` holds that). A trigger on this connection,
 * so it asks nothing of the product.
 */
export function everyoneIsAMember(db: Database): void {
  promote(db);
  db.run(
    `CREATE TEMP TRIGGER IF NOT EXISTS everyone_is_a_member AFTER INSERT ON main.user
     WHEN NEW.kind = 'user' AND NEW.is_agent = 0
     BEGIN
       INSERT OR IGNORE INTO member (user_id, promoted_by, promoted_at) VALUES (NEW.id, NEW.id, '2026-01-01T00:00:00.000Z');
     END`,
  );
}
