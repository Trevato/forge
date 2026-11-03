/**
 * Forgejo and Gitea. One adapter: their `Issue`, `PullRequest`, `Label`,
 * `Comment` and `Repository` shapes match field for field, and the places
 * they diverge (the version string, a `/api/forgejo/v1` endpoint, webhook
 * header names) are all in discovery, not in the data. `kind` carries which
 * one we are talking to so the surfaces can say so.
 *
 * Three facts here cost real design, and each is the opposite of GitHub's:
 *
 * - **`limit` is clamped, silently.** `max_response_items` is per instance
 *   (40 upstream, 50 on Codeberg) and asking for more just gets you fewer
 *   rows with no error — so a short page is NOT the end of a list. We read
 *   the instance's own `/settings/api` and terminate on `Link` instead.
 * - **`/pulls` has no `since`.** The only incremental path for pull requests
 *   is `/issues?type=pulls&since=`, hydrating each hit from `/pulls/{index}`
 *   for its branches and tips.
 * - **Labels are addressed by numeric id on write**, and `CreateIssueOption`
 *   accepts ids only. Rather than keep a name→id map in step with the
 *   origin, we create the issue and then `PUT` the labels by name — one more
 *   request, and no cache that can go stale under us.
 */

import { basicHeader, gitAuthEnv } from "../credentials.ts";
import type { Diff } from "../../git/diff.ts";
import { parseUnifiedDiff } from "../../git/diff.ts";
import type {
  ListIssuesQuery,
  OriginKind,
  Page,
  Provider,
  ProviderCredential,
  ProviderResult,
  RemoteBlob,
  RemoteBranch,
  RemoteCheck,
  RemoteComment,
  RemoteCommit,
  RemoteIdentity,
  RemoteIssue,
  RemoteLabel,
  RemoteReadme,
  RemoteRepo,
  RemoteReview,
  RemoteReviewState,
  RemoteTreeEntry,
  RepoWalk,
} from "../types.ts";
import {
  NO_ACCOUNT,
  NO_REVIEW,
  NOT_A_PATH,
  PATH_IS_DIRECTORY,
  PATH_IS_FILE,
} from "../words.ts";
import {
  ApiClient,
  COMMIT_PAGE,
  MAX_DIFF_BYTES,
  anchorFromHunk,
  asArray,
  asBool,
  asColor,
  asId,
  asNumber,
  asState,
  asString,
  asTime,
  dig,
  fail,
  field,
  isSafeRemotePath,
  isSafeRemoteRef,
  labelNames,
  linkNext,
  pathSegments,
  readmeEntry,
  seg,
  sortEntries,
  splitFullName,
  succeed,
  toBlob,
  toBranch,
  toCommit,
  toTreeEntry,
} from "./http.ts";

/** What we ask for before the instance tells us its own ceiling. */
const DEFAULT_LIMIT = 50;
const MAX_INTERNAL_PAGES = 10;
/** Reviews to walk when importing a pull's inline comments. */
const MAX_REVIEWS = 20;

export class ForgejoProvider implements Provider {
  readonly kind: OriginKind;
  readonly apiUrl: string;
  readonly webUrl: string;
  protected readonly api: ApiClient;
  /** The instance's `max_response_items`, learned once. */
  private limit: number | undefined;
  /** Our own numeric id, needed for the repo search that sees org repos. */
  private uid: string | undefined;

  constructor(private readonly credential: ProviderCredential) {
    this.kind = credential.kind === "gitea" ? "gitea" : "forgejo";
    this.apiUrl = credential.apiUrl;
    this.webUrl = credential.webUrl;
    this.api = new ApiClient(credential, (token) => ({
      // The OpenAPI document is explicit: "API tokens must be prepended with
      // 'token' followed by a space." Bearer works on new builds and is what
      // an OAuth access token wants; `token` is what a PAT wants everywhere.
      authorization:
        credential.authKind === "oauth" ? `Bearer ${token}` : `token ${token}`,
    }));
  }

  /**
   * The page size this instance will actually honour. Asking for more is not
   * an error here, it is a silent truncation — the one pagination bug that
   * looks like a correct empty result.
   */
  protected async pageSize(): Promise<number> {
    if (this.limit !== undefined) return this.limit;
    const result = await this.api.call({ path: "/settings/api" });
    const reported = result.ok
      ? asNumber(field(result.value.data, "max_response_items"))
      : 0;
    this.limit =
      reported > 0 ? Math.min(reported, DEFAULT_LIMIT) : DEFAULT_LIMIT;
    return this.limit;
  }

  async whoami(): Promise<ProviderResult<RemoteIdentity>> {
    const result = await this.api.call({ path: "/user" });
    if (!result.ok) return result;
    const login = asString(field(result.value.data, "login"));
    if (login === "")
      return fail("invalid_response", NO_ACCOUNT);
    this.uid = asId(field(result.value.data, "id")) || undefined;
    return succeed({
      login,
      displayName: asString(field(result.value.data, "full_name")) || login,
      htmlUrl:
        asString(field(result.value.data, "html_url")) ||
        `${this.webUrl}/${login}`,
      // Forgejo states it about the account asking (`/user` is always that
      // account), and only then: it is no secret from the account itself.
      siteAdmin: asBool(field(result.value.data, "is_admin")),
    });
  }

  /**
   * `/user/repos` takes no filters at all here — only page and limit — so it
   * shows what you own and nothing you merely collaborate on. `/repos/search`
   * with our own uid is the endpoint that sees org and collaborator repos,
   * and it wraps its rows in `{ok, data}`. We prefer it and fall back.
   */
  async listRepos(cursor?: string): Promise<ProviderResult<Page<RemoteRepo>>> {
    const page = pageOf(cursor);
    const limit = await this.pageSize();
    if (this.uid === undefined) await this.whoami();

    if (this.uid !== undefined) {
      const search = await this.api.call({
        path: "/repos/search",
        query: { uid: this.uid, limit, page, order_by: "recentupdate" },
        conditional: page === 1,
      });
      if (search.ok) {
        const rows = asArray(field(search.value.data, "data"));
        return succeed({
          items: rows.map(toRepo),
          next: nextPage(search.value.headers, rows.length, limit, page),
        });
      }
      if (search.error.error === "rate_limited") return search;
    }

    const result = await this.api.call({
      path: "/user/repos",
      query: { limit, page },
      conditional: page === 1,
    });
    if (!result.ok) return result;
    const rows = asArray(result.value.data);
    return succeed({
      items: rows.map(toRepo),
      next: nextPage(result.value.headers, rows.length, limit, page),
    });
  }

  /**
   * `listRepos` is for a person looking; this is for a check that must see
   * everything. It sorts by id, so a repository pushed or made while the walk
   * runs cannot move into a page already read; it never falls back to
   * `/user/repos`, whose order differs; and it is complete only when the
   * distinct repositories seen equal `X-Total-Count`, which must say the
   * same on every page. Anything else fails, and the guard refuses.
   */
  async walkRepos(options: {
    maxPages: number;
    pauseMs?: number;
  }): Promise<ProviderResult<RepoWalk>> {
    if (this.uid === undefined) {
      const me = await this.whoami();
      if (!me.ok) return me;
    }
    if (this.uid === undefined)
      return fail("invalid_response", "the origin gave no id for the account");
    const limit = await this.pageSize();
    const seen = new Map<string, RemoteRepo>();
    const read = (
      complete: boolean,
      why?: RepoWalk["why"],
    ): ProviderResult<RepoWalk> =>
      succeed({
        repos: [...seen.values()],
        complete,
        ...(why === undefined ? {} : { why }),
      });
    let total: number | undefined;
    for (let page = 1; page <= options.maxPages; page++) {
      if (page > 1 && (options.pauseMs ?? 0) > 0)
        await new Promise((resolve) => setTimeout(resolve, options.pauseMs));
      const result = await this.api.call({
        path: "/repos/search",
        query: { uid: this.uid, sort: "id", order: "asc", limit, page },
      });
      if (!result.ok) return read(false, "failed");
      const counted = Number(result.value.headers.get("x-total-count") ?? "");
      if (!Number.isInteger(counted) || counted < 0) return read(false, "moved");
      if (total !== undefined && counted !== total) return read(false, "moved");
      total = counted;
      const rows = asArray(field(result.value.data, "data"));
      for (const raw of rows) {
        const repo = toRepo(raw);
        seen.set(repo.remoteId || repo.fullName.toLowerCase(), repo);
      }
      if (seen.size === total) return read(true);
      // More than counted, or a page that ends the list short of the count.
      if (seen.size > total || rows.length < limit) return read(false, "moved");
    }
    return read(false, "too_many");
  }

  async getRepo(fullName: string): Promise<ProviderResult<RemoteRepo>> {
    const named = splitFullName(fullName);
    if (!named) return fail("not_found", `not a repository name: ${fullName}`);
    const result = await this.api.call({
      path: `/repos/${seg(named.owner)}/${seg(named.name)}`,
    });
    if (!result.ok) return result;
    return succeed(toRepo(result.value.data));
  }

  // ---- browsing ----

  async listBranches(
    fullName: string,
  ): Promise<ProviderResult<readonly RemoteBranch[]>> {
    const named = splitFullName(fullName);
    if (!named) return fail("not_found", `not a repository name: ${fullName}`);
    const limit = await this.pageSize();
    const branches: RemoteBranch[] = [];
    for (let page = 1; page <= MAX_INTERNAL_PAGES; page++) {
      const result = await this.api.call({
        path: `/repos/${seg(named.owner)}/${seg(named.name)}/branches`,
        query: { limit, page },
        conditional: page === 1,
      });
      if (!result.ok) return result;
      const rows = asArray(result.value.data);
      for (const raw of rows) branches.push(toBranch(raw));
      if (nextPage(result.value.headers, rows.length, limit, page) === null)
        break;
    }
    return succeed(branches.filter((b) => b.name !== ""));
  }

  async listTags(
    fullName: string,
  ): Promise<ProviderResult<readonly RemoteBranch[]>> {
    const named = splitFullName(fullName);
    if (!named) return fail("not_found", `not a repository name: ${fullName}`);
    const result = await this.api.call({
      path: `/repos/${seg(named.owner)}/${seg(named.name)}/tags`,
      query: { limit: await this.pageSize() },
      conditional: true,
    });
    if (!result.ok) return result;
    return succeed(
      asArray(result.value.data)
        .map(toBranch)
        .filter((t) => t.name !== ""),
    );
  }

  /**
   * One directory level. Same contents endpoint as GitHub, same trap: an
   * array is a directory and an object is a file.
   */
  async listTree(
    fullName: string,
    ref: string,
    path: string,
  ): Promise<ProviderResult<readonly RemoteTreeEntry[]>> {
    const named = splitFullName(fullName);
    if (!named) return fail("not_found", `not a repository name: ${fullName}`);
    if (!isSafeRemoteRef(ref) || !isSafeRemotePath(path))
      return fail("not_found", NOT_A_PATH);
    const result = await this.api.call({
      path:
        `/repos/${seg(named.owner)}/${seg(named.name)}/contents` +
        (path === "" ? "" : `/${pathSegments(path)}`),
      query: { ref },
      conditional: true,
    });
    if (!result.ok) return result;
    if (!Array.isArray(result.value.data))
      return fail("not_found", PATH_IS_FILE);
    return succeed(
      sortEntries(result.value.data.map((r) => toTreeEntry(r, path))),
    );
  }

  async getBlob(
    fullName: string,
    ref: string,
    path: string,
  ): Promise<ProviderResult<RemoteBlob>> {
    const named = splitFullName(fullName);
    if (!named) return fail("not_found", `not a repository name: ${fullName}`);
    if (!isSafeRemoteRef(ref) || path === "" || !isSafeRemotePath(path))
      return fail("not_found", NOT_A_PATH);
    const result = await this.api.call({
      path: `/repos/${seg(named.owner)}/${seg(named.name)}/contents/${pathSegments(path)}`,
      query: { ref },
    });
    if (!result.ok) return result;
    if (Array.isArray(result.value.data))
      return fail("not_found", PATH_IS_DIRECTORY);
    return succeed(toBlob(result.value.data));
  }

  /**
   * There is no readme endpoint here — the web UI resolves it itself — so
   * the root listing is the lookup, and one that costs nothing extra when
   * the browse screen has already asked for that tree.
   */
  async getReadme(
    fullName: string,
    ref: string,
  ): Promise<ProviderResult<RemoteReadme | null>> {
    const root = await this.listTree(fullName, ref, "");
    if (!root.ok)
      return root.error.error === "not_found" ? succeed(null) : root;
    const entry = readmeEntry(root.value);
    if (entry === undefined) return succeed(null);
    const blob = await this.getBlob(fullName, ref, entry.path);
    if (!blob.ok)
      return blob.error.error === "not_found" ? succeed(null) : blob;
    return succeed({ ...blob.value, path: entry.path });
  }

  async listCommits(
    fullName: string,
    ref: string,
    cursor?: string,
  ): Promise<ProviderResult<Page<RemoteCommit>>> {
    const named = splitFullName(fullName);
    if (!named) return fail("not_found", `not a repository name: ${fullName}`);
    if (!isSafeRemoteRef(ref)) return fail("not_found", "not a ref");
    const page = pageOf(cursor);
    const limit = Math.min(await this.pageSize(), COMMIT_PAGE);
    const result = await this.api.call({
      path: `/repos/${seg(named.owner)}/${seg(named.name)}/commits`,
      query: { sha: ref, limit, page, stat: "false", verification: "false" },
    });
    if (!result.ok) return result;
    const rows = asArray(result.value.data);
    return succeed({
      items: rows.map(toCommit),
      next: nextPage(result.value.headers, rows.length, limit, page),
    });
  }

  async getCommitDiff(
    fullName: string,
    oid: string,
  ): Promise<ProviderResult<Diff>> {
    const named = splitFullName(fullName);
    if (!named) return fail("not_found", `not a repository name: ${fullName}`);
    if (!isSafeRemoteRef(oid)) return fail("not_found", "not a commit");
    return this.diff(
      `/repos/${seg(named.owner)}/${seg(named.name)}/git/commits/${seg(oid)}.diff`,
    );
  }

  async getPullDiff(
    fullName: string,
    number: number,
  ): Promise<ProviderResult<Diff>> {
    const named = splitFullName(fullName);
    if (!named) return fail("not_found", `not a repository name: ${fullName}`);
    if (!Number.isInteger(number) || number < 1)
      return fail("not_found", "not a pull request");
    return this.diff(
      `/repos/${seg(named.owner)}/${seg(named.name)}/pulls/${number}.diff`,
    );
  }

  /** Here the diff is a `.diff` suffix on the path, not a media type. */
  private async diff(path: string): Promise<ProviderResult<Diff>> {
    const result = await this.api.text({
      path,
      accept: "text/plain, */*",
      maxBytes: MAX_DIFF_BYTES,
    });
    if (!result.ok) return result;
    return succeed(parseUnifiedDiff(result.value.text));
  }

  async listLabels(
    fullName: string,
  ): Promise<ProviderResult<readonly RemoteLabel[]>> {
    const named = splitFullName(fullName);
    if (!named) return fail("not_found", `not a repository name: ${fullName}`);
    const limit = await this.pageSize();
    const labels: RemoteLabel[] = [];
    for (let page = 1; page <= MAX_INTERNAL_PAGES; page++) {
      const result = await this.api.call({
        path: `/repos/${seg(named.owner)}/${seg(named.name)}/labels`,
        query: { limit, page },
      });
      if (!result.ok) return result;
      const rows = asArray(result.value.data);
      for (const raw of rows) {
        labels.push({
          remoteId: asId(field(raw, "id")),
          name: asString(field(raw, "name")),
          color: asColor(field(raw, "color")),
        });
      }
      if (nextPage(result.value.headers, rows.length, limit, page) === null)
        break;
    }
    return succeed(labels.filter((l) => l.name !== ""));
  }

  async listIssues(
    fullName: string,
    query: ListIssuesQuery,
  ): Promise<ProviderResult<Page<RemoteIssue>>> {
    const named = splitFullName(fullName);
    if (!named) return fail("not_found", `not a repository name: ${fullName}`);
    const page = pageOf(query.cursor);
    const limit = await this.pageSize();
    const result = await this.api.call({
      path: `/repos/${seg(named.owner)}/${seg(named.name)}/issues`,
      query: {
        type: query.kind === "pull" ? "pulls" : "issues",
        state: query.state,
        limit,
        page,
        sort: "recentupdate",
        ...(query.since === undefined ? {} : { since: query.since }),
      },
    });
    if (!result.ok) return result;

    const rows = asArray(result.value.data);
    const items: RemoteIssue[] = [];
    for (const raw of rows) {
      // `/pulls` can hand back null entries when a row fails to load; the
      // issue list can too. A gap is skipped, never dereferenced.
      if (raw === null || typeof raw !== "object") continue;
      if (query.kind !== "pull") {
        items.push(toIssue(raw));
        continue;
      }
      const number = asNumber(field(raw, "number"));
      const hydrated = await this.getPull(named.owner, named.name, number, raw);
      if (hydrated.ok) items.push(hydrated.value);
      else if (hydrated.error.error === "rate_limited") return hydrated;
    }
    return succeed({
      items,
      next: nextPage(result.value.headers, rows.length, limit, page),
    });
  }

  /**
   * Forgejo has a cross-repo issue search of its own, already scoped to what
   * the credential can see — so unlike GitHub there is no scope to append,
   * and the repo travels on each row as `repository.full_name`.
   */
  async searchIssues(
    query: string,
    limit = 30,
  ): Promise<ProviderResult<readonly RemoteIssue[]>> {
    const text = query.trim();
    if (text === "") return succeed([]);
    const ceiling = await this.pageSize();
    const result = await this.api.call({
      path: "/repos/issues/search",
      query: {
        q: text,
        state: "all",
        limit: Math.min(Math.max(limit, 1), ceiling),
        page: 1,
      },
    });
    if (!result.ok) return result;
    const items: RemoteIssue[] = [];
    for (const raw of asArray(result.value.data)) {
      if (raw === null || typeof raw !== "object") continue;
      const issue = toIssue(raw);
      const repo = asString(dig(raw, "repository", "full_name"));
      items.push(repo === "" ? issue : { ...issue, repo });
    }
    return succeed(items);
  }

  async getIssue(
    fullName: string,
    number: number,
  ): Promise<ProviderResult<RemoteIssue>> {
    const named = splitFullName(fullName);
    if (!named) return fail("not_found", `not a repository name: ${fullName}`);
    const result = await this.api.call({
      path: `/repos/${seg(named.owner)}/${seg(named.name)}/issues/${number}`,
    });
    if (!result.ok) return result;
    if (field(result.value.data, "pull_request") !== undefined) {
      return this.getPull(named.owner, named.name, number, result.value.data);
    }
    return succeed(toIssue(result.value.data));
  }

  /**
   * The issue payload already carries merge state inline (a real advantage
   * over GitHub), but not the branches or their tips, so a pull still costs
   * one hydration call. `issueRaw` supplies the labels and body the pull
   * endpoint reports identically, and the merge state if hydration fails.
   */
  private async getPull(
    owner: string,
    name: string,
    number: number,
    issueRaw?: unknown,
  ): Promise<ProviderResult<RemoteIssue>> {
    const result = await this.api.call({
      path: `/repos/${seg(owner)}/${seg(name)}/pulls/${number}`,
    });
    if (!result.ok) {
      if (issueRaw === undefined) return result;
      if (result.error.error === "rate_limited") return result;
      // Better a pull with no branches than no pull at all: the conversation
      // is real either way, and the next sync can fill in the rest.
      return succeed(toPullFromIssue(issueRaw));
    }
    return succeed(toPull(result.value.data));
  }

  /** The head's combined commit status: success, failure or error, pending. */
  async getPullCheck(fullName: string, number: number): Promise<ProviderResult<RemoteCheck>> {
    const named = splitFullName(fullName);
    if (!named) return fail("not_found", `not a repository name: ${fullName}`);
    const base = `/repos/${seg(named.owner)}/${seg(named.name)}`;
    const pull = await this.api.call({ path: `${base}/pulls/${number}` });
    if (!pull.ok) return pull;
    const headOid = asString(dig(pull.value.data, "head", "sha"));
    if (!/^[0-9a-f]{40,64}$/.test(headOid)) return succeed({ word: "none", headOid: "" });
    const status = await this.api.call({ path: `${base}/commits/${headOid}/status` });
    if (!status.ok) return status;
    const state = asString(field(status.value.data, "state"));
    const word =
      state === "success"
        ? "green"
        : state === "failure" || state === "error"
          ? "red"
          : state === "pending" && asNumber(field(status.value.data, "total_count")) > 0
            ? "running"
            : "none";
    return succeed({ word, headOid });
  }

  async listComments(
    fullName: string,
    number: number,
    since?: string,
  ): Promise<ProviderResult<readonly RemoteComment[]>> {
    const named = splitFullName(fullName);
    if (!named) return fail("not_found", `not a repository name: ${fullName}`);
    const result = await this.api.call({
      path: `/repos/${seg(named.owner)}/${seg(named.name)}/issues/${number}/comments`,
      query: since === undefined ? {} : { since },
    });
    if (!result.ok) return result;
    return succeed(asArray(result.value.data).map(toComment));
  }

  /**
   * There is no standalone inline-comment endpoint here: comments hang off
   * reviews, so the walk is reviews-then-their-comments. This is the least
   * portable operation in the adapter, and the reason forge's own model
   * stores loose anchored comments rather than review objects.
   */
  async listReviews(
    fullName: string,
    number: number,
  ): Promise<ProviderResult<readonly RemoteReview[]>> {
    const named = splitFullName(fullName);
    if (!named) return fail("not_found", `not a repository name: ${fullName}`);
    const base = `/repos/${seg(named.owner)}/${seg(named.name)}/pulls/${number}`;
    const list = await this.api.call({ path: `${base}/reviews` });
    if (!list.ok) return list;

    const reviews: RemoteReview[] = [];
    for (const review of asArray(list.value.data).slice(0, MAX_REVIEWS)) {
      const reviewId = asId(field(review, "id"));
      if (reviewId === "") continue;
      const author = asString(dig(review, "user", "login"));
      const comments = await this.api.call({
        path: `${base}/reviews/${seg(reviewId)}/comments`,
      });
      if (!comments.ok) {
        if (comments.error.error === "rate_limited") return comments;
        continue;
      }
      for (const raw of asArray(comments.value.data)) {
        reviews.push(toReview(raw, author));
      }
    }
    return succeed(reviews);
  }

  /**
   * The verdicts alone — the same `/reviews` list `listReviews` walks, read
   * for its states instead of followed into each review's comments. One
   * request rather than one per review, which is why the merge gate uses it.
   */
  async listReviewStates(
    fullName: string,
    number: number,
  ): Promise<ProviderResult<readonly RemoteReviewState[]>> {
    const named = splitFullName(fullName);
    if (!named) return fail("not_found", `not a repository name: ${fullName}`);
    const list = await this.api.call({
      path: `/repos/${seg(named.owner)}/${seg(named.name)}/pulls/${number}/reviews`,
    });
    if (!list.ok) return list;
    const states: RemoteReviewState[] = [];
    for (const raw of asArray(list.value.data).slice(0, MAX_REVIEWS)) {
      const state = toReviewState(raw);
      if (state !== undefined) states.push(state);
    }
    return succeed(states);
  }

  async submitReview(
    fullName: string,
    number: number,
    input: {
      state: "approved" | "changes_requested" | "commented";
      body: string;
    },
  ): Promise<ProviderResult<RemoteReviewState>> {
    const named = splitFullName(fullName);
    if (!named) return fail("not_found", `not a repository name: ${fullName}`);
    // Forgejo's `event` takes its own noun vocabulary, not GitHub's verbs:
    // APPROVED / REQUEST_CHANGES / COMMENT.
    const event =
      input.state === "approved"
        ? "APPROVED"
        : input.state === "changes_requested"
          ? "REQUEST_CHANGES"
          : "COMMENT";
    const result = await this.api.call({
      path: `/repos/${seg(named.owner)}/${seg(named.name)}/pulls/${number}/reviews`,
      method: "POST",
      body: { event, body: input.body },
    });
    if (!result.ok) return result;
    const state = toReviewState(result.value.data);
    return state === undefined
      ? fail("invalid_response", NO_REVIEW)
      : succeed(state);
  }

  async createIssue(
    fullName: string,
    input: { title: string; body: string; labels?: readonly string[] },
  ): Promise<ProviderResult<RemoteIssue>> {
    const named = splitFullName(fullName);
    if (!named) return fail("not_found", `not a repository name: ${fullName}`);
    const result = await this.api.call({
      path: `/repos/${seg(named.owner)}/${seg(named.name)}/issues`,
      method: "POST",
      body: { title: input.title, body: input.body },
    });
    if (!result.ok) return result;
    const created = toIssue(result.value.data);
    if (input.labels === undefined || input.labels.length === 0)
      return succeed(created);
    // Creation takes label ids only; setting them by name afterwards needs no
    // id map, and therefore has no cache to go stale.
    const labelled = await this.setLabels(
      fullName,
      created.number,
      input.labels,
    );
    if (!labelled.ok) return succeed(created);
    return succeed({ ...created, labels: labelled.value.map((l) => l.name) });
  }

  async createComment(
    fullName: string,
    number: number,
    body: string,
  ): Promise<ProviderResult<RemoteComment>> {
    const named = splitFullName(fullName);
    if (!named) return fail("not_found", `not a repository name: ${fullName}`);
    const result = await this.api.call({
      path: `/repos/${seg(named.owner)}/${seg(named.name)}/issues/${number}/comments`,
      method: "POST",
      body: { body },
    });
    if (!result.ok) return result;
    return succeed(toComment(result.value.data));
  }

  async setState(
    fullName: string,
    number: number,
    state: "open" | "closed",
  ): Promise<ProviderResult<RemoteIssue>> {
    const named = splitFullName(fullName);
    if (!named) return fail("not_found", `not a repository name: ${fullName}`);
    // This answers 201, not 200, on a successful edit — any 2xx is a success.
    const result = await this.api.call({
      path: `/repos/${seg(named.owner)}/${seg(named.name)}/issues/${number}`,
      method: "PATCH",
      body: { state },
    });
    if (!result.ok) return result;
    if (field(result.value.data, "pull_request") !== undefined)
      return this.getPull(named.owner, named.name, number, result.value.data);
    return succeed(toIssue(result.value.data));
  }

  async setLabels(
    fullName: string,
    number: number,
    labels: readonly string[],
  ): Promise<ProviderResult<readonly RemoteLabel[]>> {
    const named = splitFullName(fullName);
    if (!named) return fail("not_found", `not a repository name: ${fullName}`);
    // PUT replaces, POST adds. "Set the labels to exactly this" is always PUT.
    const result = await this.api.call({
      path: `/repos/${seg(named.owner)}/${seg(named.name)}/issues/${number}/labels`,
      method: "PUT",
      body: { labels: [...labels] },
    });
    if (!result.ok) return result;
    return succeed(
      asArray(result.value.data).map((raw) => ({
        remoteId: asId(field(raw, "id")),
        name: asString(field(raw, "name")),
        color: asColor(field(raw, "color")),
      })),
    );
  }

  async createPull(
    fullName: string,
    input: { title: string; body: string; base: string; head: string },
  ): Promise<ProviderResult<RemoteIssue>> {
    const named = splitFullName(fullName);
    if (!named) return fail("not_found", `not a repository name: ${fullName}`);
    // `head` is a plain string here: a branch of this repository, or
    // `owner:branch` for a branch of a fork (Forgejo's parseCompareInfo,
    // checked on Forgejo 15.0.9). A reader proposes with the second form
    // (`origins/fork-route.ts`).
    const result = await this.api.call({
      path: `/repos/${seg(named.owner)}/${seg(named.name)}/pulls`,
      method: "POST",
      body: {
        title: input.title,
        body: input.body,
        base: input.base,
        head: input.head,
      },
    });
    if (!result.ok) return result;
    return succeed(toPull(result.value.data));
  }

  async listForks(
    fullName: string,
  ): Promise<ProviderResult<readonly RemoteRepo[]>> {
    const named = splitFullName(fullName);
    if (!named) return fail("not_found", `not a repository name: ${fullName}`);
    const limit = await this.pageSize();
    const forks: RemoteRepo[] = [];
    for (let page = 1; page <= MAX_INTERNAL_PAGES; page++) {
      const result = await this.api.call({
        path: `/repos/${seg(named.owner)}/${seg(named.name)}/forks`,
        query: { limit, page },
      });
      if (!result.ok) return result;
      const rows = asArray(result.value.data);
      forks.push(...rows.map((r) => toRepo(r)));
      if (nextPage(result.value.headers, rows.length, limit, page) === null) break;
    }
    return succeed(forks);
  }

  async forkRepo(
    fullName: string,
    name?: string,
  ): Promise<ProviderResult<RemoteRepo>> {
    const named = splitFullName(fullName);
    if (!named) return fail("not_found", `not a repository name: ${fullName}`);
    const result = await this.api.call({
      path: `/repos/${seg(named.owner)}/${seg(named.name)}/forks`,
      method: "POST",
      // Both forges take `name` (Forgejo's CreateForkOption, GitHub's
      // create-fork body); without it the fork takes the upstream's name.
      body: name === undefined ? {} : { name },
    });
    if (!result.ok) return result;
    return succeed(toRepo(result.value.data));
  }

  async archiveRepo(fullName: string): Promise<ProviderResult<void>> {
    const named = splitFullName(fullName);
    if (!named) return fail("not_found", `not a repository name: ${fullName}`);
    const result = await this.api.call({
      path: `/repos/${seg(named.owner)}/${seg(named.name)}`,
      method: "PATCH",
      body: { archived: true },
    });
    if (!result.ok) return result;
    return succeed(undefined);
  }

  /**
   * Git over HTTPS takes the token as a Basic password, with the username
   * ignored — so a personal access token pairs with the login it belongs to,
   * and an OAuth access token pairs with the conventional `oauth2` user.
   * (Recent builds accept a bearer token here too; Basic works on every
   * version, and a 2FA account cannot use a real password at all.)
   */
  async gitAuthEnv(remoteUrl: string): Promise<Record<string, string>> {
    const token = await this.credential.token();
    if (!token.ok) return {};
    const user =
      this.credential.authKind === "oauth"
        ? "oauth2"
        : (this.credential.login ?? "forge");
    return gitAuthEnv(remoteUrl, basicHeader(user, token.value));
  }
}

// ---- pagination ----

const pageOf = (cursor: string | undefined): number => {
  const n = Number(cursor);
  return Number.isInteger(n) && n > 0 ? n : 1;
};

/**
 * `Link: rel="next"` is authoritative and both forges emit it. The size
 * comparison is only the fallback for an instance that does not — and it is
 * deliberately conservative, because a page shorter than `limit` here means
 * "the server clamped you", not "the list ended".
 */
export function nextPage(
  headers: Headers,
  received: number,
  limit: number,
  page: number,
): string | null {
  if (linkNext(headers)) return String(page + 1);
  if (received > 0 && received >= limit) return String(page + 1);
  return null;
}

// ---- mapping ----

export function toRepo(raw: unknown): RemoteRepo {
  const fullName = asString(field(raw, "full_name"));
  const named = splitFullName(fullName);
  return {
    remoteId: asId(field(raw, "id")),
    fullName,
    owner: named?.owner ?? asString(dig(raw, "owner", "login")),
    name: named?.name ?? asString(field(raw, "name")),
    description: asString(field(raw, "description")),
    // `internal` has no GitHub analogue and no local one; it is not public,
    // so it becomes private. Never silently widen a visibility on import.
    private: asBool(field(raw, "private")) || asBool(field(raw, "internal")),
    fork: asBool(field(raw, "fork")),
    parent: asString(dig(raw, "parent", "full_name")) || null,
    defaultBranch: asString(field(raw, "default_branch")) || "main",
    cloneUrl: asString(field(raw, "clone_url")),
    sshUrl: asString(field(raw, "ssh_url")),
    htmlUrl: asString(field(raw, "html_url")),
    // No `pushed_at` here — `updated_at` is the only change signal offered.
    pushedAt: asTime(field(raw, "updated_at")),
    permissions: {
      push: asBool(dig(raw, "permissions", "push")),
      admin: asBool(dig(raw, "permissions", "admin")),
    },
    // Forgejo separates the two, so no honesty flag is needed: its
    // `open_issues_count` really is issues alone.
    openIssues: asNumber(field(raw, "open_issues_count")),
    openPulls: asNumber(field(raw, "open_pr_counter")),
    openIssuesIncludesPulls: false,
    sizeKb: asNumber(field(raw, "size")),
  };
}

/**
 * One verdict, or `undefined` when the row is not one. Forgejo's own words
 * are APPROVED / REQUEST_CHANGES / COMMENT, and it also has PENDING (an
 * unsubmitted draft) and REQUEST_REVIEW (a request *for* one) — neither is a
 * verdict and neither is counted as one.
 */
function toReviewState(raw: unknown): RemoteReviewState | undefined {
  const word = asString(field(raw, "state")).toUpperCase();
  const state =
    word === "APPROVED"
      ? ("approved" as const)
      : word === "REQUEST_CHANGES" || word === "CHANGES_REQUESTED"
        ? ("changes_requested" as const)
        : word === "COMMENT" || word === "COMMENTED"
          ? ("commented" as const)
          : undefined;
  if (state === undefined) return undefined;
  return {
    remoteId: asId(field(raw, "id")),
    author: authorOf(raw),
    state,
    body: asString(field(raw, "body")),
    commitOid: asString(field(raw, "commit_id")),
    createdAt:
      asTime(field(raw, "submitted_at")) ??
      asTime(field(raw, "created_at")) ??
      new Date().toISOString(),
    htmlUrl: asString(field(raw, "html_url")),
  };
}

/** The author, preferring the real account and falling back to provenance:
 * content migrated into this forge carries the login it came from. */
function authorOf(raw: unknown): string {
  return (
    asString(dig(raw, "user", "login")) ||
    asString(field(raw, "original_author"))
  );
}

function toIssue(raw: unknown): RemoteIssue {
  const created = asTime(field(raw, "created_at")) ?? new Date().toISOString();
  return {
    remoteId: asId(field(raw, "id")),
    number: asNumber(field(raw, "number")),
    title: asString(field(raw, "title")),
    body: asString(field(raw, "body")),
    author: authorOf(raw),
    state: asState(field(raw, "state")),
    labels: labelNames(field(raw, "labels")),
    createdAt: created,
    updatedAt: asTime(field(raw, "updated_at")) ?? created,
    closedAt: asTime(field(raw, "closed_at")),
    htmlUrl: asString(field(raw, "html_url")),
    comments: asNumber(field(raw, "comments")),
  };
}

function toPull(raw: unknown): RemoteIssue {
  const headRepo =
    asString(dig(raw, "head", "repo", "full_name")) ||
    asString(dig(raw, "base", "repo", "full_name"));
  return {
    ...toIssue(raw),
    pull: {
      baseBranch: asString(dig(raw, "base", "ref")),
      headBranch: asString(dig(raw, "head", "ref")),
      headRepo,
      baseOid: asString(dig(raw, "base", "sha")),
      headOid: asString(dig(raw, "head", "sha")),
      // Never infer a merge from `state: closed` — closed-unmerged and
      // closed-merged are different outcomes.
      mergedAt: asTime(field(raw, "merged_at")),
      draft: asBool(field(raw, "draft")),
    },
  };
}

/** A pull described only by its issue row: merge state is inline here. */
function toPullFromIssue(raw: unknown): RemoteIssue {
  const inline = field(raw, "pull_request");
  return {
    ...toIssue(raw),
    pull: {
      baseBranch: "",
      headBranch: "",
      headRepo: "",
      baseOid: "",
      headOid: "",
      mergedAt: asTime(field(inline, "merged_at")),
      draft: asBool(field(inline, "draft")),
    },
  };
}

function toComment(raw: unknown): RemoteComment {
  const created = asTime(field(raw, "created_at")) ?? new Date().toISOString();
  return {
    remoteId: asId(field(raw, "id")),
    author: authorOf(raw),
    body: asString(field(raw, "body")),
    createdAt: created,
    updatedAt: asTime(field(raw, "updated_at")) ?? created,
    htmlUrl: asString(field(raw, "html_url")),
  };
}

/**
 * Anchoring, from the only signal on offer. There is no `line` or `side`
 * here — just `position` (an offset into the diff hunk) and the hunk itself,
 * which is truncated at the commented row. So the last row of the hunk IS
 * the anchor, and reading it back out is exact.
 */
function toReview(raw: unknown, reviewAuthor: string): RemoteReview {
  const anchor = anchorFromHunk(asString(field(raw, "diff_hunk")));
  return {
    remoteId: asId(field(raw, "id")),
    author: authorOf(raw) || reviewAuthor,
    body: asString(field(raw, "body")),
    path: asString(field(raw, "path")),
    line: anchor.line,
    side: anchor.side,
    createdAt: asTime(field(raw, "created_at")) ?? new Date().toISOString(),
    htmlUrl: asString(field(raw, "html_url")),
  };
}
