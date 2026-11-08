/**
 * GitHub (and GitHub Enterprise, which is the same API under `/api/v3`).
 *
 * Two facts shape this whole file. First, `/issues` returns pull requests
 * too — they are issues with a `pull_request` key — so every issue list is
 * filtered by that key, in both directions, or a mirror grows phantom
 * issues. Second, only `/issues` takes `since`, so incremental sync for
 * pulls runs through the issue list as well and hydrates each hit from
 * `/pulls/{n}`, where base, head and `merged_at` actually live.
 */

import type { Diff } from "../../git/diff.ts";
import { parseUnifiedDiff } from "../../git/diff.ts";
import type {
  ListIssuesQuery,
  Page,
  Provider,
  ProviderCredential,
  ProviderResult,
  RemoteBlob,
  RemoteBranch,
  RemoteComment,
  RemoteCommit,
  RemoteIdentity,
  RemoteIssue,
  RemoteLabel,
  RemoteReadme,
  RemoteRepo,
  RemoteReview,
  RemoteMilestone,
  RemoteReviewState,
  RemoteTreeEntry,
  TokenReach,
  RepoWalk,
} from "../types.ts";
import {
  NO_ACCOUNT,
  NO_REVIEW,
  NOT_A_PATH,
  PATH_IS_DIRECTORY,
  PATH_IS_FILE,
} from "../words.ts";
import { basicHeader, gitAuthEnv } from "../credentials.ts";
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
  seg,
  sortEntries,
  splitFullName,
  succeed,
  toBlob,
  toBranch,
  toCommit,
  toTreeEntry,
} from "./http.ts";

const PER_PAGE = 100;
/** A page walk we drive ourselves (labels, reviews) stops here regardless. */
const MAX_INTERNAL_PAGES = 10;

export class GitHubProvider implements Provider {
  readonly kind = "github" as const;
  readonly apiUrl: string;
  readonly webUrl: string;
  private readonly api: ApiClient;
  /** The account's login, for the search scope. Learned once. */
  private login: string | undefined;

  constructor(private readonly credential: ProviderCredential) {
    this.login = credential.login;
    this.apiUrl = credential.apiUrl;
    this.webUrl = credential.webUrl;
    this.api = new ApiClient(credential, (token) => ({
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      // Pinned: omitting it floats onto whatever the current default is.
      "x-github-api-version": "2022-11-28",
    }));
  }

  async whoami(): Promise<ProviderResult<RemoteIdentity>> {
    const result = await this.api.call({ path: "/user" });
    if (!result.ok) return result;
    const login = asString(field(result.value.data, "login"));
    if (login === "")
      return fail("invalid_response", NO_ACCOUNT);
    return succeed({
      login,
      displayName: asString(field(result.value.data, "name")) || login,
      htmlUrl:
        asString(field(result.value.data, "html_url")) ||
        `${this.webUrl}/${login}`,
      siteAdmin: asBool(field(result.value.data, "site_admin")),
    });
  }

  /**
   * A classic token (and an OAuth grant) names its scopes on every answer
   * in `X-OAuth-Scopes`: without `repo` it lists public repositories only.
   * A fine-grained token names none, so one private row is asked for.
   */
  async tokenReach(): Promise<ProviderResult<TokenReach>> {
    const user = await this.api.call({ path: "/user" });
    if (!user.ok) return user;
    const scopes = user.value.headers.get("x-oauth-scopes");
    if (scopes !== null)
      return succeed(
        scopes.split(",").some((s) => s.trim() === "repo") ? "private" : "public",
      );
    const probe = await this.api.call({
      path: "/user/repos",
      query: { visibility: "private", per_page: 1 },
    });
    if (!probe.ok) return probe;
    return succeed(asArray(probe.value.data).length > 0 ? "private" : "public");
  }

  async listRepos(cursor?: string): Promise<ProviderResult<Page<RemoteRepo>>> {
    const page = pageOf(cursor);
    const result = await this.api.call({
      path: "/user/repos",
      query: {
        per_page: PER_PAGE,
        page,
        sort: "pushed",
        affiliation: "owner,collaborator,organization_member",
      },
      conditional: page === 1,
    });
    if (!result.ok) return result;
    return succeed({
      items: asArray(result.value.data).map((r) => toRepo(r)),
      next: linkNext(result.value.headers) ? String(page + 1) : null,
    });
  }

  /**
   * The guard's walk on GitHub: `/user/repos` oldest first, so a repository
   * made while the walk runs lands on a later page rather than shifting an
   * earlier one, and `Link` decides the end. GitHub counts nothing here,
   * so there is no total to check against; a failed page fails the walk.
   */
  async walkRepos(options: {
    maxPages: number;
    pauseMs?: number;
  }): Promise<ProviderResult<RepoWalk>> {
    const repos = new Map<string, RemoteRepo>();
    for (let page = 1; page <= options.maxPages; page++) {
      if (page > 1 && (options.pauseMs ?? 0) > 0)
        await new Promise((resolve) => setTimeout(resolve, options.pauseMs));
      const result = await this.api.call({
        path: "/user/repos",
        query: {
          per_page: PER_PAGE,
          page,
          sort: "created",
          direction: "asc",
          affiliation: "owner,collaborator,organization_member",
        },
      });
      if (!result.ok)
        return succeed({ repos: [...repos.values()], complete: false, why: "failed" });
      for (const raw of asArray(result.value.data)) {
        const repo = toRepo(raw);
        repos.set(repo.remoteId || repo.fullName.toLowerCase(), repo);
      }
      if (!linkNext(result.value.headers))
        return succeed({ repos: [...repos.values()], complete: true });
    }
    return succeed({ repos: [...repos.values()], complete: false, why: "too_many" });
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
    const branches: RemoteBranch[] = [];
    for (let page = 1; page <= MAX_INTERNAL_PAGES; page++) {
      const result = await this.api.call({
        path: `/repos/${seg(named.owner)}/${seg(named.name)}/branches`,
        query: { per_page: PER_PAGE, page },
        conditional: page === 1,
      });
      if (!result.ok) return result;
      const batch = asArray(result.value.data);
      for (const raw of batch) branches.push(toBranch(raw));
      if (batch.length < PER_PAGE) break;
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
      query: { per_page: PER_PAGE },
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
   * One directory level. The contents endpoint answers an array for a
   * directory and an object for a file, which is the whole trap: a caller
   * asking for a tree and getting a file must be told, not handed one row.
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

  /** GitHub has a readme endpoint of its own, and it honours `ref`. */
  async getReadme(
    fullName: string,
    ref: string,
  ): Promise<ProviderResult<RemoteReadme | null>> {
    const named = splitFullName(fullName);
    if (!named) return fail("not_found", `not a repository name: ${fullName}`);
    if (!isSafeRemoteRef(ref)) return fail("not_found", "not a ref");
    const result = await this.api.call({
      path: `/repos/${seg(named.owner)}/${seg(named.name)}/readme`,
      query: { ref },
      conditional: true,
    });
    // No readme is an ordinary answer, not a failure of the browse.
    if (!result.ok)
      return result.error.error === "not_found" ? succeed(null) : result;
    const path = asString(field(result.value.data, "path"));
    if (path === "") return succeed(null);
    return succeed({ ...toBlob(result.value.data), path });
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
    const result = await this.api.call({
      path: `/repos/${seg(named.owner)}/${seg(named.name)}/commits`,
      query: { sha: ref, per_page: COMMIT_PAGE, page },
    });
    if (!result.ok) return result;
    const rows = asArray(result.value.data);
    return succeed({
      items: rows.map(toCommit),
      next:
        linkNext(result.value.headers) || rows.length >= COMMIT_PAGE
          ? String(page + 1)
          : null,
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
      `/repos/${seg(named.owner)}/${seg(named.name)}/commits/${seg(oid)}`,
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
      `/repos/${seg(named.owner)}/${seg(named.name)}/pulls/${number}`,
    );
  }

  /** The diff media type turns either endpoint into unified diff text. */
  private async diff(path: string): Promise<ProviderResult<Diff>> {
    const result = await this.api.text({
      path,
      accept: "application/vnd.github.diff",
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
    const labels: RemoteLabel[] = [];
    for (let page = 1; page <= MAX_INTERNAL_PAGES; page++) {
      const result = await this.api.call({
        path: `/repos/${seg(named.owner)}/${seg(named.name)}/labels`,
        query: { per_page: PER_PAGE, page },
        conditional: page === 1,
      });
      if (!result.ok) return result;
      const batch = asArray(result.value.data);
      for (const raw of batch) {
        labels.push({
          remoteId: asId(field(raw, "id")),
          name: asString(field(raw, "name")),
          color: asColor(field(raw, "color")),
        });
      }
      if (batch.length < PER_PAGE) break;
    }
    return succeed(labels.filter((l) => l.name !== ""));
  }

  async listMilestones(
    fullName: string,
  ): Promise<ProviderResult<readonly RemoteMilestone[]>> {
    const named = splitFullName(fullName);
    if (!named) return fail("not_found", `not a repository name: ${fullName}`);
    const milestones: RemoteMilestone[] = [];
    for (let page = 1; page <= MAX_INTERNAL_PAGES; page++) {
      const result = await this.api.call({
        path: `/repos/${seg(named.owner)}/${seg(named.name)}/milestones`,
        query: { state: "all", per_page: PER_PAGE, page },
      });
      if (!result.ok) return result;
      const batch = asArray(result.value.data);
      for (const raw of batch) {
        milestones.push({
          number: asNumber(field(raw, "number")),
          title: asString(field(raw, "title")),
          description: asString(field(raw, "description")),
          dueOn: asTime(field(raw, "due_on")),
          state: asState(field(raw, "state")),
        });
      }
      if (batch.length < PER_PAGE) break;
    }
    return succeed(milestones.filter((m) => m.number > 0));
  }

  /**
   * One list endpoint serves both kinds. Issues come back whole; pulls are
   * recognised by the `pull_request` key and hydrated one call each, because
   * the issue payload knows nothing about branches.
   */
  async listIssues(
    fullName: string,
    query: ListIssuesQuery,
  ): Promise<ProviderResult<Page<RemoteIssue>>> {
    const named = splitFullName(fullName);
    if (!named) return fail("not_found", `not a repository name: ${fullName}`);
    const page = pageOf(query.cursor);
    const result = await this.api.call({
      path: `/repos/${seg(named.owner)}/${seg(named.name)}/issues`,
      query: {
        state: query.state,
        per_page: PER_PAGE,
        page,
        sort: "updated",
        direction: "asc",
        ...(query.since === undefined ? {} : { since: query.since }),
      },
    });
    if (!result.ok) return result;

    const items: RemoteIssue[] = [];
    for (const raw of asArray(result.value.data)) {
      const isPull = field(raw, "pull_request") !== undefined;
      if (isPull !== (query.kind === "pull")) continue;
      if (!isPull) {
        items.push(toIssue(raw));
        continue;
      }
      const number = asNumber(field(raw, "number"));
      const hydrated = await this.getPull(named.owner, named.name, number);
      // A pull that vanished between the two calls is simply skipped; the
      // next sync will see it (or not) with a consistent view.
      if (hydrated.ok) items.push(hydrated.value);
      else if (hydrated.error.error === "rate_limited") return hydrated;
    }
    return succeed({
      items,
      next: linkNext(result.value.headers) ? String(page + 1) : null,
    });
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
    if (field(result.value.data, "pull_request") !== undefined)
      return this.getPull(named.owner, named.name, number);
    return succeed(toIssue(result.value.data));
  }

  /**
   * GitHub's search is one global endpoint with the scope expressed inside
   * the query string, so the account's login is appended as `user:<login>`
   * — without it the search is the whole of GitHub, which is neither what
   * a palette means nor something we should spend an origin's rate budget on.
   */
  async searchIssues(
    query: string,
    limit = 30,
  ): Promise<ProviderResult<readonly RemoteIssue[]>> {
    const text = query.trim();
    if (text === "") return succeed([]);
    const login = await this.loginName();
    const result = await this.api.call({
      path: "/search/issues",
      query: {
        q: login === "" ? text : `${text} user:${login}`,
        per_page: Math.min(Math.max(limit, 1), PER_PAGE),
        sort: "updated",
        order: "desc",
      },
    });
    if (!result.ok) return result;
    const items = asArray(field(result.value.data, "items")).map((raw) => {
      const issue = toIssue(raw);
      const repo = repoFromApiUrl(asString(field(raw, "repository_url")));
      return repo === "" ? issue : { ...issue, repo };
    });
    return succeed(items);
  }

  /** The account's own login, learned once. */
  private async loginName(): Promise<string> {
    if (this.login !== undefined) return this.login;
    const who = await this.whoami();
    this.login = who.ok ? who.value.login : "";
    return this.login;
  }

  private async getPull(
    owner: string,
    name: string,
    number: number,
  ): Promise<ProviderResult<RemoteIssue>> {
    const result = await this.api.call({
      path: `/repos/${seg(owner)}/${seg(name)}/pulls/${number}`,
    });
    if (!result.ok) return result;
    return succeed(toPull(result.value.data));
  }

  async listComments(
    fullName: string,
    number: number,
    since?: string,
  ): Promise<ProviderResult<readonly RemoteComment[]>> {
    const named = splitFullName(fullName);
    if (!named) return fail("not_found", `not a repository name: ${fullName}`);
    const comments: RemoteComment[] = [];
    for (let page = 1; page <= MAX_INTERNAL_PAGES; page++) {
      const result = await this.api.call({
        path: `/repos/${seg(named.owner)}/${seg(named.name)}/issues/${number}/comments`,
        query: {
          per_page: PER_PAGE,
          page,
          ...(since === undefined ? {} : { since }),
        },
      });
      if (!result.ok) return result;
      const batch = asArray(result.value.data);
      for (const raw of batch) comments.push(toComment(raw));
      if (batch.length < PER_PAGE) break;
    }
    return succeed(comments);
  }

  async listReviews(
    fullName: string,
    number: number,
  ): Promise<ProviderResult<readonly RemoteReview[]>> {
    const named = splitFullName(fullName);
    if (!named) return fail("not_found", `not a repository name: ${fullName}`);
    const reviews: RemoteReview[] = [];
    for (let page = 1; page <= MAX_INTERNAL_PAGES; page++) {
      const result = await this.api.call({
        path: `/repos/${seg(named.owner)}/${seg(named.name)}/pulls/${number}/comments`,
        query: { per_page: PER_PAGE, page },
      });
      if (!result.ok) return result;
      const batch = asArray(result.value.data);
      for (const raw of batch) reviews.push(toReview(raw));
      if (batch.length < PER_PAGE) break;
    }
    return succeed(reviews);
  }

  /**
   * The verdicts, from the endpoint GitHub calls `/reviews` (its `/comments`
   * sibling is the line comments `listReviews` walks). `DISMISSED` and
   * `PENDING` are not verdicts and are dropped rather than mapped to one.
   */
  async listReviewStates(
    fullName: string,
    number: number,
  ): Promise<ProviderResult<readonly RemoteReviewState[]>> {
    const named = splitFullName(fullName);
    if (!named) return fail("not_found", `not a repository name: ${fullName}`);
    const states: RemoteReviewState[] = [];
    for (let page = 1; page <= MAX_INTERNAL_PAGES; page++) {
      const result = await this.api.call({
        path: `/repos/${seg(named.owner)}/${seg(named.name)}/pulls/${number}/reviews`,
        query: { per_page: PER_PAGE, page },
      });
      if (!result.ok) return result;
      const batch = asArray(result.value.data);
      for (const raw of batch) {
        const state = toReviewState(raw);
        if (state !== undefined) states.push(state);
      }
      if (batch.length < PER_PAGE) break;
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
    // GitHub's verb vocabulary, which is not its own noun vocabulary:
    // it accepts APPROVE and answers APPROVED.
    const event =
      input.state === "approved"
        ? "APPROVE"
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
      body: {
        title: input.title,
        body: input.body,
        ...(input.labels === undefined ? {} : { labels: [...input.labels] }),
      },
    });
    if (!result.ok) return result;
    return succeed(toIssue(result.value.data));
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
    const result = await this.api.call({
      path: `/repos/${seg(named.owner)}/${seg(named.name)}/issues/${number}`,
      method: "PATCH",
      body: { state },
    });
    if (!result.ok) return result;
    if (field(result.value.data, "pull_request") !== undefined)
      return this.getPull(named.owner, named.name, number);
    return succeed(toIssue(result.value.data));
  }

  async setLabels(
    fullName: string,
    number: number,
    labels: readonly string[],
  ): Promise<ProviderResult<readonly RemoteLabel[]>> {
    const named = splitFullName(fullName);
    if (!named) return fail("not_found", `not a repository name: ${fullName}`);
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

    const forks: RemoteRepo[] = [];
    for (let page = 1; page <= MAX_INTERNAL_PAGES; page++) {
      const result = await this.api.call({
        path: `/repos/${seg(named.owner)}/${seg(named.name)}/forks`,
        query: { per_page: PER_PAGE, page },
      });
      if (!result.ok) return result;
      const rows = asArray(result.value.data);
      forks.push(...rows.map((r) => toRepo(r)));
      if (!linkNext(result.value.headers)) break;
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
   * GitHub ignores the username when the password is a valid token;
   * `x-access-token` is the convention its own docs use, and it works for
   * classic PATs, fine-grained PATs and App installation tokens alike.
   */
  async gitAuthEnv(remoteUrl: string): Promise<Record<string, string>> {
    const token = await this.credential.token();
    if (!token.ok) return {};
    return gitAuthEnv(remoteUrl, basicHeader("x-access-token", token.value));
  }
}

// ---- mapping ----

const pageOf = (cursor: string | undefined): number => {
  const n = Number(cursor);
  return Number.isInteger(n) && n > 0 ? n : 1;
};

/**
 * `owner/name` out of an API repository URL. Search results name the repo
 * only this way — `https://api.github.com/repos/octo/gears` — and the last
 * two segments are the answer wherever the API is hosted (github.com,
 * Enterprise at /api/v3, anything else).
 */
function repoFromApiUrl(url: string): string {
  const parts = url.split("/").filter((p) => p !== "");
  if (parts.length < 2) return "";
  const name = parts[parts.length - 1] ?? "";
  const owner = parts[parts.length - 2] ?? "";
  return owner === "" || name === "" ? "" : `${owner}/${name}`;
}

/** GitHub's `source` — the root of the fork network — when it is not the parent. */
function rootOf(raw: unknown): { root?: string } {
  const root = asString(dig(raw, "source", "full_name"));
  return root === "" || root === asString(dig(raw, "parent", "full_name"))
    ? {}
    : { root };
}

function toRepo(raw: unknown): RemoteRepo {
  const fullName = asString(field(raw, "full_name"));
  const named = splitFullName(fullName);
  return {
    remoteId: asId(field(raw, "id")),
    fullName,
    owner: named?.owner ?? asString(dig(raw, "owner", "login")),
    name: named?.name ?? asString(field(raw, "name")),
    description: asString(field(raw, "description")),
    private: asBool(field(raw, "private")),
    fork: asBool(field(raw, "fork")),
    parent: asString(dig(raw, "parent", "full_name")) || null,
    ...rootOf(raw),
    defaultBranch: asString(field(raw, "default_branch")) || "main",
    cloneUrl: asString(field(raw, "clone_url")),
    sshUrl: asString(field(raw, "ssh_url")),
    htmlUrl: asString(field(raw, "html_url")),
    pushedAt: asTime(field(raw, "pushed_at")),
    permissions: {
      push: asBool(dig(raw, "permissions", "push")),
      admin: asBool(dig(raw, "permissions", "admin")),
    },
    // GitHub counts issues and pull requests together here and offers no
    // second number; the flag records that rather than pretending.
    openIssues: asNumber(field(raw, "open_issues_count")),
    openPulls: 0,
    openIssuesIncludesPulls: true,
    sizeKb: asNumber(field(raw, "size")),
  };
}

/**
 * One verdict, or `undefined` when the row is not one. `PENDING` is a draft
 * the author has not submitted and `DISMISSED` is one somebody took back;
 * counting either as a verdict is how a merge gate lets through a change
 * nobody approved.
 */
function toReviewState(raw: unknown): RemoteReviewState | undefined {
  const word = asString(field(raw, "state")).toUpperCase();
  const state =
    word === "APPROVED"
      ? ("approved" as const)
      : word === "CHANGES_REQUESTED" || word === "REQUEST_CHANGES"
        ? ("changes_requested" as const)
        : word === "COMMENTED" || word === "COMMENT"
          ? ("commented" as const)
          : undefined;
  if (state === undefined) return undefined;
  return {
    remoteId: asId(field(raw, "id")),
    author: asString(dig(raw, "user", "login")),
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

function toIssue(raw: unknown): RemoteIssue {
  const milestone = asNumber(dig(raw, "milestone", "number"));
  return {
    ...(milestone > 0 ? { milestone } : {}),
    remoteId: asId(field(raw, "id")),
    number: asNumber(field(raw, "number")),
    title: asString(field(raw, "title")),
    body: asString(field(raw, "body")),
    author: asString(dig(raw, "user", "login")),
    state: asState(field(raw, "state")),
    labels: labelNames(field(raw, "labels")),
    createdAt: asTime(field(raw, "created_at")) ?? new Date().toISOString(),
    updatedAt:
      asTime(field(raw, "updated_at")) ??
      asTime(field(raw, "created_at")) ??
      new Date().toISOString(),
    closedAt: asTime(field(raw, "closed_at")),
    htmlUrl: asString(field(raw, "html_url")),
    comments: asNumber(field(raw, "comments")),
  };
}

function toPull(raw: unknown): RemoteIssue {
  const base = asString(dig(raw, "base", "ref"));
  const head = asString(dig(raw, "head", "ref"));
  const headRepo =
    asString(dig(raw, "head", "repo", "full_name")) ||
    asString(dig(raw, "base", "repo", "full_name"));
  return {
    ...toIssue(raw),
    pull: {
      baseBranch: base,
      headBranch: head,
      headRepo,
      baseOid: asString(dig(raw, "base", "sha")),
      headOid: asString(dig(raw, "head", "sha")),
      mergedAt: asTime(field(raw, "merged_at")),
      draft: asBool(field(raw, "draft")),
    },
  };
}

function toComment(raw: unknown): RemoteComment {
  const created = asTime(field(raw, "created_at")) ?? new Date().toISOString();
  return {
    remoteId: asId(field(raw, "id")),
    author: asString(dig(raw, "user", "login")),
    body: asString(field(raw, "body")),
    createdAt: created,
    updatedAt: asTime(field(raw, "updated_at")) ?? created,
    htmlUrl: asString(field(raw, "html_url")),
  };
}

function toReview(raw: unknown): RemoteReview {
  // GitHub states the anchor outright; `original_line` is where it was made
  // when the line has since moved, and the hunk is the last resort.
  const stated =
    asNumber(field(raw, "line")) || asNumber(field(raw, "original_line"));
  const side =
    asString(field(raw, "side")).toUpperCase() === "LEFT"
      ? ("old" as const)
      : ("new" as const);
  const fromHunk = anchorFromHunk(asString(field(raw, "diff_hunk")));
  return {
    remoteId: asId(field(raw, "id")),
    author: asString(dig(raw, "user", "login")),
    body: asString(field(raw, "body")),
    path: asString(field(raw, "path")),
    line: stated > 0 ? stated : fromHunk.line,
    side: stated > 0 ? side : fromHunk.side,
    createdAt: asTime(field(raw, "created_at")) ?? new Date().toISOString(),
    htmlUrl: asString(field(raw, "html_url")),
  };
}
