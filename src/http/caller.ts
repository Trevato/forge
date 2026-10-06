/**
 * Who a request is from, noted once auth is resolved, so something that
 * outlives the request — a live stream — can be found again by account.
 * The account's standing is what ends it (`actions/accounts.ts`): a
 * suspended or removed person's open streams close then, instead of when
 * they close by themselves.
 */

interface Caller {
  readonly userId: string;
  /** The signed-in browser, when a session cookie asked. */
  readonly sessionId: string | undefined;
}

const callers = new WeakMap<Request, Caller>();
/** Open streams by `user:<id>` and, for a browser, `session:<id>` too. */
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
 * Keep `close` for as long as a stream opened by this request is open. The
 * returned function forgets it; a request with no account notes nothing.
 */
export function holdForCaller(request: Request, close: () => void): () => void {
  const caller = callers.get(request);
  if (caller === undefined) return () => {};
  const releases = [hold(`user:${caller.userId}`, close)];
  if (caller.sessionId !== undefined)
    releases.push(hold(`session:${caller.sessionId}`, close));
  return () => {
    for (const release of releases) release();
  };
}

function closeAll(key: string): void {
  const held = streams.get(key);
  if (held === undefined) return;
  streams.delete(key);
  for (const close of [...held]) close();
}

/** End every stream this account has open. */
export const closeStreamsOf = (userId: string): void =>
  closeAll(`user:${userId}`);

/** End the streams one signed-in browser opened (`actions/signins.ts`). */
export const closeStreamsOfSession = (sessionId: string): void =>
  closeAll(`session:${sessionId}`);
