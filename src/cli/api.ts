/**
 * The workbench, over HTTP. One class, one error shape, no retries — a CLI
 * that silently retries is a CLI whose failures you cannot reason about.
 *
 * The pins endpoint (`docs/ORIGINS.md`) is the one this client wants: it
 * says exactly which repos the user asked to have on this machine, with the
 * clone URLs already resolved. It is newer than this client, so `pins()`
 * degrades to `GET /api/v1/repos` filtered to the user's own repos and says
 * so once, rather than failing.
 */

import { err, ok, type Result } from "../kernel/result.ts";

export interface ApiError {
  /** The forge's stable machine code, or a transport code we invented. */
  readonly code: string;
  readonly message: string;
  readonly status: number;
}

export type ApiResult<T> = Result<T, ApiError>;

/** A repo the user wants kept locally. */
export interface Pin {
  readonly owner: string;
  readonly name: string;
  readonly cloneUrl: string;
  readonly sshUrl: string | null;
  readonly defaultBranch: string;
  /** Set when the repo is a mirror of somewhere else. */
  readonly origin: { htmlUrl: string; fullName: string } | null;
}

export interface Whoami {
  readonly username: string;
  readonly displayName: string;
}

/** One thing waiting on the user, as `forge asks` prints it. */
export interface Ask {
  /** The API's kind (`look`, `parked`, `proposal`, …), or `forge` for its own needs. */
  readonly kind: string;
  /** `owner/name`, or "" for a need of the forge itself. */
  readonly repo: string;
  readonly title: string;
  /** Absolute: where a person decides it on the workbench. */
  readonly url: string;
}

export interface Asks {
  /** The answer exactly as the forge gave it, for `--json`. */
  readonly raw: unknown;
  /** The rows in the order the forge ranks them, then the forge's own needs. */
  readonly asks: Ask[];
}

export class ForgeApi {
  /** True once `pins()` has had to fall back, so the CLI can say it once. */
  pinsUnavailable = false;

  constructor(
    readonly url: string,
    private readonly token: string,
  ) {}

  private async call<T>(
    path: string,
    init: RequestInit = {},
  ): Promise<ApiResult<T>> {
    let response: Response;
    try {
      response = await globalThis.fetch(`${this.url}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(init.body === undefined
            ? {}
            : { "content-type": "application/json" }),
          ...init.headers,
        },
      });
    } catch (cause) {
      return err({
        code: "unreachable",
        message: `cannot reach ${this.url}: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        status: 0,
      });
    }
    if (response.status === 204) return ok(undefined as T);
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text === "" ? {} : JSON.parse(text);
    } catch {
      return err({
        code: "bad_response",
        message: `${path} did not return JSON`,
        status: response.status,
      });
    }
    if (!response.ok) {
      const body = parsed as { error?: unknown; message?: unknown };
      return err({
        code: typeof body.error === "string" ? body.error : "http_error",
        message:
          typeof body.message === "string"
            ? body.message
            : `${response.status} from ${path}`,
        status: response.status,
      });
    }
    return ok(parsed as T);
  }

  async whoami(): Promise<ApiResult<Whoami>> {
    const out = await this.call<{ username?: string; displayName?: string }>(
      "/api/v1/user",
    );
    if (!out.ok) return out;
    const username = out.value.username ?? "";
    return ok({ username, displayName: out.value.displayName ?? username });
  }

  /**
   * What to keep on this machine. Falls back to "every repo you own" when
   * the forge has no pins endpoint yet — the same set a fresh user would
   * pin, so the client is useful against an older workbench.
   */
  async pins(): Promise<ApiResult<Pin[]>> {
    const pins: Pin[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const query = cursor === undefined ? "" : `?cursor=${cursor}`;
      const out = await this.call<unknown>(`/api/v1/user/pins${query}`);
      if (!out.ok) {
        if (out.error.status !== 404 && out.error.status !== 501) return out;
        this.pinsUnavailable = true;
        return this.ownedRepos();
      }
      // An older forge answers the whole list as a bare array.
      if (Array.isArray(out.value)) return ok(this.toPins(out.value));
      const body = (out.value ?? {}) as { items?: unknown; next_cursor?: unknown };
      pins.push(...this.toPins(body.items));
      if (typeof body.next_cursor !== "string" || body.next_cursor === "")
        return ok(pins);
      cursor = encodeURIComponent(body.next_cursor);
    }
    return ok(pins);
  }

  /** The fallback for a forge with no pins endpoint: every repo you own. */
  private async ownedRepos(): Promise<ApiResult<Pin[]>> {
    const me = await this.whoami();
    if (!me.ok) return me;
    const repos = await this.repos();
    if (!repos.ok) return repos;
    return ok(repos.value.filter((p) => p.owner === me.value.username));
  }

  /** Every repo visible to the token, following the cursor to the end. */
  async repos(): Promise<ApiResult<Pin[]>> {
    const out: Pin[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const query = cursor === undefined ? "" : `?cursor=${cursor}`;
      const body = await this.call<{ items?: unknown; next_cursor?: unknown }>(
        `/api/v1/repos${query}`,
      );
      if (!body.ok) return body;
      out.push(...this.toPins(body.value.items));
      const next = body.value.next_cursor;
      if (typeof next !== "string" || next === "") break;
      cursor = encodeURIComponent(next);
    }
    return ok(out);
  }

  async pin(owner: string, name: string): Promise<ApiResult<void>> {
    return this.call<void>(
      `/api/v1/user/pins/${encode(owner)}/${encode(name)}`,
      { method: "PUT" },
    );
  }

  async unpin(owner: string, name: string): Promise<ApiResult<void>> {
    return this.call<void>(
      `/api/v1/user/pins/${encode(owner)}/${encode(name)}`,
      { method: "DELETE" },
    );
  }

  /**
   * What waits on the user, most consequential first (`GET /api/v1/asks`).
   * A row of a kind this client has never heard of is kept, not dropped: it
   * prints with its kind and whatever title it carries.
   */
  async asks(): Promise<ApiResult<Asks>> {
    const out = await this.call<unknown>("/api/v1/asks");
    if (!out.ok) return out;
    const body = (out.value ?? {}) as { rows?: unknown; forge?: unknown };
    const asks: Ask[] = [];
    for (const item of Array.isArray(body.rows) ? body.rows : []) {
      if (typeof item !== "object" || item === null) continue;
      const r = item as Record<string, unknown>;
      const kind = str(r["kind"]) ?? "ask";
      const repo = str(r["repo"]) ?? "";
      const proposal = r["proposal"] as Record<string, unknown> | undefined;
      asks.push({
        kind,
        repo,
        title: titleOf(
          str(r["line"]) ?? str(proposal?.["title"]) ?? kind,
          repo,
        ),
        url: this.absolute(str(r["link"]) ?? "/"),
      });
    }
    for (const need of Array.isArray(body.forge) ? body.forge : []) {
      const title = str(need);
      if (title !== undefined)
        asks.push({ kind: "forge", repo: "", title, url: this.absolute("/") });
    }
    return ok({ raw: out.value, asks });
  }

  /** A workbench path as a full address; anything not a path is the home. */
  private absolute(link: string): string {
    return link.startsWith("/") && !link.startsWith("//")
      ? `${this.url}${link}`
      : `${this.url}/`;
  }

  /** The page a person would open in a browser. */
  webUrl(owner: string, name: string): string {
    return `${this.url}/${encode(owner)}/${encode(name)}`;
  }

  /**
   * Repo JSON → `Pin`, tolerating both shapes: the pins endpoint hands back
   * `cloneUrl`/`sshUrl`, while `/api/v1/repos` today hands back neither, so
   * they are derived from the workbench URL the same way the web does.
   */
  private toPins(value: unknown): Pin[] {
    if (!Array.isArray(value)) return [];
    const out: Pin[] = [];
    for (const item of value) {
      if (typeof item !== "object" || item === null) continue;
      const r = item as Record<string, unknown>;
      const owner = str(r["ownerName"]) ?? str(r["owner"]);
      const name = str(r["name"]);
      if (owner === undefined || name === undefined) continue;
      out.push({
        owner,
        name,
        cloneUrl:
          str(r["cloneUrl"]) ??
          `${this.url}/${encode(owner)}/${encode(name)}.git`,
        sshUrl: str(r["sshUrl"]) ?? null,
        defaultBranch: str(r["defaultBranch"]) ?? "main",
        origin: toOrigin(r["origin"]),
      });
    }
    return out;
  }
}

function toOrigin(value: unknown): Pin["origin"] {
  if (typeof value !== "object" || value === null) return null;
  const r = value as Record<string, unknown>;
  const htmlUrl = str(r["htmlUrl"]);
  const fullName = str(r["fullName"]);
  if (htmlUrl === undefined || fullName === undefined) return null;
  return { htmlUrl, fullName };
}

/**
 * An ask's line without the repo name it leads with (`app: Pull #3 …`, or
 * `app paused …`): the CLI prints `owner/name` in its own column.
 */
function titleOf(line: string, repo: string): string {
  const name = repo.slice(repo.indexOf("/") + 1);
  if (name === "") return line;
  if (line.startsWith(`${name}: `)) return line.slice(name.length + 2);
  if (line.startsWith(`${name} `)) return line.slice(name.length + 1);
  return line;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function encode(part: string): string {
  return encodeURIComponent(part);
}

/**
 * How a token reaches git without ever entering a URL, a remote, or argv.
 * `GIT_CONFIG_COUNT` is transient config for one process — the same channel
 * the server uses for origin credentials, so there is one answer in the
 * codebase to "where do we put a secret git needs".
 */
export function tokenGitEnv(token: string): Record<string, string> {
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`,
  };
}
