/**
 * What a viewer may see, as one short string (#7660): their role, and the
 * repositories `REPO_VISIBLE` lets them read, the one rule every listing and
 * the feed share. Memory of what they were shown is only reused while this
 * is unchanged, so being removed from a team, losing admin, a repository
 * turning private or its owner being suspended each end it at once, with no
 * list of writes to remember to watch.
 */
import type { Database } from "bun:sqlite";
import type { User } from "./users.ts";
import { REPO_VISIBLE } from "./visibility.ts";

export function accessFingerprint(db: Database, user: User): string {
  const row = db
    .query<{ ids: string | null }, [string]>(
      `SELECT group_concat(id) AS ids FROM (SELECT repo.id AS id FROM repo WHERE ${REPO_VISIBLE} ORDER BY repo.id)`,
    )
    .get(user.id);
  return `${user.isAdmin ? "a" : "m"}${user.kind}.${Bun.hash(row?.ids ?? "").toString(36)}`;
}
