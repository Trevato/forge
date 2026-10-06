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
  /** The forge the request reached: what it holds is that forge's. */
  readonly db: Database;
  readonly userId: string;
  /** The signed-in browser, when a session cookie asked. */
  readonly sessionId: string | undefined;
}

type Held = Map<string, Set<() => void>>;

const callers = new WeakMap<Request, Caller>();
/**
 * What is held open, per forge (by its database, so two forges in one
 * process never sweep each other's), by `user:<id>` and, for a browser,
 * `session:<id>` too.
 */
const registries = new WeakMap<Database, Held>();

function heldBy(db: Database): Held {
  let held = registries.get(db);
  if (held === undefined) registries.set(db, (held = new Map()));
  return held;
}

/** The listener notes the signed-in account (and browser) behind a request. */
export const noteCaller = (
  request: Request,
  db: Database,
  userId: string,
  sessionId?: string,
): void => {
  callers.set(request, { db, userId, sessionId });
};

function hold(held: Held, key: string, close: () => void): () => void {
  let set = held.get(key);
  if (set === undefined) held.set(key, (set = new Set()));
  set.add(close);
  return () => {
    set.delete(close);
    if (set.size === 0 && held.get(key) === set) held.delete(key);
  };
}

/**
 * Keep `close` while something the account (and, when given, its browser)
 * opened on this forge is open. `close` must be safe to call more than
 * once; the returned function forgets it, and is called when the thing
 * closes on its own.
 */
export function holdOpen(
  db: Database,
  userId: string,
  sessionId: string | undefined,
  close: () => void,
): () => void {
  const held = heldBy(db);
  const releases = [hold(held, `user:${userId}`, close)];
  if (sessionId !== undefined)
    releases.push(hold(held, `session:${sessionId}`, close));
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
  return holdOpen(caller.db, caller.userId, caller.sessionId, close);
}

/**
 * Close everything under `key`. Each closer is on its own: one that throws
 * (a socket already broken, a session already gone) neither stops the rest
 * nor escapes into the timer that called this.
 */
function closeAll(held: Held, key: string, onError: (error: unknown) => void): void {
  const set = held.get(key);
  if (set === undefined) return;
  held.delete(key);
  for (const close of [...set]) {
    try {
      close();
    } catch (error) {
      onError(error);
    }
  }
}

const ignore = (): void => {};

/** End everything this account holds open on this forge. */
export const closeStreamsOf = (
  db: Database,
  userId: string,
  onError: (error: unknown) => void = ignore,
): void => closeAll(heldBy(db), `user:${userId}`, onError);

/** End what one signed-in browser opened (`actions/signins.ts`). */
export const closeStreamsOfSession = (
  db: Database,
  sessionId: string,
  onError: (error: unknown) => void = ignore,
): void => closeAll(heldBy(db), `session:${sessionId}`, onError);

const heldIds = (held: Held, prefix: string): string[] =>
  [...held.keys()]
    .filter((k) => k.startsWith(prefix))
    .map((k) => k.slice(prefix.length));

/** Ids per query: well under SQLite's limit on bound variables. */
const CHUNK = 500;

/** The ids among `ids` a query keeps, asked a chunk at a time. */
function kept(
  db: Database,
  sql: (marks: string) => string,
  ids: string[],
  extra: string[] = [],
): Set<string> {
  const out = new Set<string>();
  for (let at = 0; at < ids.length; at += CHUNK) {
    const chunk = ids.slice(at, at + CHUNK);
    const marks = chunk.map((_, i) => `?${i + 1 + extra.length}`).join(",");
    for (const r of db
      .query<{ id: string }, string[]>(sql(marks))
      .all(...extra, ...chunk))
      out.add(r.id);
  }
  return out;
}

/**
 * Hold what this forge has open against the facts in its database: an
 * account no longer in good standing, or a browser whose session is gone,
 * has what it holds here closed. Each process runs this on its own timer,
 * so nothing here may throw: a database that is busy or closed, or a
 * closer that fails, is reported and the next sweep tries again.
 */
export function sweepStanding(
  db: Database,
  onError: (error: unknown) => void = ignore,
): void {
  const held = registries.get(db);
  if (held === undefined || held.size === 0) return;
  try {
    const users = heldIds(held, "user:");
    const standing = kept(
      db,
      (marks) =>
        `SELECT id FROM user WHERE id IN (${marks})
           AND suspended_at IS NULL AND removed_at IS NULL`,
      users,
    );
    for (const id of users)
      if (!standing.has(id)) closeAll(held, `user:${id}`, onError);
    const sessions = heldIds(held, "session:");
    const live = kept(
      db,
      (marks) =>
        `SELECT id FROM session WHERE expires_at > ?1 AND id IN (${marks})`,
      sessions,
      [new Date().toISOString()],
    );
    for (const id of sessions)
      if (!live.has(id)) closeAll(held, `session:${id}`, onError);
  } catch (error) {
    onError(error);
  }
}
