/**
 * What an account holds open, and the one rule that ends it.
 *
 * Who a request is from is noted once auth is resolved, so what outlives
 * the request can be found again by account and by browser: a live event
 * stream, a proxied app socket, a git transfer under way, an SSH session.
 * The account's standing ends them: a suspended or removed person, or a
 * browser signed out, holds nothing open for long.
 *
 * The fact is written once, by the process that changes it (the account's
 * row, the session's row). Every process serving the forge enforces it
 * (#846): the one that wrote it at once, through its bus, and every one —
 * a roll's draining process included (#875) — on its own sweep of what it
 * holds against the database, so the overlap of a roll has no gap.
 */

import type { Database } from "bun:sqlite";

interface Caller {
  readonly userId: string;
  /** The signed-in browser, when a session cookie asked. */
  readonly sessionId: string | undefined;
}

const callers = new WeakMap<Request, Caller>();
/** What is held open, by `user:<id>` and, for a browser, `session:<id>` too. */
const streams = new Map<string, Set<() => void>>();

/** The listener notes the signed-in account (and browser) behind a request. */
export const noteCaller = (
  request: Request,
  userId: string,
  sessionId?: string,
): void => {
  callers.set(request, { userId, sessionId });
};

function hold(key: string, close: () => void): () => void {
  let held = streams.get(key);
  if (held === undefined) streams.set(key, (held = new Set()));
  held.add(close);
  return () => {
    held.delete(close);
    if (held.size === 0) streams.delete(key);
  };
}

/**
 * Keep `close` while something the account (and, when given, its browser)
 * opened is open. `close` must be safe to call more than once; the returned
 * function forgets it, and is called when the thing closes on its own.
 */
export function holdOpen(
  userId: string,
  sessionId: string | undefined,
  close: () => void,
): () => void {
  const releases = [hold(`user:${userId}`, close)];
  if (sessionId !== undefined) releases.push(hold(`session:${sessionId}`, close));
  return () => {
    for (const release of releases) release();
  };
}

/**
 * Keep `close` for as long as what this request opened is open. A request
 * with no account notes nothing.
 */
export function holdForCaller(request: Request, close: () => void): () => void {
  const caller = callers.get(request);
  if (caller === undefined) return () => {};
  return holdOpen(caller.userId, caller.sessionId, close);
}

function closeAll(key: string): void {
  const held = streams.get(key);
  if (held === undefined) return;
  streams.delete(key);
  for (const close of [...held]) close();
}

/** End everything this account holds open. */
export const closeStreamsOf = (userId: string): void =>
  closeAll(`user:${userId}`);

/** End what one signed-in browser opened (`actions/signins.ts`). */
export const closeStreamsOfSession = (sessionId: string): void =>
  closeAll(`session:${sessionId}`);

const heldIds = (prefix: string): string[] =>
  [...streams.keys()]
    .filter((k) => k.startsWith(prefix))
    .map((k) => k.slice(prefix.length));

/** The ids among `ids` a query keeps, asked in one statement. */
function kept(db: Database, sql: (marks: string) => string, ids: string[], extra: string[] = []): Set<string> {
  if (ids.length === 0) return new Set();
  const marks = ids.map((_, i) => `?${i + 1 + extra.length}`).join(",");
  return new Set(
    db
      .query<{ id: string }, string[]>(sql(marks))
      .all(...extra, ...ids)
      .map((r) => r.id),
  );
}

/**
 * Hold what is open against the facts in the database: an account no longer
 * in good standing, or a browser whose session is gone, has what it holds
 * here closed. Each process runs this on its own timer.
 */
export function sweepStanding(db: Database): void {
  const users = heldIds("user:");
  const standing = kept(
    db,
    (marks) =>
      `SELECT id FROM user WHERE id IN (${marks})
         AND suspended_at IS NULL AND removed_at IS NULL`,
    users,
  );
  for (const id of users) if (!standing.has(id)) closeAll(`user:${id}`);
  const sessions = heldIds("session:");
  const live = kept(
    db,
    (marks) => `SELECT id FROM session WHERE expires_at > ?1 AND id IN (${marks})`,
    sessions,
    [new Date().toISOString()],
  );
  for (const id of sessions) if (!live.has(id)) closeAll(`session:${id}`);
}
