/**
 * What a stranger — a request with no session and no token — may spend.
 *
 * A signed-in caller is limited by its token (`core/ratelimit.ts`) and is
 * someone the forge can suspend. A stranger is neither, and the doors open
 * to everyone are the expensive ones: a clone holds a transfer permit for
 * minutes, a code search runs `git grep` over fifty repositories, a stream
 * holds a connection open for as long as the client likes, a spawn plan
 * walks what a catalog app carries. Each door here has two limits, one per
 * client address (`peer.ts`'s bucket, an IPv6 /64) and one for the whole
 * forge, so a thousand addresses cannot do together what one may not —
 * and the forge-wide one is what keeps a share of every pool for pushes,
 * page renders and agents.
 *
 * Rates are a sliding minute (`RateLimiter`); what is held — a transfer, a
 * search, a stream — is counted while it is held and given back on every
 * path out. One set per forge, so a test's forge never throttles another's.
 */

import type { App } from "../app.ts";
import { RateLimiter, type Verdict } from "../core/ratelimit.ts";
import { transferGate } from "../git/env.ts";
import { bucketOf, clientBucket } from "./peer.ts";

/** A door a stranger is counted at, each with its own minute. */
export type Door = "api" | "git" | "code" | "plan" | "pay";

export interface StrangerLimits {
  /** Requests per minute through each door, per client address. */
  readonly perAddress: Readonly<Record<Door, number>>;
  /** Requests per minute through each door, every stranger together. */
  readonly forge: Readonly<Record<Door, number>>;
  /** Pack transfers one address may hold at once. */
  readonly transfersPerAddress: number;
  /**
   * The share of the transfer pool strangers may hold together: the rest is
   * kept for pushes and signed-in clones. At least one permit.
   */
  readonly transferShare: number;
  /**
   * A stranger's fetch is killed after this long, however well it moves.
   * It is killed sooner once it stalls (`git/progress.ts`), as anyone's is.
   */
  readonly transferTimeoutMs: number;
  /** A fetch's request body that stops arriving for this long ends the fetch. */
  readonly transferIdleMs: number;
  /**
   * Code searches strangers may run at once, every one together. One search
   * greps four repositories at a time (`core/search.ts`), so one is half the
   * eight-permit plumbing pool and the other half stays the forge's own.
   */
  readonly codeAtOnce: number;
  /** Event streams one address may hold open. */
  readonly streamsPerAddress: number;
  /** Event streams strangers may hold open, every one together. */
  readonly strangerStreams: number;
  /** Event streams anyone may hold open on this forge. */
  readonly allStreams: number;
}

export const STRANGER_LIMITS: StrangerLimits = {
  perAddress: { api: 600, git: 60, code: 10, plan: 10, pay: 5 },
  forge: { api: 6000, git: 600, code: 60, plan: 60, pay: 60 },
  transfersPerAddress: 4,
  transferShare: 0.5,
  transferTimeoutMs: 7_200_000,
  transferIdleMs: 30_000,
  codeAtOnce: 1,
  streamsPerAddress: 8,
  strangerStreams: 256,
  allStreams: 4096,
};

/** A door refused: what to say, and when to come back (seconds). */
export interface Refused {
  readonly allowed: false;
  readonly retryAfter: number;
  readonly why: string;
}

/** Something held, given back by `release` (idempotent). */
export interface Held {
  readonly allowed: true;
  readonly release: () => void;
}

interface State {
  limits: StrangerLimits;
  readonly perAddress: Map<Door, RateLimiter>;
  readonly forge: Map<Door, RateLimiter>;
  /** What is held right now, by key: "transfer:<bucket>", "code", "stream:*". */
  readonly held: Map<string, number>;
  /** The time the rate windows are counted by; a test hands in its own. */
  now: () => number;
  /** Woken, once, by the next hold or release: what a waiting test sleeps on. */
  changed: (() => void)[];
}

const states = new WeakMap<App, State>();

function stateOf(app: App): State {
  let state = states.get(app);
  if (state === undefined) {
    state = {
      limits: STRANGER_LIMITS,
      perAddress: new Map(),
      forge: new Map(),
      held: new Map(),
      now: Date.now,
      changed: [],
    };
    states.set(app, state);
  }
  return state;
}

const minute = (state: State, perMinute: number): RateLimiter =>
  new RateLimiter(
    { perMinute, adminPerMinute: perMinute, enabled: true },
    () => state.now(),
  );

function limiter(
  state: State,
  map: Map<Door, RateLimiter>,
  door: Door,
  perMinute: number,
): RateLimiter {
  let found = map.get(door);
  if (found === undefined) {
    found = minute(state, perMinute);
    map.set(door, found);
  }
  return found;
}

/** This forge's limits for strangers. */
export const strangerLimits = (app: App): StrangerLimits => stateOf(app).limits;

/**
 * Test seam and operator lever: new limits for this forge's strangers.
 * Counted minutes start over.
 */
export function setStrangerLimits(
  app: App,
  change: Partial<StrangerLimits>,
): void {
  const state = stateOf(app);
  state.limits = { ...state.limits, ...change };
  state.perAddress.clear();
  state.forge.clear();
}

/**
 * Test seam: count the rate windows by `now` instead of the wall clock, so a
 * slow request never slides one. Counted minutes start over.
 */
export function setStrangerClock(app: App, now: () => number): void {
  const state = stateOf(app);
  state.now = now;
  state.perAddress.clear();
  state.forge.clear();
}

/** Resolves at the next hold or release on this forge — for tests to wait on. */
export const heldChanged = (app: App): Promise<void> =>
  new Promise((resolve) => stateOf(app).changed.push(resolve));

function wake(state: State): void {
  const waiting = state.changed.splice(0);
  for (const resolve of waiting) resolve();
}

/**
 * Count one stranger's request through `door`: refused when its address or
 * every stranger together has spent the minute. A refusal is not counted
 * (`RateLimiter.take`), and one refused forge-wide gives back the address's
 * count, so a closed door does not push anyone's window forward.
 */
export const takeDoor = (app: App, door: Door, request: Request): Verdict =>
  takeDoorAt(app, door, clientBucket(request));

/**
 * `takeDoor` for a client that is not an HTTP request — a terminal guest —
 * keyed on its address's bucket (`peer.ts`'s `bucketOf`, an IPv6 /64).
 */
export function takeDoorAt(app: App, door: Door, bucket: string): Verdict {
  const state = stateOf(app);
  const mine = limiter(state, state.perAddress, door, state.limits.perAddress[door]);
  const own = mine.take(bucket, "ro");
  if (!own.allowed) return own;
  const all = limiter(state, state.forge, door, state.limits.forge[door]).take("*", "ro");
  if (!all.allowed) {
    mine.refund(bucket);
    return all;
  }
  return own;
}

/** Take one of `key` if fewer than `max` are held; the release gives it back. */
function hold(state: State, key: string, max: number): (() => void) | undefined {
  const now = state.held.get(key) ?? 0;
  if (now >= max) return undefined;
  state.held.set(key, now + 1);
  wake(state);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (state.held.get(key) ?? 1) - 1;
    if (left <= 0) state.held.delete(key);
    else state.held.set(key, left);
    wake(state);
  };
}

/** Take every hold in `wants`, or none of them. */
function holdAll(
  state: State,
  wants: readonly (readonly [string, number])[],
): (() => void) | undefined {
  const taken: (() => void)[] = [];
  for (const [key, max] of wants) {
    const release = hold(state, key, max);
    if (release === undefined) {
      for (const give of taken) give();
      return undefined;
    }
    taken.push(release);
  }
  return () => {
    for (const give of taken) give();
  };
}

const refused = (why: string, retryAfter: number): Refused => ({
  allowed: false,
  retryAfter,
  why,
});

/**
 * A stranger's pack transfer (a clone's ref advertisement or its fetch):
 * counted against the minute, then held — at most `transfersPerAddress` per
 * address, and together at most `transferShare` of the transfer pool, so a
 * crowd of anonymous clones never stands between a push and its permit.
 */
export function strangerTransfer(app: App, request: Request): Held | Refused {
  const verdict = takeDoor(app, "git", request);
  if (!verdict.allowed)
    return refused(
      "too many anonymous git requests; sign in or retry later",
      verdict.retryAfter,
    );
  const state = stateOf(app);
  const share = Math.max(
    1,
    Math.floor(transferGate.limit * state.limits.transferShare),
  );
  const release = holdAll(state, [
    [`transfer:${clientBucket(request)}`, state.limits.transfersPerAddress],
    ["transfer", share],
  ]);
  if (release === undefined)
    return refused(
      "too many anonymous git transfers at once; sign in or retry shortly",
      5,
    );
  return { allowed: true, release };
}

/**
 * A stranger's code search: counted against the minute, then held — at most
 * `codeAtOnce` searches by strangers at a time, the whole forge together.
 */
export const strangerCodeSearch = (app: App, request: Request): Held | Refused =>
  codeSearchAt(app, clientBucket(request));

/**
 * `strangerCodeSearch` for a terminal guest (any SSH key the forge does not
 * know), counted under its peer address: the palette's search greps code too.
 */
export const guestCodeSearch = (app: App, remoteAddress: string): Held | Refused =>
  codeSearchAt(app, bucketOf(remoteAddress));

function codeSearchAt(app: App, bucket: string): Held | Refused {
  const verdict = takeDoorAt(app, "code", bucket);
  if (!verdict.allowed)
    return refused(
      "too many anonymous code searches; sign in or retry later",
      verdict.retryAfter,
    );
  const state = stateOf(app);
  const release = hold(state, "code", state.limits.codeAtOnce);
  if (release === undefined)
    return refused("code search is busy for visitors who are not signed in", 2);
  return { allowed: true, release };
}

/**
 * An event stream: every one counts toward `allStreams`; a stranger's also
 * toward its address and toward every stranger's together.
 */
export function holdStream(
  app: App,
  request: Request,
  stranger: boolean,
): Held | Refused {
  const state = stateOf(app);
  const { limits } = state;
  const release = holdAll(
    state,
    stranger
      ? [
          ["stream:*", limits.allStreams],
          ["stream:strangers", limits.strangerStreams],
          [`stream:${clientBucket(request)}`, limits.streamsPerAddress],
        ]
      : [["stream:*", limits.allStreams]],
  );
  if (release === undefined)
    return refused(
      stranger
        ? "too many open streams for visitors who are not signed in"
        : "too many open streams",
      30,
    );
  return { allowed: true, release };
}

/** How many of `key` are held now — for tests. */
export const heldNow = (app: App, key: string): number =>
  stateOf(app).held.get(key) ?? 0;

/** The plain 429 every refused door answers with. */
export function tooManyStrangers(refusal: { retryAfter: number; why: string }): Response {
  return new Response(`${refusal.why}\n`, {
    status: 429,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "retry-after": String(Math.max(1, refusal.retryAfter)),
      "cache-control": "no-store",
    },
  });
}
