/**
 * What the SSH door admits before any key work: a cap on open connections,
 * a cap per address, and a rate on new handshakes. Each handshake costs an
 * X25519 exchange and an Ed25519 signature on the forge's one thread, so a
 * refusal here happens before a `Connection` (and its transport) exists.
 *
 * Whose address this is: SSH is raw TCP with no header to carry a client
 * address, so it is always the socket's peer — the proxy's, when a proxy or
 * load balancer fronts the port, and then every client behind it shares one
 * per-address budget. The `FORGE_TRUSTED_PROXIES` rule of `src/http/peer.ts`
 * has nothing to read here; which is why the per-address numbers are
 * generous and the global ones are the real floor. An IPv6 peer is keyed by
 * its /64.
 *
 * Pure state in, verdict out: the clock is passed in, nothing is timed here.
 */

import { addressBytes } from "../kernel/cidr.ts";

/** Open connections, all addresses together. */
export const MAX_CONNECTIONS = 256;
/** Open connections from one address. */
export const MAX_CONNECTIONS_PER_ADDRESS = 32;
/** New connections (each a handshake) from one address per window. */
export const MAX_HANDSHAKES_PER_ADDRESS = 20;
/** New connections from everyone per window. */
export const MAX_HANDSHAKES = 120;
export const HANDSHAKE_WINDOW_MS = 10_000;

export interface SshLimitValues {
  maxConnections: number;
  maxPerAddress: number;
  handshakesPerAddress: number;
  handshakes: number;
  windowMs: number;
}

export const DEFAULT_LIMITS: SshLimitValues = {
  maxConnections: MAX_CONNECTIONS,
  maxPerAddress: MAX_CONNECTIONS_PER_ADDRESS,
  handshakesPerAddress: MAX_HANDSHAKES_PER_ADDRESS,
  handshakes: MAX_HANDSHAKES,
  windowMs: HANDSHAKE_WINDOW_MS,
};

export type Refusal = "too many connections" | "too many from this address" | "too many handshakes";

/** The key a peer is limited under: the address, an IPv6 one cut to its /64. */
export function addressKey(peer: string): string {
  const bytes = addressBytes(peer);
  if (bytes === undefined || bytes.length !== 16) return peer;
  return Array.from(bytes.subarray(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
}

export class ConnectionLimits {
  private open = 0;
  private readonly perAddress = new Map<string, number>();
  private readonly starts = new Map<string, number[]>();
  private all: number[] = [];

  constructor(private readonly limits: SshLimitValues = DEFAULT_LIMITS) {}

  /** Admit a new connection (and count it), or say why not. */
  admit(peer: string, now: number): { key: string } | { refused: Refusal } {
    const key = addressKey(peer);
    const l = this.limits;
    if (this.open >= l.maxConnections) return { refused: "too many connections" };
    if ((this.perAddress.get(key) ?? 0) >= l.maxPerAddress) return { refused: "too many from this address" };
    const since = now - l.windowMs;
    this.all = this.all.filter((t) => t > since);
    const mine = (this.starts.get(key) ?? []).filter((t) => t > since);
    if (this.all.length >= l.handshakes || mine.length >= l.handshakesPerAddress) return { refused: "too many handshakes" };
    this.all.push(now);
    mine.push(now);
    this.starts.set(key, mine);
    if (this.starts.size > 4096) this.sweep(since);
    this.open++;
    this.perAddress.set(key, (this.perAddress.get(key) ?? 0) + 1);
    return { key };
  }

  /** A connection admitted under `key` has ended. */
  release(key: string): void {
    this.open = Math.max(0, this.open - 1);
    const left = (this.perAddress.get(key) ?? 1) - 1;
    if (left <= 0) this.perAddress.delete(key);
    else this.perAddress.set(key, left);
  }

  private sweep(since: number): void {
    for (const [key, times] of this.starts) {
      if (times.every((t) => t <= since)) this.starts.delete(key);
    }
  }
}
