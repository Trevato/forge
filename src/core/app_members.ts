/**
 * The people a private app names (#752): they may enter the app and its
 * previews, and that is all — naming someone gives no write, no crew, no
 * settings, and no reading of a private repository's code. Pure data: who
 * may change the list, and who may be on it, is `actions/app_members.ts`'s
 * to decide; `canEnterApp` reads it.
 */

import type { Database } from "bun:sqlite";

export interface AppMember {
  readonly userId: string;
  readonly username: string;
  readonly addedAt: string;
}

/** Whether this person is named by this app. */
export function isAppMember(
  db: Database,
  appId: string,
  userId: string,
): boolean {
  return (
    db
      .query(`SELECT 1 FROM app_member WHERE app_id = ?1 AND user_id = ?2`)
      .get(appId, userId) !== null
  );
}

/**
 * Of these apps, the ones that name `userId` — `isAppMember` for a whole
 * page in one read per chunk, never one per row.
 */
export function appsNaming(
  db: Database,
  userId: string,
  appIds: readonly string[],
): Set<string> {
  const out = new Set<string>();
  const unique = [...new Set(appIds)];
  const CHUNK = 400;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const batch = unique.slice(i, i + CHUNK);
    for (const row of db
      .query<{ app_id: string }, string[]>(
        `SELECT app_id FROM app_member WHERE user_id = ?1
           AND app_id IN (${batch.map((_, n) => `?${n + 2}`).join(",")})`,
      )
      .all(userId, ...batch))
      out.add(row.app_id);
  }
  return out;
}

/** Everyone an app names, by username. */
export function appMembers(db: Database, appId: string): AppMember[] {
  return db
    .query<{ user_id: string; username: string; added_at: string }, [string]>(
      `SELECT app_member.user_id, user.username, app_member.added_at
       FROM app_member JOIN user ON user.id = app_member.user_id
       WHERE app_member.app_id = ?1
       ORDER BY user.username COLLATE NOCASE`,
    )
    .all(appId)
    .map((r) => ({ userId: r.user_id, username: r.username, addedAt: r.added_at }));
}

/** Replace the list at once. */
export function setAppMembers(
  db: Database,
  appId: string,
  userIds: readonly string[],
  by: string,
): void {
  db.transaction(() => {
    db.query(`DELETE FROM app_member WHERE app_id = ?1`).run(appId);
    const put = db.query(
      `INSERT OR IGNORE INTO app_member (app_id, user_id, added_by) VALUES (?1, ?2, ?3)`,
    );
    for (const userId of userIds) put.run(appId, userId, by);
  })();
}
