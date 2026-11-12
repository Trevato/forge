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
  RemoteBlob,
  RemoteBranch,
  RemoteCommit,
  RemoteTreeEntry,
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

/**
 * The scopes in a Forgejo or Gitea refusal — `token does not have at least
 * one of required scope(s): [read:user]` — or none. Only scope-shaped words
 * are kept, so nothing else the body says can ride along into a message.
 */
export function missingScopes(body: string): string[] {
  const listed = /required scope\(s\): \[([^\]]{0,200})\]/.exec(body);
  if (!listed) return [];
  return (listed[1] ?? "")
    .split(/[\s,]+/)
    .filter((s) => /^(read|write):[a-z]{1,20}$/.test(s));
}

const CATEGORY: Record<string, string> = {
  activitypub: "ActivityPub",
  admin: "Admin",
  issue: "Issue",
  misc: "Misc",
  notification: "Notification",
  organization: "Organization",
  package: "Package",
  repository: "Repository",
  user: "User",
};

/**
 * Scopes as the token page names them: `read:user` is "User: Read" and
 * `write:issue` "Issue: Read and write" (write includes read there).
 */
export function scopeWords(scopes: readonly string[]): string {
  const words = scopes.map((scope) => {
    const [level, category = ""] = scope.split(":");
    const name =
      CATEGORY[category] ?? category.charAt(0).toUpperCase() + category.slice(1);
    return `${name}: ${level === "write" ? "Read and write" : "Read"}`;
  });
  return words.length <= 1
    ? (words[0] ?? "")
    : `${words.slice(0, -1).join(", ")} or ${words.at(-1)}`;
}

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

  /**
   * A JSON call: the network exchange, plus the conditional-request cache
   * that only makes sense for a parsed body.
   */
  async call(request: ApiRequest): Promise<ProviderResult<ApiResponse>> {
    const url = this.url(request);
    const method = request.method ?? "GET";
    const cached =
      request.conditional && method === "GET" ? this.etags.get(url) : undefined;

    const raw = await this.send(request, {
      ...(cached === undefined ? {} : { ifNoneMatch: cached.etag }),
    });
    if (!raw.ok) return raw;
    if (raw.value.status === 304) {
      // Only a conditional request can be answered 304, and one is only sent
      // when we hold the entry it would revalidate.
      if (cached === undefined)
        return fail("invalid_response", "the origin answered 304 unasked");
      return succeed({
        status: 200,
        data: cached.data,
        headers: cached.headers,
      });
    }

    let data: unknown = null;
    if (raw.value.text.trim() !== "") {
      try {
        data = JSON.parse(raw.value.text);
      } catch {
        return fail("invalid_response", "the origin's answer was not JSON");
      }
    }

    const etag = raw.value.headers.get("etag");
    if (etag !== null && method === "GET" && request.conditional) {
      this.remember(url, { etag, data, headers: raw.value.headers });
    }
    return succeed({
      status: raw.value.status,
      data,
      headers: raw.value.headers,
    });
  }

  /**
   * The same exchange, delivered as text. Both forges serve a diff as
   * `text/plain` behind a media type rather than as JSON, and a diff is the
   * one answer we want whole and unparsed — so it gets its own door with its
   * own, smaller cap rather than a flag on the JSON path.
   */
  async text(
    request: ApiRequest & { accept: string; maxBytes?: number },
  ): Promise<ProviderResult<{ text: string; headers: Headers }>> {
    const raw = await this.send(request, {
      accept: request.accept,
      ...(request.maxBytes === undefined ? {} : { maxBytes: request.maxBytes }),
    });
    if (!raw.ok) return raw;
    return succeed({ text: raw.value.text, headers: raw.value.headers });
  }

  private async send(
    request: ApiRequest,
    options: { accept?: string; ifNoneMatch?: string; maxBytes?: number },
  ): Promise<
    ProviderResult<{ status: number; text: string; headers: Headers }>
  > {
    const url = this.url(request);
    const method = request.method ?? "GET";
    const maxBytes = options.maxBytes ?? this.maxBytes;

    // Anything that is not a read asks the credential first: an origin whose
    // account could not be verified (the operator guard) reads but does not
    // write, and this is the one door every write through an adapter takes.
    if (method !== "GET" && method !== "HEAD" && this.credential.writable) {
      const may = this.credential.writable();
      if (!may.ok) return may;
    }

    // Resolved per call: an OAuth token may have been refreshed since the
    // last one, and a token that cannot be resolved must not become a
    // credential-less request that reads as "not found".
    const token = await this.credential.token();
    if (!token.ok) return token;

    // An explicit accept wins over the provider's own — GitHub's auth
    // headers pin `application/vnd.github+json`, and a diff request that let
    // that stand would be answered with JSON about the commit instead of the
    // diff, silently and plausibly.
    const headers: Record<string, string> = {
      accept: "application/json",
      "user-agent": "forge",
      ...this.authHeaders(token.value),
      ...(options.accept === undefined ? {} : { accept: options.accept }),
    };
    if (options.ifNoneMatch !== undefined)
      headers["if-none-match"] = options.ifNoneMatch;
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

    if (response.status === 304)
      return succeed({ status: 304, text: "", headers: response.headers });

    const limited = rateLimited(response);
    if (limited) return limited;

    if (response.status === 401)
      return fail("unauthorized", "the origin rejected this token");
    if (response.status === 403) {
      // Forgejo and Gitea say which scope a token lacks; that sentence is
      // worth one small read, because "may not" alone sends a person to
      // guess between a wrong token, an expired one and a narrow one.
      let said = "";
      try {
        said = (await readCapped(response, 4096, signal)) ?? "";
      } catch {
        said = "";
      }
      const missing = missingScopes(said);
      return missing.length === 0
        ? fail("forbidden", "the token may not do that on the origin")
        : {
            ok: false,
            error: {
              error: "forbidden",
              message: `the token is missing ${scopeWords(missing)}`,
              missingScopes: missing,
            },
          };
    }
    if (response.status === 404)
      return fail("not_found", "the origin has no such thing");
    if (response.status >= 500)
      return fail("unreachable", `the origin answered ${response.status}`);

    let text: string | undefined;
    try {
      text = await readCapped(response, maxBytes, signal);
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

    return succeed({
      status: response.status,
      text,
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

// ---- browsing a remote repository ----

/**
 * The largest blob we will pull across the wire to render. A repository we
 * have not mirrored is a stranger's; browsing one must cost a bounded amount
 * of memory whatever it holds.
 */
export const MAX_BLOB_BYTES = 1024 * 1024;
/** A diff is text we parse whole, so it gets a cap of its own. */
export const MAX_DIFF_BYTES = 2 * 1024 * 1024;
/** Commits per page; both forges cap their own page size below this. */
export const COMMIT_PAGE = 50;

/**
 * A repo-relative path we are willing to put in a remote URL. The same
 * hygiene git arguments get (`git/guard.ts`), for the same reason: a path
 * from a URL must not climb out of the repository or smuggle a control byte
 * into a request line.
 */
export function isSafeRemotePath(path: string): boolean {
  if (path === "") return true;
  if (path.length > 4096) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(path)) return false;
  if (path.startsWith("/") || path.endsWith("/")) return false;
  return path
    .split("/")
    .every((part) => part !== "" && part !== "." && part !== "..");
}

/** A ref a remote URL may carry: a branch, a tag, or an object id. */
export function isSafeRemoteRef(ref: string): boolean {
  if (ref === "" || ref.length > 255) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f\s~^:?*[\\]/.test(ref)) return false;
  return !ref.startsWith("-") && !ref.includes("..");
}

/** Percent-encode a path for a remote URL, one segment at a time. */
export const pathSegments = (path: string): string =>
  path.split("/").map(seg).join("/");

/**
 * Decode a `contents` payload's body. Both forges answer base64 under the
 * cap and an empty body with `encoding: "none"` over it — the second is the
 * forge telling us to go and fetch the object another way, which for a
 * browse is exactly the moment to stop.
 */
export function decodeContent(
  raw: unknown,
  maxBytes: number,
): { content: Uint8Array; truncated: boolean } {
  const size = asNumber(field(raw, "size"));
  const encoding = asString(field(raw, "encoding"));
  const text = asString(field(raw, "content"));
  if (size > maxBytes || encoding === "none" || (text === "" && size > 0))
    return { content: new Uint8Array(0), truncated: true };
  if (encoding === "base64" || encoding === "") {
    const bytes = new Uint8Array(
      Buffer.from(text.replace(/\s+/g, ""), "base64"),
    );
    if (bytes.byteLength > maxBytes)
      return { content: new Uint8Array(0), truncated: true };
    return { content: bytes, truncated: false };
  }
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength > maxBytes)
    return { content: new Uint8Array(0), truncated: true };
  return { content: bytes, truncated: false };
}

/** `type` as both forges spell it on a contents entry. */
export function entryKind(value: unknown): RemoteTreeEntry["kind"] {
  switch (asString(value)) {
    case "dir":
      return "tree";
    case "symlink":
      return "symlink";
    case "submodule":
      return "submodule";
    default:
      return "blob";
  }
}

/** One row of a `contents` listing, in either dialect. */
export function toTreeEntry(raw: unknown, parent: string): RemoteTreeEntry {
  const name = asString(field(raw, "name"));
  const kind = entryKind(field(raw, "type"));
  const size = asNumber(field(raw, "size"));
  return {
    name,
    // The path is ours, not the origin's. Both forges state one, and both
    // agree with this join — but a `path` an origin invented is a string we
    // would put straight into the next request and into a rendered link, so
    // it is built from the directory we asked for and the name in the row.
    path: safeJoin(parent, name),
    kind,
    ...(kind === "tree" ? {} : { size }),
    oid: asString(field(raw, "sha")),
  };
}

/** A `contents` file payload, as bytes we are willing to hold. */
export function toBlob(raw: unknown, maxBytes = MAX_BLOB_BYTES): RemoteBlob {
  const { content, truncated } = decodeContent(raw, maxBytes);
  const stated = asNumber(field(raw, "size"));
  return {
    content,
    size: stated > 0 ? stated : content.byteLength,
    oid: asString(field(raw, "sha")),
    truncated,
  };
}

/** Directories first, then files, both alphabetical — `listTree`'s order,
 * so a remote listing and a local one read the same way. */
export function sortEntries(
  entries: readonly RemoteTreeEntry[],
): RemoteTreeEntry[] {
  return [...entries].sort((a, b) =>
    a.kind === b.kind
      ? a.name.localeCompare(b.name)
      : a.kind === "tree"
        ? -1
        : b.kind === "tree"
          ? 1
          : a.name.localeCompare(b.name),
  );
}

const safeJoin = (parent: string, name: string): string =>
  parent === "" ? name : `${parent}/${name}`;

/** A commit row: GitHub's and Forgejo's shapes agree field for field here. */
export function toCommit(raw: unknown): RemoteCommit {
  const login = asString(dig(raw, "author", "login"));
  return {
    oid: asId(field(raw, "sha")) || asString(field(raw, "sha")),
    message: asString(dig(raw, "commit", "message")),
    author: {
      name:
        asString(dig(raw, "commit", "author", "name")) || login || "unknown",
      email: asString(dig(raw, "commit", "author", "email")),
      ...(login === "" ? {} : { login }),
      date:
        asTime(dig(raw, "commit", "author", "date")) ??
        new Date(0).toISOString(),
    },
    parents: asArray(field(raw, "parents"))
      .map((p) => asString(field(p, "sha")))
      .filter((sha) => sha !== ""),
  };
}

/** A branch row, in either dialect (`commit.sha` / `commit.id`). */
export function toBranch(raw: unknown): RemoteBranch {
  const guarded = field(raw, "protected");
  return {
    name: asString(field(raw, "name")),
    oid:
      asString(dig(raw, "commit", "sha")) || asString(dig(raw, "commit", "id")),
    ...(typeof guarded === "boolean" ? { protected: guarded } : {}),
  };
}

/** README names, in the order both forges themselves prefer them. */
export const README_NAMES = [
  "README.md",
  "README.markdown",
  "README.rst",
  "README.txt",
  "README",
] as const;

/** Pick the readme out of a root listing, case-insensitively. */
export function readmeEntry(
  entries: readonly RemoteTreeEntry[],
): RemoteTreeEntry | undefined {
  const files = entries.filter(
    (e) => e.kind === "blob" || e.kind === "symlink",
  );
  for (const name of README_NAMES) {
    const hit = files.find((e) => e.name.toLowerCase() === name.toLowerCase());
    if (hit) return hit;
  }
  return files.find((e) => e.name.toLowerCase().startsWith("readme."));
}

/**
 * Post a review with its line comments inside it, in one call. An origin
 * that refuses the payload (a 4xx that is not about who we are, nor about
 * the pull's existence) is asked again with the verdict alone, so a shape
 * it dislikes never costs the verdict: `carried` says which one it took.
 */
export async function postReview(
  api: ApiClient,
  path: string,
  review: { event: string; body: string },
  lines: readonly Record<string, unknown>[],
): Promise<ProviderResult<{ data: unknown; carried: number }>> {
  if (lines.length > 0) {
    const whole = await api.call({
      path,
      method: "POST",
      body: { ...review, comments: lines },
    });
    if (whole.ok) return succeed({ data: whole.value.data, carried: lines.length });
    if (whole.error.error !== "invalid_response") return whole;
  }
  const bare = await api.call({ path, method: "POST", body: review });
  if (!bare.ok) return bare;
  return succeed({ data: bare.value.data, carried: 0 });
}
