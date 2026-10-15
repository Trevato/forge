/**
 * Reading a person's own thoughts back (#1660). A thought is kept by
 * `actions/thought.ts`; here the newest few are listed for their author,
 * and only for them — a thought belongs to nobody else.
 */

import type { Database } from "bun:sqlite";

export interface Thought {
  id: string;
  text: string;
  source: string;
  receivedAt: string;
}

/** The author's newest thoughts, newest first; the text exactly as kept. */
export function recentThoughts(db: Database, authorId: string, limit: number): Thought[] {
  return db
    .query<
      { id: string; text: string; source: string; received_at: string },
      [string, number]
    >(
      "SELECT id, text, source, received_at FROM thought WHERE author = ?1 ORDER BY received_at DESC, id DESC LIMIT ?2",
    )
    .all(authorId, limit)
    .map((r) => ({ id: r.id, text: r.text, source: r.source, receivedAt: r.received_at }));
}
