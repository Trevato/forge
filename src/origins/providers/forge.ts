/**
 * Another forge as an origin (`docs/features/forge-origin.md`).
 *
 * A forge answers the Gitea dialect only for the one list connecting needs,
 * `GET /user/repos`; who you are and one repository are read in its own
 * shape, so the rest of its API grows no Gitea fields. Git comes over HTTPS
 * as ever. Issues, pulls and comments are read and written in its own JSON
 * (`forge-work.ts`); labels do not come yet and say "none" rather than
 * failing, and the origin's `carries` note says so.
 */

import type {
  ListIssuesQuery,
  Page,
  RemoteCheck,
  RemoteComment,
  ProviderResult,
  RemoteIdentity,
  RemoteLabel,
  RemoteMilestone,
  RemoteIssue,
  RemoteRepo,
  RemoteReviewState,
} from "../types.ts";
import { ForgejoProvider, nextPage, toRepo } from "./forgejo.ts";
import { NO_ACCOUNT } from "../words.ts";
import { forgeCursor, toForgeComment, toForgeWork } from "./forge-work.ts";
import { asArray, asId, asString, asTime, dig, fail, field, seg, splitFullName, succeed } from "./http.ts";

const MAX_COMMENT_PAGES = 1000;
const OLDER_PAGES = 10;
const NONE = { ok: true, value: [] } as const;

export class ForgeProvider extends ForgejoProvider {
  /** The account is `username` on a forge, not Gitea's `login`. */
  override async whoami(): Promise<ProviderResult<RemoteIdentity>> {
    const result = await this.api.call({ path: "/user" });
    if (!result.ok) return result;
    const login = asString(field(result.value.data, "username"));
    if (login === "") return fail("invalid_response", NO_ACCOUNT);
    return succeed({
      login,
      displayName: asString(field(result.value.data, "displayName")) || login,
      htmlUrl: `${this.webUrl}/${login}`,
      // `isAdmin` on a forge's own `/user`: the guard refuses such an account.
      siteAdmin: field(result.value.data, "isAdmin") === true,
    });
  }

  /** The caller's own repositories, in the shape `/user/repos` answers. */
  override async listRepos(cursor?: string): Promise<ProviderResult<Page<RemoteRepo>>> {
    const page = Math.max(1, Number(cursor) || 1);
    const limit = await this.pageSize();
    const result = await this.api.call({ path: "/user/repos", query: { limit, page } });
    // A forge from before `/user/repos` (0.5.x) has no such route.
    if (!result.ok && result.error.error === "not_found") return this.listReposOlder(cursor, limit);
    if (!result.ok) return result;
    const rows = asArray(result.value.data);
    return succeed({
      items: rows.map(toRepo),
      next: nextPage(result.value.headers, rows.length, limit, page),
    });
  }

  /**
   * An old forge's list: `GET /repos` pages by cursor and shows everything the
   * token may see, so the account's own repositories are picked out of it. A
   * cursor here is the forge's `next_cursor`, not a page number. At most
   * `OLDER_PAGES` pages are read for one call, so a huge forge costs a bounded
   * walk; the rest is one "next" away.
   */
  private async listReposOlder(
    cursor: string | undefined,
    limit: number,
  ): Promise<ProviderResult<Page<RemoteRepo>>> {
    const me = await this.whoami();
    if (!me.ok) return me;
    const own: RemoteRepo[] = [];
    let after = cursor !== undefined && /^[A-Za-z0-9_-]{1,64}$/.test(cursor) ? cursor : undefined;
    for (let walked = 0; walked < OLDER_PAGES; walked++) {
      const result = await this.api.call({
        path: "/repos",
        query: { limit: 100, ...(after === undefined ? {} : { cursor: after }) },
      });
      if (!result.ok) return result;
      for (const raw of asArray(field(result.value.data, "items")))
        if (asString(field(raw, "ownerName")).toLowerCase() === me.value.login.toLowerCase())
          own.push(this.repoFrom(raw, undefined));
      const next = field(result.value.data, "next_cursor");
      after = typeof next === "string" || typeof next === "number" ? String(next) : undefined;
      if (after === undefined || own.length >= limit) break;
    }
    return succeed({ items: own, next: after ?? null });
  }

  /** A repository from a forge's own JSON (`ownerName`, `visibility`). */
  private repoFrom(raw: unknown, named: { owner: string; name: string } | undefined): RemoteRepo {
    const owner = asString(field(raw, "ownerName")) || named?.owner || "";
    const name = asString(field(raw, "name")) || named?.name || "";
    const web = `${this.webUrl}/${owner}/${name}`;
    return (
      toRepo({
        id: field(raw, "id"),
        full_name: `${owner}/${name}`,
        name,
        owner: { login: owner },
        description: field(raw, "description"),
        private: asString(field(raw, "visibility")) !== "public",
        fork: dig(raw, "forkParentId") !== null && dig(raw, "forkParentId") !== undefined,
        default_branch: field(raw, "defaultBranch"),
        clone_url: `${web}.git`,
        html_url: web,
        // A forge's repository JSON carries no rights. Unknown is not
        // "cannot push": the direct way is tried, and its refusal falls
        // back to the account's own fork.
        permissions: { push: true, admin: false },
      })
    );
  }

  /** One repository, from a forge's own JSON. */
  override async getRepo(fullName: string): Promise<ProviderResult<RemoteRepo>> {
    const named = splitFullName(fullName);
    if (!named) return fail("not_found", `not a repository name: ${fullName}`);
    const result = await this.api.call({
      path: `/repos/${seg(named.owner)}/${seg(named.name)}`,
    });
    if (!result.ok) return result;
    return succeed(this.repoFrom(result.value.data, named));
  }

  override listLabels(): Promise<ProviderResult<readonly RemoteLabel[]>> {
    return Promise.resolve(NONE);
  }

  /** Implements the optional `Provider.listMilestones`; Forgejo has none to override. */
  listMilestones(): Promise<ProviderResult<readonly RemoteMilestone[]>> {
    return Promise.resolve(NONE);
  }

  private repoPath(fullName: string): string | undefined {
    const named = splitFullName(fullName);
    return named ? `/repos/${seg(named.owner)}/${seg(named.name)}` : undefined;
  }

  /** Issues or pulls, newest first, a page at a time. */
  override async listIssues(
    fullName: string,
    query: ListIssuesQuery,
  ): Promise<ProviderResult<Page<RemoteIssue>>> {
    const base = this.repoPath(fullName);
    if (base === undefined) return fail("not_found", `not a repository name: ${fullName}`);
    const limit = await this.pageSize();
    const result = await this.api.call({
      path: `${base}/${query.kind === "pull" ? "pulls" : "issues"}`,
      query: {
        state: query.state,
        limit,
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      },
    });
    if (!result.ok) return result;
    const rows = asArray(field(result.value.data, "items")).filter(
      (raw) => raw !== null && typeof raw === "object",
    );
    const items = rows
      .map((raw) => toForgeWork(raw, this.webUrl, fullName))
      .filter((i) => query.since === undefined || i.updatedAt >= query.since);
    return succeed({ items, next: forgeCursor(result.value.data) });
  }

  override async getIssue(fullName: string, number: number): Promise<ProviderResult<RemoteIssue>> {
    const base = this.repoPath(fullName);
    if (base === undefined) return fail("not_found", `not a repository name: ${fullName}`);
    let result = await this.api.call({ path: `${base}/issues/${number}` });
    // A pull answers at `/issues` too, but only `/pulls` carries its branches and merge.
    if (result.ok && asString(field(result.value.data, "kind")) === "pull")
      result = await this.api.call({ path: `${base}/pulls/${number}`, query: { diff: 0 } });
    if (!result.ok) return result;
    return succeed(toForgeWork(result.value.data, this.webUrl, fullName));
  }

  /** The pull's own `check` word, as the forge says it of the head it names. */
  override async getPullCheck(fullName: string, number: number): Promise<ProviderResult<RemoteCheck>> {
    const base = this.repoPath(fullName);
    if (base === undefined) return fail("not_found", `not a repository name: ${fullName}`);
    const result = await this.api.call({ path: `${base}/pulls/${number}`, query: { diff: 0 } });
    if (!result.ok) return result;
    const word = asString(field(result.value.data, "check"));
    return succeed({
      word: word === "green" || word === "red" || word === "running" ? word : "none",
      headOid: asString(field(result.value.data, "headOid")),
    });
  }

  /** The verdicts, from the forge's own `review-states` (a forge has no Gitea review objects). */
  override async listReviewStates(
    fullName: string,
    number: number,
  ): Promise<ProviderResult<readonly RemoteReviewState[]>> {
    const base = this.repoPath(fullName);
    if (base === undefined) return fail("not_found", `not a repository name: ${fullName}`);
    const result = await this.api.call({ path: `${base}/pulls/${number}/review-states` });
    if (!result.ok) return result;
    const states: RemoteReviewState[] = [];
    for (const raw of asArray(result.value.data)) {
      const state = asString(field(raw, "state"));
      if (state !== "approved" && state !== "changes_requested" && state !== "commented") continue;
      const created = asTime(field(raw, "createdAt")) ?? new Date().toISOString();
      states.push({
        remoteId: asId(field(raw, "id")),
        author: asString(field(raw, "originAuthor")) || asString(field(raw, "authorName")),
        state,
        body: asString(field(raw, "body")),
        commitOid: asString(field(raw, "commitOid")),
        createdAt: created,
        htmlUrl: `${this.webUrl}/${fullName}/pulls/${number}`,
      });
    }
    return succeed(states);
  }

  override async watch(fullName: string, hook: { url: string; secret: string }): Promise<ProviderResult<void>> {
    const base = this.repoPath(fullName);
    if (base === undefined) return fail("not_found", `not a repository name: ${fullName}`);
    const listed = await this.api.call({ path: `${base}/hooks` });
    if (!listed.ok) return listed;
    const rows = asArray(field(listed.value.data, "items") ?? listed.value.data);
    if (rows.some((row) => asString(field(row, "url")) === hook.url)) return succeed(undefined);
    const made = await this.api.call({
      path: `${base}/hooks`,
      method: "POST",
      body: { url: hook.url, secret: hook.secret, kinds: "*" },
    });
    return made.ok ? succeed(undefined) : made;
  }

  override async listComments(
    fullName: string,
    number: number,
    since?: string,
  ): Promise<ProviderResult<readonly RemoteComment[]>> {
    const base = this.repoPath(fullName);
    if (base === undefined) return fail("not_found", `not a repository name: ${fullName}`);
    const comments: RemoteComment[] = [];
    let after: string | undefined;
    // A thread comes oldest first, `next` the id to continue after. Paging
    // stops at the end of the thread; a thread that never ends is a failure,
    // not a short list.
    for (let page = 0; ; page++) {
      if (page >= MAX_COMMENT_PAGES)
        return fail("invalid_response", `thread ${number} has more than ${MAX_COMMENT_PAGES * 100} comments`);
      const result = await this.api.call({
        path: `${base}/issues/${number}/comments`,
        query: { limit: 100, ...(after === undefined ? {} : { after }) },
      });
      if (!result.ok) return result;
      for (const raw of asArray(field(result.value.data, "comments")))
        comments.push(toForgeComment(raw, this.webUrl, fullName, number));
      after = forgeCursor(result.value.data) ?? undefined;
      if (after === undefined) break;
    }
    return succeed(since === undefined ? comments : comments.filter((c) => c.updatedAt >= since));
  }

  override async createIssue(
    fullName: string,
    input: { title: string; body: string; labels?: readonly string[] },
  ): Promise<ProviderResult<RemoteIssue>> {
    const base = this.repoPath(fullName);
    if (base === undefined) return fail("not_found", `not a repository name: ${fullName}`);
    const result = await this.api.call({
      path: `${base}/issues`,
      method: "POST",
      body: { title: input.title, body: input.body },
    });
    if (!result.ok) return result;
    return succeed(toForgeWork(result.value.data, this.webUrl, fullName));
  }

  override async createComment(
    fullName: string,
    number: number,
    body: string,
  ): Promise<ProviderResult<RemoteComment>> {
    const base = this.repoPath(fullName);
    if (base === undefined) return fail("not_found", `not a repository name: ${fullName}`);
    const result = await this.api.call({
      path: `${base}/issues/${number}/comments`,
      method: "POST",
      body: { body },
    });
    if (!result.ok) return result;
    return succeed(toForgeComment(result.value.data, this.webUrl, fullName, number));
  }

  override async createPull(
    fullName: string,
    input: { title: string; body: string; base: string; head: string },
  ): Promise<ProviderResult<RemoteIssue>> {
    const named = splitFullName(fullName);
    if (!named) return fail("not_found", `not a repository name: ${fullName}`);
    const path = `/repos/${seg(named.owner)}/${seg(named.name)}`;
    // A fork's branch is `owner:branch`; a forge names it as head plus headRepo.
    const parts = input.head.split(":");
    if (parts.length > 2 || parts.some((p) => p === ""))
      return fail("not_found", `not a branch: ${input.head}`);
    const [owner, branch] = parts.length === 2 ? parts : [undefined, parts[0]];
    const name = named.name;
    const result = await this.api.call({
      path: `${path}/pulls`,
      method: "POST",
      body: {
        title: input.title,
        body: input.body,
        base: input.base,
        head: branch,
        ...(owner === undefined ? {} : { headRepo: `${owner}/${name}` }),
      },
    });
    if (!result.ok) return result;
    return succeed(toForgeWork(result.value.data, this.webUrl, fullName));
  }

  override async setState(
    fullName: string,
    number: number,
    state: "open" | "closed",
  ): Promise<ProviderResult<RemoteIssue>> {
    const base = this.repoPath(fullName);
    if (base === undefined) return fail("not_found", `not a repository name: ${fullName}`);
    const result = await this.api.call({
      path: `${base}/issues/${number}`,
      method: "PATCH",
      body: { state },
    });
    if (!result.ok) return result;
    return succeed(toForgeWork(result.value.data, this.webUrl, fullName));
  }
}
