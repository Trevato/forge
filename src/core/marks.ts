/**
 * The mark a name wears: who it is, said by the forge.
 *
 * Reserved names stop a newcomer from taking the owner's or the crew's name
 * or a look-alike (`core/reserved.ts`), and a display name is held to the
 * same rule where it is written. The last defence is where names are read.
 * Beside the owner's name and each agent's the forge draws a mark, from the
 * account's kind and standing — never from anything a person typed. A
 * display name can say "owner" in any alphabet or emoji; it cannot produce
 * the element that carries `data-mark`, since every name is escaped on the
 * way out. A name with no mark is nobody the mark would vouch for.
 *
 * "Owner" is a site admin who is a person; the crew is every agent. An
 * admin's everyday account (`core/everyday.ts`) is an ordinary account by
 * design and wears none.
 */

import type { Database } from "bun:sqlite";
import type { User } from "./users.ts";

export type Mark = "owner" | "crew";

/** The mark an account wears, or undefined for an ordinary one. */
export function markOf(
  user: Pick<User, "kind" | "isAdmin"> | undefined,
): Mark | undefined {
  if (user === undefined) return undefined;
  if (user.kind === "agent") return "crew";
  if (user.kind === "user" && user.isAdmin) return "owner";
  return undefined;
}

/**
 * The marks of many names in one read: a page asks once for every author it
 * will show. Names that wear none are not in the map.
 */
export function marksByName(
  db: Database,
  names: Iterable<string>,
): Map<string, Mark> {
  const unique = [...new Set(names)].filter((n) => n !== "");
  const out = new Map<string, Mark>();
  if (unique.length === 0) return out;
  // The flag, not the column, says agent (`core/users.ts`, migration 14).
  const rows = db
    .query<
      {
        username: string;
        kind: "user" | "org";
        is_agent: number;
        is_admin: number;
      },
      string[]
    >(
      `SELECT username, kind, is_agent, is_admin FROM user
        WHERE username IN (${unique.map((_, i) => `?${i + 1}`).join(", ")})`,
    )
    .all(...unique);
  for (const row of rows) {
    const mark = markOf({
      kind: row.is_agent === 1 ? "agent" : row.kind,
      isAdmin: row.is_admin === 1,
    });
    if (mark !== undefined) out.set(row.username, mark);
  }
  return out;
}
