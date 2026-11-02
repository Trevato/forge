/**
 * Per-token rate limiting: one runaway agent must not starve the rest.
 *
 * The failure this prevents is specific and has a name. A build crew is
 * twenty processes sharing one forge; one of them gets into a poll loop with
 * no sleep in it and issues a thousand requests a second. Nothing here is
 * broken — every request is valid, authorised, and cheap — and yet everyone
 * else's latency goes through the floor. A limit is how the other nineteen
 * keep working while somebody fixes the twentieth.
 *
 * Deliberate choices:
 *
 * - **In memory, not in SQLite.** A limiter that writes a row per request is
 *   a limiter that makes the load problem worse. State this cheap and this
 *   disposable belongs in a Map; a restart forgiving everyone their last
 *   minute is the correct behaviour, not a gap.
 * - **A real sliding window**, not fixed buckets. Fixed buckets let a caller
 *   send 2× the limit across a boundary, which is exactly the burst the
 *   limit exists to stop. The cost is one timestamp per request in flight,
 *   bounded by the limit itself.
 * - **Sessions are exempt.** A browser is a person; a person cannot generate
 *   600 requests a minute, and throttling a UI to protect it from automation
 *   punishes the wrong party.
 * - **Read-only and write scopes share one budget.** The expensive thing is
 *   a request, not a mutation.
 */

/** Requests per window for an ordinary token. */
const DEFAULT_LIMIT = 600;
/** Admin tokens run the fleet; they get their own, larger allowance. */
const DEFAULT_ADMIN_LIMIT = 6_000;
/** The window a limit is counted over unless its `RateLimits` say otherwise. */
export const WINDOW_MS = 60_000;

const positive = (raw: string | undefined, fallback: number): number => {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

export interface RateLimits {
  /** Requests allowed per window: per minute, unless `windowMs` says otherwise. */
  readonly perMinute: number;
  readonly adminPerMinute: number;
  /** `false` turns the limiter off entirely (FORGE_RATE_LIMIT=0). */
  readonly enabled: boolean;
  /** The window's length, for a limit counted over more than a minute. */
  readonly windowMs?: number;
}

/**
 * Limits from the environment, read once per limiter. `FORGE_RATE_LIMIT=0`
 * is the off switch — an operator who wants no limit should be able to say
 * so without editing code.
 */
export function limitsFromEnv(
  env: Record<string, string | undefined> = process.env,
): RateLimits {
  const raw = env["FORGE_RATE_LIMIT"];
  if (raw !== undefined && Number(raw) === 0) {
    return { perMinute: 0, adminPerMinute: 0, enabled: false };
  }
  const perMinute = positive(raw, DEFAULT_LIMIT);
  return {
    perMinute,
    // An admin token is never held tighter than an ordinary one, whatever
    // FORGE_RATE_LIMIT_ADMIN says.
    adminPerMinute: Math.max(
      perMinute,
      positive(env["FORGE_RATE_LIMIT_ADMIN"], DEFAULT_ADMIN_LIMIT),
    ),
    enabled: true,
  };
}

export interface Verdict {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  /** Unix seconds when the window frees up — the `X-RateLimit-Reset` value. */
  readonly reset: number;
  /** Seconds to wait, for `Retry-After`. Only meaningful when refused. */
  readonly retryAfter: number;
}

/** Nothing was counted, because nothing is limited. */
const UNLIMITED: Verdict = {
  allowed: true,
  limit: 0,
  remaining: 0,
  reset: 0,
  retryAfter: 0,
};

export class RateLimiter {
  /** Key → the timestamps still inside the window, oldest first. */
  private readonly hits = new Map<string, number[]>();
  private lastSweep = 0;
  private readonly windowMs: number;

  constructor(
    private limits: RateLimits = limitsFromEnv(),
    private readonly now: () => number = Date.now,
  ) {
    this.windowMs = limits.windowMs ?? WINDOW_MS;
  }

  /** Take new numbers, honoured by the next `take`; counted hits are kept. */
  setLimits(limits: RateLimits): void {
    this.limits = limits;
  }

  get enabled(): boolean {
    return this.limits.enabled;
  }

  /**
   * Count one request against `key` and say whether it may proceed. A refused
   * request is *not* counted — otherwise a caller hammering a closed door
   * would keep pushing its own window forward and never get back in.
   */
  take(key: string, scope: "ro" | "rw" | "admin"): Verdict {
    if (!this.limits.enabled) return UNLIMITED;
    const limit =
      scope === "admin" ? this.limits.adminPerMinute : this.limits.perMinute;
    const at = this.now();
    const floor = at - this.windowMs;

    const times = this.hits.get(key) ?? [];
    // The window slid; drop what fell out of it. Times are appended in order,
    // so the expired ones are always a prefix.
    let first = 0;
    while (first < times.length && times[first]! <= floor) first++;
    const live = first === 0 ? times : times.slice(first);

    this.sweep(at);

    if (live.length >= limit) {
      const oldest = live[0] ?? at;
      const waitMs = Math.max(0, oldest + this.windowMs - at);
      this.hits.set(key, live);
      return {
        allowed: false,
        limit,
        remaining: 0,
        reset: Math.ceil((oldest + this.windowMs) / 1000),
        retryAfter: Math.max(1, Math.ceil(waitMs / 1000)),
      };
    }

    live.push(at);
    this.hits.set(key, live);
    return {
      allowed: true,
      limit,
      remaining: limit - live.length,
      reset: Math.ceil((at + this.windowMs) / 1000),
      retryAfter: 0,
    };
  }

  /**
   * Give back one counted request on `key`: the newest, so the window keeps
   * the older hits that free up first. For a caller that counts an attempt
   * before knowing whether it should count (a password that proves right).
   */
  refund(key: string): void {
    const times = this.hits.get(key);
    if (times === undefined || times.length === 0) return;
    times.pop();
  }

  /**
   * Forget keys whose whole window has passed. Without this the map grows by
   * one entry per token that ever spoke to the forge — small, but unbounded
   * is unbounded, and a fleet mints tokens.
   */
  private sweep(at: number): void {
    if (at - this.lastSweep < this.windowMs) return;
    this.lastSweep = at;
    const floor = at - this.windowMs;
    for (const [key, times] of this.hits) {
      if ((times[times.length - 1] ?? 0) <= floor) this.hits.delete(key);
    }
  }

  /** Test seam: start from an empty window. */
  reset(): void {
    this.hits.clear();
    this.lastSweep = 0;
  }

  /** Whether `key` is being tracked. */
  has(key: string): boolean {
    return this.hits.has(key);
  }

  /** How many keys are being tracked — for the leak test, not for callers. */
  get size(): number {
    return this.hits.size;
  }
}
