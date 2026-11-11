/**
 * The rule watcher's own account (#7560): an agent user with no password, so a
 * comment it posts shows as the watcher's and never as the repository owner's
 * words. Made on first use; the same row is found afterwards.
 */

import type { Database } from "bun:sqlite";
import { id } from "../kernel/id.ts";

export const BOT_NAME = "rule-watcher";

export function watcherId(db: Database): string {
  const found = db.query<{ id: string }, [string]>("SELECT id FROM user WHERE username = ?1 COLLATE NOCASE").get(BOT_NAME);
  if (found !== null) return found.id;
  const made = id();
  db.query(
    "INSERT OR IGNORE INTO user (id, username, email, password_hash, display_name, is_admin, is_agent) VALUES (?1, ?2, ?3, '', 'Rule watcher', 0, 1)",
  ).run(made, BOT_NAME, `${BOT_NAME}@agents.invalid`);
  return db.query<{ id: string }, [string]>("SELECT id FROM user WHERE username = ?1 COLLATE NOCASE").get(BOT_NAME)!.id;
}
