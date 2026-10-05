/**
 * Who a request is from, noted once auth is resolved, so something that
 * outlives the request — a live stream — can be found again by account.
 * The account's standing is what ends it (`actions/accounts.ts`): a
 * suspended or removed person's open streams close then, instead of when
 * they close by themselves.
 */

const callers = new WeakMap<Request, string>();
const streams = new Map<string, Set<() => void>>();

/** The listener notes the signed-in account behind a request. */
export const noteCaller = (request: Request, userId: string): void => {
  callers.set(request, userId);
};

/**
 * Keep `close` for as long as a stream opened by this request is open. The
 * returned function forgets it; a request with no account notes nothing.
 */
export function holdForCaller(request: Request, close: () => void): () => void {
  const userId = callers.get(request);
  if (userId === undefined) return () => {};
  let held = streams.get(userId);
  if (held === undefined) streams.set(userId, (held = new Set()));
  held.add(close);
  return () => {
    held.delete(close);
    if (held.size === 0) streams.delete(userId);
  };
}

/** End every stream this account has open. */
export function closeStreamsOf(userId: string): void {
  const held = streams.get(userId);
  if (held === undefined) return;
  streams.delete(userId);
  for (const close of [...held]) close();
}
