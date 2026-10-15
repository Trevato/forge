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

/** The author's newest thoughts received at or after `since` (ISO), newest first; the text exactly as kept. */
export function recentThoughts(db: Database, authorId: string, limit: number, since = ""): Thought[] {
  return db
    .query<
      { id: string; text: string; source: string; received_at: string },
      [string, string, number]
    >(
      "SELECT id, text, source, received_at FROM thought WHERE author = ?1 AND received_at >= ?2 ORDER BY received_at DESC, id DESC LIMIT ?3",
    )
    .all(authorId, since, limit)
    .map((r) => ({ id: r.id, text: r.text, source: r.source, receivedAt: r.received_at }));
}

/** One of the author's thoughts by id, or nothing (a thought is its author's alone). */
export function thoughtOf(db: Database, authorId: string, id: string): Thought | undefined {
  const r = db
    .query<{ id: string; text: string; source: string; received_at: string }, [string, string]>(
      "SELECT id, text, source, received_at FROM thought WHERE author = ?1 AND id = ?2",
    )
    .get(authorId, id);
  return r ? { id: r.id, text: r.text, source: r.source, receivedAt: r.received_at } : undefined;
}
