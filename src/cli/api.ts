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
    const out = await this.call<unknown>("/api/v1/user/pins");
    if (out.ok) return ok(this.toPins(out.value));
    if (out.error.status !== 404 && out.error.status !== 501) return out;
    this.pinsUnavailable = true;
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
