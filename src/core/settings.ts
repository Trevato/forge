/**
 * Per-user interface preferences — a two-column key/value bag scoped to an
 * account. Deliberately not events: a theme choice is not platform state, no
 * consumer could act on it, and appending one per keystroke would flood the
 * outbox. Losing the table costs a user one keypress, which is the bar
 * invariant 4 sets for anything that lives only in the index.
 */

import type { Database } from "bun:sqlite";

const MAX_VALUE = 200;

/** The setting that says the preview admin was seeded: only a preview has it. */
export const PREVIEW_SEEDED = "preview_seeded";

export function getUserSetting(
  db: Database,
  userId: string,
  key: string,
): string | undefined {
  const row = db
    .query<
      { value: string },
      [string, string]
    >("SELECT value FROM user_setting WHERE user_id = ?1 AND key = ?2")
    .get(userId, key);
  return row?.value;
}

export function setUserSetting(
  db: Database,
  userId: string,
  key: string,
  value: string,
): void {
  db.query(
    `INSERT INTO user_setting (user_id, key, value) VALUES (?1, ?2, ?3)
     ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value`,
  ).run(userId, key, value.slice(0, MAX_VALUE));
}
