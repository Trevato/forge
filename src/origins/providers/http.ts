/**
 * The half of a provider that is the same on every forge: one careful HTTP
 * call, one honest failure vocabulary, and the readers that turn remote JSON
 * into values we are willing to store.
 *
 * Two rules run through all of it. Remote JSON has no shape until we check
 * it — a missing body is `""`, a missing number is `0`, never `undefined`
 * leaking into a column. And a remote refusal is data: an origin that is
 * rate-limited says so, with a time to come back, and the sync worker waits.
 */

import { redact } from "../credentials.ts";
import type {
  ProviderCredential,
  ProviderFailure,
  ProviderResult,
} from "../types.ts";

const TIMEOUT_MS = 20_000;
const MAX_BYTES = 16 * 1024 * 1024;
/** Same-origin redirects followed by hand (a renamed repo answers 301). */
const MAX_HOPS = 3;
/** Conditional-request cache size. Enough for a busy origin's hot lists. */
const ETAG_ENTRIES = 256;

export const fail = (
  error: ProviderFailure["error"],
  message: string,
  retryAt?: string,
): ProviderResult<never> => ({
  ok: false,
  error: { error, message, ...(retryAt === undefined ? {} : { retryAt }) },
});

export const succeed = <T>(value: T): ProviderResult<T> => ({
  ok: true,
  value,
});

export interface ApiResponse {
  readonly status: number;
  readonly data: unknown;
  readonly headers: Headers;
}

export interface ApiRequest {
  /** Path under the API base, e.g. `/user/repos`. Already URL-safe. */
  readonly path: string;
  /** @default "GET" */
  readonly method?: string;
  readonly query?: Record<string, string | number | undefined>;
  readonly body?: unknown;
  /** Send `If-None-Match` and serve a 304 from the cache. GETs only. */
  readonly conditional?: boolean;
}

interface CacheEntry {
  readonly etag: string;
  readonly data: unknown;
  readonly headers: Headers;
}

/**
 * A live conversation with one origin: the auth headers plus whatever
 * conditional-request state we have accumulated. Providers hold one of these
 * across syncs, which is what makes ETags worth anything.
 */
export interface ApiClientLimits {
  /** Per-request deadline, headers and body together. @default 20 s */
  readonly timeoutMs?: number;
  /** Largest body read; anything beyond it is refused. @default 16 MiB */
  readonly maxBytes?: number;
}

export class ApiClient {
  private readonly etags = new Map<string, CacheEntry>();
  private readonly timeoutMs: number;
  private readonly maxBytes: number;

  constructor(
    readonly credential: ProviderCredential,
    /** How this forge wants the secret presented, built fresh per call. */
    private readonly authHeaders: (token: string) => Record<string, string>,
    limits: ApiClientLimits = {},
  ) {
    this.timeoutMs = limits.timeoutMs ?? TIMEOUT_MS;
    this.maxBytes = limits.maxBytes ?? MAX_BYTES;
  }

  url(request: ApiRequest): string {
    const url = new URL(
      `${this.credential.apiUrl.replace(/\/+$/, "")}${request.path}`,
    );
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value === undefined || value === "") continue;
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  async call(request: ApiRequest): Promise<ProviderResult<ApiResponse>> {
    const url = this.url(request);
    const method = request.method ?? "GET";
    const cached =
      request.conditional && method === "GET" ? this.etags.get(url) : undefined;

    // Resolved per call: an OAuth token may have been refreshed since the
    // last one, and a token that cannot be resolved must not become a
    // credential-less request that reads as "not found".
    const token = await this.credential.token();
    if (!token.ok) return token;

    const headers: Record<string, string> = {
      accept: "application/json",
      "user-agent": "forge",
      ...this.authHeaders(token.value),
    };
    if (cached) headers["if-none-match"] = cached.etag;
    if (request.body !== undefined)
      headers["content-type"] = "application/json";

    // The token must never leave the origin it belongs to, so redirects are
    // followed by hand: a hop to the same origin (a renamed repo answers
    // 301) is fine, a hop anywhere else is refused outright. Bun's fetch
    // drops `authorization` on a cross-origin hop by itself, but a provider
    // header spelled any other way (GitLab's `PRIVATE-TOKEN`) and the request
    // body would still travel — and a redirected answer is one the origin
    // never gave, which is not something to import as truth. One deadline
    // covers headers and body: a server that answers instantly and then
    // never finishes the body is the same hang.
    const signal = AbortSignal.timeout(this.timeoutMs);
    const body =
      request.body === undefined ? undefined : JSON.stringify(request.body);
    let response: Response | undefined;
    let target = url;
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      if (!sameOrigin(target, url))
        return fail(
          "invalid_response",
          "the origin redirected off-host; refusing to follow",
        );
      let answer: Response;
      try {
        answer = await fetch(target, {
          method,
          headers,
          ...(body === undefined ? {} : { body }),
          redirect: "manual",
          signal,
        });
      } catch (error) {
        return fail("unreachable", redact(String(error), token.value));
      }
      if (answer.status < 300 || answer.status >= 400) {
        response = answer;
        break;
      }
      const location = answer.headers.get("location");
      if (location === null)
        return fail("invalid_response", "the origin redirected nowhere");
      try {
        target = new URL(location, target).toString();
      } catch {
        return fail("invalid_response", "the origin redirected nowhere");
      }
    }
    if (response === undefined)
      return fail("invalid_response", "the origin redirected too many times");

    if (response.status === 304 && cached) {
      return succeed({
        status: 200,
        data: cached.data,
        headers: cached.headers,
      });
    }

    const limited = rateLimited(response);
    if (limited) return limited;

    if (response.status === 401)
      return fail("unauthorized", "the origin rejected this token");
    if (response.status === 403)
      return fail("forbidden", "the token may not do that on the origin");
    if (response.status === 404)
      return fail("not_found", "the origin has no such thing");
    if (response.status >= 500)
      return fail("unreachable", `the origin answered ${response.status}`);

    let text: string | undefined;
    try {
      text = await readCapped(response, this.maxBytes, signal);
    } catch (error) {
      return fail("unreachable", redact(String(error), token.value));
    }
    if (text === undefined)
      return fail("invalid_response", "the origin's answer was too large");

    if (!response.ok) {
      // The origin's words, minus anything of ours it might be quoting back:
      // this message lands in `last_error`, an event, a toast, and a log.
      return fail(
        "invalid_response",
        `${response.status}: ${redact(firstLine(text), token.value) || "no detail"}`,
      );
    }

    let data: unknown = null;
    if (text.trim() !== "") {
      try {
        data = JSON.parse(text);
      } catch {
        return fail("invalid_response", "the origin's answer was not JSON");
      }
    }

    const etag = response.headers.get("etag");
    if (etag !== null && method === "GET" && request.conditional) {
      this.remember(url, { etag, data, headers: response.headers });
    }
    return succeed({
      status: response.status,
      data,
      headers: response.headers,
    });
  }

  private remember(url: string, entry: CacheEntry): void {
    if (this.etags.size >= ETAG_ENTRIES) {
      const oldest = this.etags.keys().next();
      if (!oldest.done) this.etags.delete(oldest.value);
    }
    this.etags.set(url, entry);
  }
}

/**
 * Exhaustion, in the two dialects that exist. GitHub speaks `X-RateLimit-*`
 * and signals a spent budget with a 403 whose remaining is zero, not a 429.
 * Codeberg's proxy speaks RFC 9331 — `ratelimit: "baseline";r=1998;t=600` —
 * which is why "Forgejo has no rate limit" is folklore rather than fact.
 * Either way what matters is one thing: when to come back.
 */
function rateLimited(response: Response): ProviderResult<never> | undefined {
  const remaining = response.headers.get("x-ratelimit-remaining");
  const rfc = parseRfcRateLimit(response.headers.get("ratelimit"));
  const is429 = response.status === 429;
  const isExhausted403 = response.status === 403 && remaining === "0";
  const isRfcExhausted =
    response.status >= 400 && rfc !== undefined && rfc.remaining === 0;
  if (!is429 && !isExhausted403 && !isRfcExhausted) return undefined;

  const retryAfter = Number(response.headers.get("retry-after") ?? "");
  const reset = Number(response.headers.get("x-ratelimit-reset") ?? "");
  let retryAt: string;
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    retryAt = new Date(Date.now() + retryAfter * 1000).toISOString();
  } else if (Number.isFinite(reset) && reset > 0) {
    // Seconds since the epoch on GitHub; milliseconds nowhere, but a value
    // that is obviously milliseconds is still handled rather than mangled.
    const ms = reset > 1e11 ? reset : reset * 1000;
    retryAt = new Date(ms).toISOString();
  } else if (rfc !== undefined && rfc.seconds > 0) {
    retryAt = new Date(Date.now() + rfc.seconds * 1000).toISOString();
  } else {
    retryAt = new Date(Date.now() + 60_000).toISOString();
  }
  return fail("rate_limited", "the origin is rate-limiting us", retryAt);
}

/** RFC 9331 style: `"baseline";r=<remaining>;t=<seconds until reset>`. */
function parseRfcRateLimit(
  header: string | null,
): { remaining: number; seconds: number } | undefined {
  if (header === null) return undefined;
  const r = /(?:^|;)\s*r=(\d+)/.exec(header);
  const t = /(?:^|;)\s*t=(\d+)/.exec(header);
  if (!r) return undefined;
  return { remaining: Number(r[1]), seconds: t ? Number(t[1]) : 0 };
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/**
 * Read a body up to the cap and not a byte further: the stream is cancelled
 * the moment it goes over, so a hostile origin cannot make us buffer its
 * whole answer before we decline it. `Content-Length` is only a hint — a
 * chunked body declares nothing. Throws when `signal` fires mid-body.
 */
export async function readCapped(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    return undefined;
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = new Promise<never>((_, reject) => {
    if (signal === undefined) return;
    if (signal.aborted) reject(signal.reason ?? new Error("timed out"));
    signal.addEventListener(
      "abort",
      () => reject(signal.reason ?? new Error("timed out")),
      { once: true },
    );
  });
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), abort]);
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

const firstLine = (text: string): string => text.split("\n")[0]!.slice(0, 200);

// ---- Link header (GitHub's cursor, and Forgejo's when it bothers) ----

/** The `rel="next"` URL from a Link header, or undefined at the last page. */
export function linkNext(headers: Headers): string | undefined {
  const link = headers.get("link");
  if (!link) return undefined;
  for (const part of link.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="?next"?/.exec(part);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

// ---- readers: remote JSON, checked into shapes we will store ----

export function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/** Reach through nested objects: `dig(item, "user", "login")`. */
export function dig(value: unknown, ...keys: string[]): unknown {
  let current = value;
  for (const key of keys) current = field(current, key);
  return current;
}

export function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function asBool(value: unknown): boolean {
  return value === true;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** An id that may arrive as a number or a string; always stored as a string. */
export function asId(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" ? value : "";
}

/** A timestamp, normalised to ISO 8601, or null when absent or nonsense. */
export function asTime(value: unknown): string | null {
  const text = asString(value);
  if (text === "") return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export function asState(value: unknown): "open" | "closed" {
  return asString(value).toLowerCase() === "closed" ? "closed" : "open";
}

/** Six hex digits, no `#` — the only colour shape the label table accepts. */
export function asColor(value: unknown): string {
  const text = asString(value).replace(/^#/, "").toLowerCase();
  if (/^[0-9a-f]{6}$/.test(text)) return text;
  if (/^[0-9a-f]{3}$/.test(text))
    return text
      .split("")
      .map((c) => c + c)
      .join("");
  return "6b7280";
}

/** Label names off an issue payload, which both forges shape identically. */
export function labelNames(value: unknown): string[] {
  const names: string[] = [];
  for (const entry of asArray(value)) {
    const name = asString(field(entry, "name")).trim();
    if (name !== "" && !names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * Where a review comment is anchored, from the diff hunk it quotes. Both
 * forges truncate `diff_hunk` at the commented line, so the last row of the
 * hunk IS the anchor — which is the only signal Forgejo gives us at all.
 * GitHub also states `line`/`side` outright; the caller prefers those.
 */
export function anchorFromHunk(hunk: string): {
  line: number;
  side: "old" | "new";
} {
  const lines = hunk.split("\n");
  let oldLine = 0;
  let newLine = 0;
  let last = { line: 0, side: "new" as "old" | "new" };
  for (const row of lines) {
    const header = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(row);
    if (header) {
      oldLine = Number(header[1]) - 1;
      newLine = Number(header[2]) - 1;
      continue;
    }
    if (row.startsWith("-")) {
      oldLine++;
      last = { line: oldLine, side: "old" };
    } else if (row.startsWith("+")) {
      newLine++;
      last = { line: newLine, side: "new" };
    } else if (row.startsWith(" ") || row === "") {
      oldLine++;
      newLine++;
      last = { line: newLine, side: "new" };
    }
  }
  return last;
}

/** `owner/name`, split and checked — anything else is not a repo we can name. */
export function splitFullName(
  fullName: string,
): { owner: string; name: string } | undefined {
  const parts = fullName.split("/");
  if (parts.length !== 2) return undefined;
  const [owner, name] = parts;
  if (!owner || !name) return undefined;
  // These become path segments on the origin; refuse traversal outright.
  if (owner.includes("..") || name.includes("..")) return undefined;
  return { owner, name };
}

/** Percent-encode a path segment for a remote API URL. */
export const seg = (value: string): string => encodeURIComponent(value);
