/**
 * A rate on what a guest (a key with no account) may say over ssh: `tell` and
 * `talk` each start work, and a key costs a guest nothing to make, so the
 * limit is on the address beside the key, with a cap on all guests together.
 * The address is the TCP peer's (a proxy's, when one fronts the port).
 * Pure: the clock is passed in.
 */

export const GUEST_SAYS_PER_WINDOW = 5;
export const GUEST_SAYS_ALL_PER_WINDOW = 60;
export const GUEST_WINDOW_MS = 60_000;

export const GUEST_RATE_WORDS = "slow down — a guest may tell or talk only a few times a minute; sign in to lift that";

export class GuestRate {
  private all: number[] = [];
  private readonly by = new Map<string, number[]>();

  constructor(
    private readonly each = GUEST_SAYS_PER_WINDOW,
    private readonly total = GUEST_SAYS_ALL_PER_WINDOW,
    private readonly windowMs = GUEST_WINDOW_MS,
  ) {}

  /** Count one say by `who` (key fingerprint and address both); false when over a limit. */
  allow(who: readonly string[], now: number): boolean {
    const since = now - this.windowMs;
    this.all = this.all.filter((t) => t > since);
    if (this.all.length >= this.total) return false;
    const lists = who.map((w) => (this.by.get(w) ?? []).filter((t) => t > since));
    if (lists.some((l) => l.length >= this.each)) return false;
    who.forEach((w, i) => {
      lists[i]!.push(now);
      this.by.set(w, lists[i]!);
    });
    this.all.push(now);
    if (this.by.size > 4096) for (const [k, v] of this.by) if (v.every((t) => t <= since)) this.by.delete(k);
    return true;
  }
}
