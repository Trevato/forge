/**
 * Sign-ups, throttled in two windows: a source may make a few accounts a
 * minute and the forge as a whole more. Every door that makes an account
 * from a stranger's hands asks here with the peer's address — the socket's,
 * never anything the client typed — so they share one count per source.
 * A refused call is not counted.
 */
import { RateLimiter } from "../core/ratelimit.ts";
import { bucketOf } from "../http/peer.ts";
import { limitValue } from "../settings/limits.ts";
import type { App } from "../app.ts";

const windows = new WeakMap<App, RateLimiter>();

/** Seconds to wait when refused, or undefined when this sign-up may go on. */
export function signupWindow(app: App, address: string): number | undefined {
  let limiter = windows.get(app);
  if (limiter === undefined) {
    limiter = new RateLimiter({ perMinute: 0, adminPerMinute: 0, enabled: true });
    windows.set(app, limiter);
  }
  // Read on every attempt, so a change on /admin/limits governs the next one.
  limiter.setLimits({
    perMinute: limitValue(app.db, "signup.per_source"),
    adminPerMinute: limitValue(app.db, "signup.per_forge"),
    enabled: true,
  });
  const one = limiter.take(`source:${bucketOf(address)}`, "ro");
  if (!one.allowed) return one.retryAfter;
  const whole = limiter.take("forge", "admin");
  return whole.allowed ? undefined : whole.retryAfter;
}

/**
 * A place in the sign-up window, taken by a stranger's door before it makes
 * an account. `createUser` asks a stranger's origin for one, so a door that
 * forgets the window cannot make an account at all; it holds for one
 * account. Only `take` makes one: the constructor is private and the
 * private field keeps a look-alike object from passing for it.
 */
export class SignupSlot {
  #spent = false;
  private constructor() {}

  /** A slot, or the seconds to wait when the window is spent. */
  static take(app: App, address: string): SignupSlot | number {
    const wait = signupWindow(app, address);
    return wait === undefined ? new SignupSlot() : wait;
  }

  get spent(): boolean {
    return this.#spent;
  }

  spend(): void {
    this.#spent = true;
  }
}

export const waitText = (seconds: number): string =>
  `Too many attempts. Try again in ${seconds === 1 ? "a second" : `${seconds} seconds`}.`;
