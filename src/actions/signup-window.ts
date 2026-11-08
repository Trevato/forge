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
  if (!whole.allowed) return whole.retryAfter;
  return accountsWindow(app, address, Date.now());
}

const HOUR_MS = 3_600_000;
const FORGE_ROW = "*";

/**
 * Accounts made in the last hour, per source and forge-wide, kept in a table so
 * a restart does not hand out a fresh hour. A source's ceiling is never below
 * its per-minute limit, so raising that one on `/admin/limits` is enough.
 * Counted when an account is made: a typo in a password spends nothing here.
 */
function accountsWindow(app: App, address: string, now: number): number | undefined {
  const since = now - HOUR_MS;
  const made = (source: string): { n: number; first: number | null } =>
    app.db
      .query<{ n: number; first: number | null }, [string, number]>(
        "SELECT COUNT(*) AS n, MIN(made_at) AS first FROM signup_made WHERE source = ?1 AND made_at >= ?2",
      )
      .get(source, since) ?? { n: 0, first: null };
  const wait = (first: number | null): number => Math.max(1, Math.ceil(((first ?? now) + HOUR_MS - now) / 1000));
  const one = made(`source:${bucketOf(address)}`);
  if (one.n >= Math.max(limitValue(app.db, "signup.per_source_hour"), limitValue(app.db, "signup.per_source")))
    return wait(one.first);
  const whole = made(FORGE_ROW);
  return whole.n >= limitValue(app.db, "signup.per_forge_hour") ? wait(whole.first) : undefined;
}

/** One account made from `address`: counted, and the table pruned as it is written. */
function accountMade(app: App, address: string, now: number): void {
  app.db.query("DELETE FROM signup_made WHERE made_at < ?1").run(now - HOUR_MS);
  const add = app.db.query("INSERT INTO signup_made (source, made_at) VALUES (?1, ?2)");
  add.run(`source:${bucketOf(address)}`, now);
  add.run(FORGE_ROW, now);
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
  readonly #made: () => void;
  private constructor(made: () => void) {
    this.#made = made;
  }

  /** A slot, or the seconds to wait when the window is spent. */
  static take(app: App, address: string): SignupSlot | number {
    const wait = signupWindow(app, address);
    return wait === undefined ? new SignupSlot(() => accountMade(app, address, Date.now())) : wait;
  }

  get spent(): boolean {
    return this.#spent;
  }

  spend(): void {
    this.#spent = true;
    this.#made();
  }
}

export const waitText = (seconds: number): string =>
  seconds >= 120
    ? `Too many new accounts just now. Try again in ${Math.ceil(seconds / 60)} minutes.`
    : `Too many attempts. Try again in ${seconds === 1 ? "a second" : `${seconds} seconds`}.`;
