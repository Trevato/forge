/**
 * Another forge's signing keys, fetched once and kept. A key id that is not
 * in what was kept may mean the issuer rotated, so the set is fetched again
 * — once, and not again for a minute however many tokens name an unknown
 * kid, so a forged token cannot make this forge hammer its parent.
 */
import { readCapped } from "../origins/providers/http.ts";
import type { Jwk } from "../kernel/jwt.ts";

export const JWKS_FRESH_MS = 10 * 60_000;
export const JWKS_REFETCH_MS = 60_000;
const BODY_MAX = 64 * 1024;

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export class KeySet {
  private keys: Jwk[] = [];
  private at = -Infinity;
  private pending: Promise<void> | undefined;

  constructor(
    private readonly url: string,
    private readonly fetcher: Fetch = fetch,
  ) {}

  async find(kid: string, now = Date.now()): Promise<Jwk | undefined> {
    const kept = (): Jwk | undefined => this.keys.find((k) => k["kid"] === kid);
    if (now - this.at < JWKS_FRESH_MS && kept() !== undefined) return kept();
    if (now - this.at >= JWKS_REFETCH_MS) await this.load(now);
    return kept();
  }

  private load(now: number): Promise<void> {
    this.pending ??= (async () => {
      try {
        const res = await this.fetcher(this.url, { redirect: "error", signal: AbortSignal.timeout(5000) });
        if (!res.ok) return;
        const text = await readCapped(res, BODY_MAX, AbortSignal.timeout(5000));
        if (text === undefined) return;
        const list = (JSON.parse(text) as { keys?: unknown }).keys;
        if (!Array.isArray(list)) return;
        this.keys = list.filter((k): k is Jwk => typeof k === "object" && k !== null);
        this.at = now;
      } catch {
        // Unreachable or malformed: keep what we had; the caller refuses the token.
      } finally {
        this.pending = undefined;
      }
    })();
    return this.pending;
  }
}
