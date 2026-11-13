/**
 * The worker side of the waiting counts in `pipeline.ts`: count the rows of
 * one stage's query on a read-only handle of its own, so the forge's one
 * thread never walks the issues (and, when their pages are cold, never waits
 * on the disk) to answer "how many are ready".
 */

import { Database } from "bun:sqlite";

/** What the worker is asked: the database file, the stage's query and its arguments. */
export interface WaitingJob {
  readonly id: number;
  readonly path: string;
  readonly sql: string;
  readonly args: readonly string[];
}

/** What it answers: the count and the oldest `since`, or why it could not. */
export interface WaitingAnswer {
  readonly id: number;
  readonly n?: number;
  readonly oldest?: string | null;
  readonly error?: string;
}

declare const self: Worker;

const handles = new Map<string, Database>();

self.onmessage = (e: MessageEvent<WaitingJob>) => {
  const { id, path, sql, args } = e.data;
  try {
    let db = handles.get(path);
    if (db === undefined) {
      db = new Database(path, { readonly: true });
      db.run("PRAGMA busy_timeout = 5000");
      handles.set(path, db);
    }
    const r = db
      .query<{ n: number; oldest: string | null }, string[]>(
        `SELECT COUNT(*) AS n, MIN(since) AS oldest FROM (${sql})`,
      )
      .get(...args);
    postMessage({ id, n: r?.n ?? 0, oldest: r?.oldest ?? null } satisfies WaitingAnswer);
  } catch (error) {
    postMessage({ id, error: String(error) } satisfies WaitingAnswer);
  }
};
