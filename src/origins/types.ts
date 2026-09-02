/**
 * The origin contract. An origin is a connected account on another forge
 * (GitHub, Forgejo, Gitea). Every forge exposes the same units — repos,
 * issues, pulls, comments, labels — behind a different API, so each provider
 * is a small adapter that speaks its API and returns these shapes. Nothing
 * outside `src/origins/providers/` knows which forge it is talking to.
 *
 * Truth: for a mirrored repo the ORIGIN is truth, exactly as git is truth
 * for a native repo. The local rows are an index; writes go to the origin
 * first and are reflected locally after they succeed.
 */

export type OriginKind = "github" | "forgejo" | "gitea";

/** A connected account. The token is stored encrypted and never returned. */
export interface Origin {
  readonly id: string;
  readonly userId: string;
  readonly kind: OriginKind;
  /** API base, e.g. `https://api.github.com` or `https://codeberg.org/api/v1`. */
  readonly apiUrl: string;
  /** Human web base, e.g. `https://github.com` or `https://codeberg.org`. */
  readonly webUrl: string;
  /** The account's login on that forge. */
  readonly login: string;
  readonly createdAt: string;
  readonly lastSyncAt: string | null;
  /** Last sync outcome; empty when healthy. */
  readonly lastError: string;
}

/** A repository as the origin describes it — the import picker's rows. */
export interface RemoteRepo {
  /** Stable provider id (GitHub `id`, Forgejo `id`) as a string. */
  readonly remoteId: string;
  /** `owner/name` on the origin. */
  readonly fullName: string;
  readonly owner: string;
  readonly name: string;
  readonly description: string;
  readonly private: boolean;
  readonly fork: boolean;
  readonly defaultBranch: string;
  readonly cloneUrl: string;
  readonly sshUrl: string;
  readonly htmlUrl: string;
  /** Last push on the origin, ISO 8601, or null when empty. */
  readonly pushedAt: string | null;
  readonly permissions: { readonly push: boolean; readonly admin: boolean };
}

export interface RemoteLabel {
  readonly remoteId: string;
  readonly name: string;
  /** Six hex digits, no `#`. */
  readonly color: string;
}

export interface RemoteComment {
  readonly remoteId: string;
  readonly author: string;
  readonly body: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly htmlUrl: string;
}

/** An issue or a pull, as one shape; `pull` is present for pulls only. */
export interface RemoteIssue {
  readonly remoteId: string;
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly author: string;
  readonly state: "open" | "closed";
  readonly labels: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt: string | null;
  readonly htmlUrl: string;
  readonly comments: number;
  readonly pull?: {
    readonly baseBranch: string;
    readonly headBranch: string;
    /** `owner/name` of the head repo; equals the base repo unless a fork. */
    readonly headRepo: string;
    readonly baseOid: string;
    readonly headOid: string;
    readonly mergedAt: string | null;
    readonly draft: boolean;
  };
}

export interface RemoteReview {
  readonly remoteId: string;
  readonly author: string;
  readonly body: string;
  readonly path: string;
  readonly line: number;
  readonly side: "old" | "new";
  readonly createdAt: string;
  readonly htmlUrl: string;
}

export interface RemoteIdentity {
  readonly login: string;
  readonly displayName: string;
  readonly htmlUrl: string;
}

export type ProviderError =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "rate_limited"
  | "unreachable"
  | "invalid_response";

export interface ProviderFailure {
  readonly error: ProviderError;
  readonly message: string;
  /** For `rate_limited`: when to try again. */
  readonly retryAt?: string;
}

/** A page of a list, with the cursor for the next page (null at the end). */
export interface Page<T> {
  readonly items: readonly T[];
  readonly next: string | null;
}

export interface ListIssuesQuery {
  readonly kind: "issue" | "pull";
  readonly state: "open" | "closed" | "all";
  /** Only items updated at or after this instant (incremental sync). */
  readonly since?: string;
  readonly cursor?: string;
}

/**
 * What every provider implements. Results are `Result<T, ProviderFailure>`
 * (see kernel/result.ts) — network and remote refusals are expected outcomes.
 * Implementations must be pure adapters: no database, no git, no state
 * beyond the credential they were constructed with.
 */
export interface Provider {
  readonly kind: OriginKind;
  readonly apiUrl: string;
  readonly webUrl: string;

  whoami(): Promise<ProviderResult<RemoteIdentity>>;
  listRepos(cursor?: string): Promise<ProviderResult<Page<RemoteRepo>>>;
  getRepo(fullName: string): Promise<ProviderResult<RemoteRepo>>;

  listLabels(fullName: string): Promise<ProviderResult<readonly RemoteLabel[]>>;
  listIssues(
    fullName: string,
    query: ListIssuesQuery,
  ): Promise<ProviderResult<Page<RemoteIssue>>>;
  getIssue(
    fullName: string,
    number: number,
  ): Promise<ProviderResult<RemoteIssue>>;
  listComments(
    fullName: string,
    number: number,
    since?: string,
  ): Promise<ProviderResult<readonly RemoteComment[]>>;
  listReviews(
    fullName: string,
    number: number,
  ): Promise<ProviderResult<readonly RemoteReview[]>>;

  createIssue(
    fullName: string,
    input: { title: string; body: string; labels?: readonly string[] },
  ): Promise<ProviderResult<RemoteIssue>>;
  createComment(
    fullName: string,
    number: number,
    body: string,
  ): Promise<ProviderResult<RemoteComment>>;
  setState(
    fullName: string,
    number: number,
    state: "open" | "closed",
  ): Promise<ProviderResult<RemoteIssue>>;
  setLabels(
    fullName: string,
    number: number,
    labels: readonly string[],
  ): Promise<ProviderResult<readonly RemoteLabel[]>>;
  createPull(
    fullName: string,
    input: {
      title: string;
      body: string;
      base: string;
      /** `branch` or `owner:branch` for a fork. */
      head: string;
    },
  ): Promise<ProviderResult<RemoteIssue>>;
  forkRepo(fullName: string): Promise<ProviderResult<RemoteRepo>>;

  /**
   * What git needs to talk to this origin over HTTPS with the credential,
   * passed as `GIT_CONFIG_COUNT/KEY/VALUE` so the token never reaches argv.
   */
  gitAuthEnv(): Record<string, string>;
}

export type ProviderResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ProviderFailure };

/** What a provider is constructed from. */
export interface ProviderCredential {
  readonly kind: OriginKind;
  readonly apiUrl: string;
  readonly webUrl: string;
  readonly token: string;
}

/**
 * Discovery: given a host the user typed, which forge is it? NodeInfo is the
 * standard; the Forgejo/Gitea version endpoint is the fallback heuristic;
 * github.com is known.
 */
export interface Discovered {
  readonly kind: OriginKind;
  readonly apiUrl: string;
  readonly webUrl: string;
  /** How we knew: the evidence to show the user. */
  readonly via: "known" | "nodeinfo" | "version-endpoint";
  readonly software: string;
}
