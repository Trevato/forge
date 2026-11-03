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

import type { Diff } from "../git/diff.ts";

export type OriginKind = "github" | "forgejo" | "gitea";

/** How an origin's credential was obtained. */
export type AuthKind = "pat" | "oauth";

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
  /** How the credential was obtained. */
  readonly authKind: AuthKind;
  /** OAuth only: when the access token stops working, if the origin said. */
  readonly expiresAt: string | null;
  /**
   * The credential is spent and cannot be refreshed. Sync skips this origin
   * entirely until a human reconnects — retrying an `invalid_grant` forever
   * is how one expired token becomes a permanent error loop.
   */
  readonly needsReauth: boolean;
  /**
   * What the origin runs when its kind does not say: `forge` for another
   * forge (stored as a Gitea origin, which is the dialect it speaks), else "".
   */
  readonly software: string;
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
  /**
   * `owner/name` of the repo this one forks, or null. Both forges report it
   * on `getRepo` and neither reports it on a list, which is why the cache
   * keeps the value it already has rather than letting a listing clear it.
   */
  readonly parent: string | null;
  /**
   * `owner/name` of the root of the fork network, when the origin says and
   * it is not `parent` — GitHub's `source`. Forgejo reports no such thing.
   */
  readonly root?: string;
  readonly defaultBranch: string;
  readonly cloneUrl: string;
  readonly sshUrl: string;
  readonly htmlUrl: string;
  /** Last push on the origin, ISO 8601, or null when empty. */
  readonly pushedAt: string | null;
  readonly permissions: { readonly push: boolean; readonly admin: boolean };
  /**
   * Open conversations, as the origin counts them. GitHub's
   * `open_issues_count` is issues *and* pull requests in one number and it
   * offers no way to split them, so `openIssuesIncludesPulls` says whether
   * `openIssues` is that sum — a surface that renders "3 issues" when the
   * origin meant "3 issues and pulls" is telling a small lie, every time.
   */
  readonly openIssues: number;
  readonly openPulls: number;
  readonly openIssuesIncludesPulls: boolean;
  /** On-disk size as the origin reports it, in KiB; 0 when it says nothing. */
  readonly sizeKb: number;
}

export interface RemoteLabel {
  readonly remoteId: string;
  readonly name: string;
  /** Six hex digits, no `#`. */
  readonly color: string;
}

export interface RemoteMilestone {
  /** The origin's number for it, per repository: what a second carry matches on. */
  readonly number: number;
  readonly title: string;
  readonly description: string;
  /** ISO 8601, or null when it has no due date. */
  readonly dueOn: string | null;
  readonly state: "open" | "closed";
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
  /** The origin's number of the milestone it belongs to, when it does. */
  readonly milestone?: number;
  /**
   * `owner/name` on the origin. Only a cross-repo result (search) carries
   * it — a per-repo list already knows which repo it asked about.
   */
  readonly repo?: string;
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

/**
 * A verdict on a pull, as the origin states it. Distinct from
 * `RemoteReview`, which is one *line* comment: both forges model a review as
 * a state with comments hanging off it, and only the state gates a merge.
 */
export interface RemoteReviewState {
  readonly remoteId: string;
  readonly author: string;
  readonly state: "approved" | "changes_requested" | "commented";
  readonly body: string;
  /** The head the verdict was passed on; "" when the origin does not say. */
  readonly commitOid: string;
  readonly createdAt: string;
  readonly htmlUrl: string;
}

/** How a pull's check stands on its origin, for the head named. */
export interface RemoteCheck {
  readonly word: "green" | "red" | "running" | "none";
  readonly headOid: string;
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

/** A branch on the origin, as the browse surface lists them. */
export interface RemoteBranch {
  readonly name: string;
  readonly oid: string;
  readonly protected?: boolean;
}

/**
 * One entry of one directory level. `kind` is the vocabulary both forges
 * already use: a symlink and a submodule are neither a blob nor a tree, and
 * flattening them into one would render a lie.
 */
export interface RemoteTreeEntry {
  readonly name: string;
  /** Full path from the repo root — the origin states it; we do not join. */
  readonly path: string;
  readonly kind: "blob" | "tree" | "submodule" | "symlink";
  /** Absent for trees, and for a forge that declines to say. */
  readonly size?: number;
  readonly oid: string;
}

/**
 * A file's bytes, bounded. Over the cap the content is simply not fetched:
 * `truncated` with an empty body is the honest answer, and it costs one
 * metadata request rather than the memory to hold a stranger's binary.
 */
export interface RemoteBlob {
  readonly content: Uint8Array;
  readonly size: number;
  readonly oid: string;
  readonly truncated: boolean;
}

/** A readme: a blob that knows which path it came from. */
export interface RemoteReadme extends RemoteBlob {
  readonly path: string;
}

export interface RemoteCommit {
  readonly oid: string;
  /** Subject and body together, exactly as the origin returns it. */
  readonly message: string;
  readonly author: {
    readonly name: string;
    readonly email: string;
    /** The account on the origin, when the commit is attributed to one. */
    readonly login?: string;
    readonly date: string;
  };
  readonly parents: readonly string[];
}

export interface RemoteIdentity {
  readonly login: string;
  readonly displayName: string;
  readonly htmlUrl: string;
  /**
   * The account administers the whole instance: Forgejo's and Gitea's
   * `is_admin`, GitHub's `site_admin`. A credential of such an account can
   * write every repository there is, which is what the operator guard
   * (`origins/operator.ts`) refuses on the hosts it covers.
   */
  readonly siteAdmin: boolean;
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
  /**
   * For `forbidden`: the token scopes the origin said it lacks, in the
   * origin's own words (`read:user`), when it said (Forgejo, Gitea).
   */
  readonly missingScopes?: readonly string[];
}

/**
 * Every repository a credential can see, read for a check that must not miss
 * one. `complete` is false when the pages ran out before the list did.
 */
export interface RepoWalk {
  /** What was read, complete or not: a protected repository among them counts. */
  readonly repos: readonly RemoteRepo[];
  readonly complete: boolean;
  /**
   * Why it is not complete: the pages ran out (`too_many`), the list moved
   * or its count did not add up (`moved`), or a page failed (`failed`).
   */
  readonly why?: "too_many" | "moved" | "failed";
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

/** What a token can list: private repositories too, or public ones only. */
export type TokenReach = "private" | "public";

/**
 * What every provider implements. Results are `Result<T, ProviderFailure>`
 * (see kernel/result.ts) — network and remote refusals are expected outcomes.
 * Implementations must be pure adapters: no database, no git, and no state
 * beyond the credential they were constructed with and a conditional-request
 * cache (ETags, and whatever the instance says its own page-size ceiling is).
 * That cache is why `providerFor` keeps one instance per credential rather
 * than building a fresh adapter per call.
 */
export interface Provider {
  readonly kind: OriginKind;
  readonly apiUrl: string;
  readonly webUrl: string;

  whoami(): Promise<ProviderResult<RemoteIdentity>>;
  /**
   * Whether the credential can see private repositories at all. Left out
   * by an origin whose tokens carry no such limit worth naming.
   */
  tokenReach?(): Promise<ProviderResult<TokenReach>>;
  listRepos(cursor?: string): Promise<ProviderResult<Page<RemoteRepo>>>;
  /**
   * Every repository the credential can see, for the operator guard
   * (`origins/operator.ts`): in an order a repository cannot move in while
   * the walk runs (by id, or by creation), with no fallback to another
   * endpoint, at most `maxPages` pages and `pauseMs` between them. A page
   * that fails, or a count that does not add up, ends it incomplete, with
   * what was read so far; only a walk that cannot start fails.
   */
  walkRepos(options: {
    maxPages: number;
    pauseMs?: number;
  }): Promise<ProviderResult<RepoWalk>>;
  getRepo(fullName: string): Promise<ProviderResult<RemoteRepo>>;

  // ---- reads for browsing a repository we have not mirrored ----
  //
  // Everything here is bounded before it is fetched: one directory level,
  // one page of commits, one blob under a cap. Browsing a stranger's
  // repository has to cost a bounded amount of memory and one request per
  // screen, or "look before you mirror" becomes its own denial of service —
  // against us, and against the origin.

  listBranches(
    fullName: string,
  ): Promise<ProviderResult<readonly RemoteBranch[]>>;
  /** Tags, in the same shape as branches — both forges serve them alike. */
  listTags(fullName: string): Promise<ProviderResult<readonly RemoteBranch[]>>;
  /** One level of the tree at `ref`; `path` is "" for the root. */
  listTree(
    fullName: string,
    ref: string,
    path: string,
  ): Promise<ProviderResult<readonly RemoteTreeEntry[]>>;
  getBlob(
    fullName: string,
    ref: string,
    path: string,
  ): Promise<ProviderResult<RemoteBlob>>;
  /** The repo's readme, or null when it has none. */
  getReadme(
    fullName: string,
    ref: string,
  ): Promise<ProviderResult<RemoteReadme | null>>;
  listCommits(
    fullName: string,
    ref: string,
    cursor?: string,
  ): Promise<ProviderResult<Page<RemoteCommit>>>;
  /** One commit's diff against its first parent, parsed and capped. */
  getCommitDiff(fullName: string, oid: string): Promise<ProviderResult<Diff>>;
  /** A pull's diff against its base, parsed and capped. */
  getPullDiff(fullName: string, number: number): Promise<ProviderResult<Diff>>;

  listLabels(fullName: string): Promise<ProviderResult<readonly RemoteLabel[]>>;
  /** Every milestone, open and closed. Left out by an origin that is not carried from. */
  listMilestones?(
    fullName: string,
  ): Promise<ProviderResult<readonly RemoteMilestone[]>>;
  listIssues(
    fullName: string,
    query: ListIssuesQuery,
  ): Promise<ProviderResult<Page<RemoteIssue>>>;
  getIssue(
    fullName: string,
    number: number,
  ): Promise<ProviderResult<RemoteIssue>>;
  /**
   * Issues and pulls matching a free-text query, across every repo the
   * credential can see — the one read here that is not scoped to a
   * repository, because a global search box has no repository to scope to.
   * Bounded by the origin's own search endpoint; each hit carries `repo`.
   */
  searchIssues(
    query: string,
    limit?: number,
  ): Promise<ProviderResult<readonly RemoteIssue[]>>;
  listComments(
    fullName: string,
    number: number,
    since?: string,
  ): Promise<ProviderResult<readonly RemoteComment[]>>;
  listReviews(
    fullName: string,
    number: number,
  ): Promise<ProviderResult<readonly RemoteReview[]>>;
  /**
   * The verdicts on a pull — approvals and change requests, without their
   * line comments. Separate from `listReviews` because a merge gate needs
   * only these, and walking every review's comments to find them is the
   * most expensive call in the adapter.
   */
  listReviewStates(
    fullName: string,
    number: number,
  ): Promise<ProviderResult<readonly RemoteReviewState[]>>;

  /**
   * Where the origin's check of a pull stands. Left out by an origin whose
   * checks this adapter cannot read; the pull page then shows none.
   */
  getPullCheck?(
    fullName: string,
    number: number,
  ): Promise<ProviderResult<RemoteCheck>>;

  /**
   * Ask the origin to deliver this repository's events to `url`, signed with
   * `secret`, unless it already does. Left out by an origin that cannot.
   */
  watch?(
    fullName: string,
    hook: { url: string; secret: string },
  ): Promise<ProviderResult<void>>;

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
  /** Submit a verdict on a pull, under the credential's own identity. */
  submitReview(
    fullName: string,
    number: number,
    input: {
      state: "approved" | "changes_requested" | "commented";
      body: string;
    },
  ): Promise<ProviderResult<RemoteReviewState>>;
  /**
   * The forks of a repository, as many as fit a bounded walk: what finds an
   * account's fork when it goes by a name this forge did not give it.
   */
  listForks(fullName: string): Promise<ProviderResult<readonly RemoteRepo[]>>;
  /**
   * Fork a repo into the credential's account. GitHub creates the fork
   * *asynchronously* and answers 202 with a repo that does not exist yet, so
   * a caller must poll `getRepo` until it does (`actions/contribute.ts`).
   */
  forkRepo(
    fullName: string,
    /** The fork's name, when not the upstream's own (a name already taken). */
    name?: string,
  ): Promise<ProviderResult<RemoteRepo>>;
  /**
   * Archive a repo (`PATCH /repos/{o}/{r}` with `archived: true`): read-only
   * on the origin from then on. Needs admin there; without it the answer is
   * `forbidden` and nothing changed.
   */
  archiveRepo(fullName: string): Promise<ProviderResult<void>>;

  /**
   * What git needs to talk to this origin over HTTPS with the credential,
   * passed as `GIT_CONFIG_COUNT/KEY/VALUE` so the token never reaches argv.
   *
   * `remoteUrl` is the URL git will actually contact — the clone URL, not
   * the web root. The header is scoped to exactly that host, so a redirect
   * cannot carry our credential anywhere else, and an origin whose git host
   * differs from its web host still authenticates.
   *
   * Async because resolving the secret may refresh an expiring OAuth token;
   * an empty record means the credential could not be resolved, and the
   * caller must not attempt the fetch or push at all.
   */
  gitAuthEnv(remoteUrl: string): Promise<Record<string, string>>;
}

export type ProviderResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ProviderFailure };

/**
 * What a provider is constructed from. The secret is a *function*, not a
 * field: an OAuth access token on Forgejo lives about an hour, so the value
 * that is correct when a sync starts may be stale three requests later. The
 * accessor refreshes when it must and hands back the current secret; a
 * provider therefore never holds a token, and never holds a stale one.
 */
export interface ProviderCredential {
  readonly kind: OriginKind;
  readonly apiUrl: string;
  readonly webUrl: string;
  /**
   * The account the token belongs to. Forgejo and Gitea authenticate git over
   * HTTPS with `login:token` Basic, so the adapter needs the login as well as
   * the secret; GitHub ignores the username and does not.
   */
  readonly login?: string;
  /**
   * How the secret was obtained. Forgejo wants `token <pat>` for a personal
   * access token and `Bearer <at>` for an OAuth access token; GitHub takes
   * Bearer for both. @default "pat"
   */
  readonly authKind?: AuthKind;
  /** `forge` when the origin is another forge; see `Origin.software`. */
  readonly software?: string;
  /**
   * The bearer secret for one call. A failure here is `unauthorized` — the
   * credential is gone or unrefreshable, and the origin needs reconnecting.
   */
  token(): Promise<ProviderResult<string>>;
  /**
   * Whether the credential may change anything on the origin now: asked
   * before every request that is not a read. A refusal is `forbidden`, with
   * the reason. Absent, it always may (a credential checked by nobody).
   */
  writable?(): ProviderResult<true>;
}

/** A credential that is just a stored secret — the PAT path, and tests. */
export function staticCredential(
  input: Omit<ProviderCredential, "token"> & { token: string },
): ProviderCredential {
  const { token, ...rest } = input;
  return { ...rest, token: async () => ({ ok: true, value: token }) };
}

/**
 * Discovery: given a host the user typed, which forge is it? Every answer
 * here is a heuristic, which is why the evidence travels with it. github.com
 * is known by name; `/api/v1/version` is what Forgejo and Gitea both answer
 * (and its `+gitea-` suffix is what tells them apart); NodeInfo is the one
 * thing resembling a standard, and no live instance serves it.
 */
export interface Discovered {
  readonly kind: OriginKind;
  readonly apiUrl: string;
  readonly webUrl: string;
  /** How we knew: the evidence to show the user. */
  readonly via: "known" | "nodeinfo" | "version-endpoint" | "health";
  readonly software: string;
}
