/**
 * Internal calls the forge refused for lacking its boot secret. The internal
 * door is for the hook client alone; a call without the secret is a process
 * on this machine trying it, or a bug in a part that should hold it. Either
 * way the sentinel says so (`vitals`). Kept in memory and bounded: a count
 * per hour and the latest few, never the caller's bytes beyond a clipped path.
 */

const WINDOW_MS = 3_600_000;
const KEEP = 50;
/** The liveness probe a booting forge sends to a socket it does not own. */
const PROBE = "/internal/ping";

export interface RefusedCall {
  readonly at: number;
  readonly method: string;
  readonly path: string;
}

/** One forge's count (`App.signals.refused`). */
export class RefusedLedger {
  private seen: RefusedCall[] = [];

  /** Note one refused internal call; the probe is expected and not counted. */
  note(method: string, path: string, now: number = Date.now()): boolean {
    if (path === PROBE) return false;
    this.seen.push({
      at: now,
      method: method.slice(0, 16),
      path: path.replace(/[^\x21-\x7e]/g, "?").slice(0, 120),
    });
    if (this.seen.length > KEEP) this.seen = this.seen.slice(-KEEP);
    return true;
  }

  recent(now: number = Date.now()): {
    lastHour: number;
    latest: RefusedCall | undefined;
  } {
    const recent = this.seen.filter((c) => now - c.at < WINDOW_MS);
    return { lastHour: recent.length, latest: recent.at(-1) };
  }

  clear(): void {
    this.seen = [];
  }
}

export function noteRefusedInternal(
  method: string,
  path: string,
  now: number,
  ledger: RefusedLedger,
): boolean {
  return ledger.note(method, path, now);
}

export function refusedInternal(now: number, ledger: RefusedLedger) {
  return ledger.recent(now);
}
