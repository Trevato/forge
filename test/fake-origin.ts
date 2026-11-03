/**
 * Fake forges, for testing the adapters against something that behaves like
 * the real thing rather than against a mock of our own beliefs.
 *
 * Each fake speaks one dialect for real: GitHub returns pull requests inside
 * `/issues` with a `pull_request` key and paginates with a `Link` header;
 * Forgejo splits them with `type=`, clamps `limit` to its own
 * `max_response_items`, and answers `/api/v1/version` with the `+gitea-`
 * suffix that identifies it. Both can be told to rate-limit, to answer 304
 * to a conditional request, and to refuse a write — because those are the
 * paths that are wrong in production and untested everywhere else.
 *
 * Not a test file: `bun test` only collects `*.test.ts`.
 */

import { createHash } from "node:crypto";
import { settled, type MirrorJob } from "../src/origins/jobs.ts";

/**
 * `POST …/mirror` answers 202 with a job, because mirroring is a clone and
 * an import and neither fits in a request. A test that needs the repository
 * rather than the progress hands the response here and waits for the job to
 * stop moving.
 */
export async function mirrorAndWait(
  response: Response,
): Promise<MirrorJob | undefined> {
  if (response.status !== 202) return undefined;
  const body = (await response.json()) as { job?: { id?: string } };
  const jobId = body.job?.id;
  return jobId === undefined ? undefined : settled(jobId);
}

export type FakeKind = "github" | "forgejo" | "gitea";

export interface FakeRepo {
  id: number;
  fullName: string;
  /** Names it answered to before a rename; a real forge redirects them. */
  formerNames?: string[];
  description?: string;
  private?: boolean;
  fork?: boolean;
  /** `owner/name` this repo forks, as `getRepo` reports it. */
  parent?: string;
  /** `owner/name` of the network's root: GitHub's `source`, not sent by Forgejo. */
  root?: string;
  defaultBranch?: string;
  cloneUrl: string;
  htmlUrl?: string;
  pushedAt?: string;
  push?: boolean;
  admin?: boolean;
  /** GitHub reports issues+pulls here; Forgejo reports issues alone. */
  openIssues?: number;
  /** Forgejo only — GitHub has no separate pull counter. */
  openPulls?: number;
  /** KiB, as both forges report `size`. */
  sizeKb?: number;
  /** Set by a successful `PATCH` with `archived: true`. */
  archived?: boolean;
}

export interface FakeIssue {
  id: number;
  number: number;
  title: string;
  body?: string;
  user: string;
  state?: "open" | "closed";
  labels?: string[];
  createdAt?: string;
  updatedAt?: string;
  closedAt?: string | null;
  /** What the listing says `comments` is; the thread itself is `comments`. */
  commentCount?: number;
  /** GitHub: the number of the milestone it belongs to. */
  milestone?: number;
  /** Present for a pull request. */
  pull?: {
    base: string;
    head: string;
    headRepo?: string;
    baseSha?: string;
    headSha?: string;
    mergedAt?: string | null;
    draft?: boolean;
  };
}

export interface FakeComment {
  id: number;
  issueNumber: number;
  body: string;
  user: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface FakeReview {
  id: number;
  issueNumber: number;
  body: string;
  user: string;
  path: string;
  diffHunk: string;
  /** GitHub states these outright; Forgejo does not. */
  line?: number;
  side?: "LEFT" | "RIGHT";
}

/**
 * A verdict on a pull. Distinct from `FakeReview`, which is one line
 * comment — both forges model reviews as a state with comments under it, and
 * an adapter that conflates them counts comments as approvals.
 */
export interface FakeReviewState {
  id: number;
  issueNumber: number;
  user: string;
  /** The forge's own word: APPROVED / CHANGES_REQUESTED / REQUEST_CHANGES / … */
  state: string;
  body?: string;
  commitId?: string;
  submittedAt?: string;
}

export interface FakeLabel {
  id: number;
  name: string;
  color: string;
}

export interface FakeMilestone {
  number: number;
  title: string;
  description?: string;
  /** ISO 8601, or absent for no due date. */
  dueOn?: string;
  state?: "open" | "closed";
}

export interface FakeBranch {
  name: string;
  sha: string;
  protected?: boolean;
}

export interface FakeCommit {
  sha: string;
  message: string;
  authorName: string;
  authorEmail?: string;
  /** The account on the origin, when the commit is attributed to one. */
  login?: string;
  date: string;
  parents?: string[];
  /** The unified diff `…/commits/{sha}` serves behind the diff media type. */
  diff?: string;
}

export interface RecordedRequest {
  method: string;
  path: string;
  query: string;
  authorization: string;
  body: string;
}

export interface FakeState {
  kind: FakeKind;
  login: string;
  /** The token the fake accepts; anything else is a 401. */
  token: string;
  repos: FakeRepo[];
  labels: Map<string, FakeLabel[]>;
  /** GitHub milestones, keyed `owner/name`. */
  milestones: Map<string, FakeMilestone[]>;
  issues: Map<string, FakeIssue[]>;
  comments: Map<string, FakeComment[]>;
  reviews: Map<string, FakeReview[]>;
  /** Verdicts, keyed `owner/name`. */
  reviewStates: Map<string, FakeReviewState[]>;
  /** The git side of a repo, for the browse endpoints: refs, files, log. */
  branches: Map<string, FakeBranch[]>;
  tags: Map<string, FakeBranch[]>;
  /** path → contents. One flat map per repo; directories are derived. */
  files: Map<string, Map<string, string>>;
  commits: Map<string, FakeCommit[]>;
  /** A pull's diff, keyed `owner/name#number`. */
  pullDiffs: Map<string, string>;
  requests: RecordedRequest[];
  /** Answer the next N requests with a rate-limit refusal. */
  rateLimitFor: number;
  /** Forgejo's own ceiling on `limit`, silently applied. */
  maxResponseItems: number;
  /** Serve 304 to a conditional request whose ETag matches. */
  etagsEnabled: boolean;
  conditionalHits: number;
  /** Refuse the next write with this message. */
  refuseWrite: string;
  /** Forgejo webhooks as created, keyed `owner/name`. */
  hooks: Map<string, Record<string, unknown>[]>;
  /**
   * How many `getRepo` calls a freshly forked repository 404s for before it
   * appears. GitHub creates a fork asynchronously and answers 202 with a
   * repository that is not there yet; a fake that materialises it instantly
   * would never exercise the poll that makes the real thing work.
   */
  forkDelayReads: number;
  /** Internal: remaining 404s per pending fork, keyed `owner/name`. */
  pendingForks: Map<string, number>;
  /** Refuse the next fork with this message (Forgejo 409s an existing one). */
  refuseFork: string;
  /** Hold every issue-search answer this long before sending it. */
  searchDelayMs: number;
  /** When set, the labels list waits for it: a test pins a mirror mid-flight. */
  holdLabels?: Promise<void> | undefined;
  nextId: number;
  /** The OAuth endpoints, when a test wants the connect flows. */
  oauth?: FakeOAuth;
  /**
   * GitHub's `X-OAuth-Scopes` on every answer, as a classic token sends it;
   * unset, the fake is a fine-grained token, which names none.
   */
  scopes?: string;
  /**
   * A scope the token lacks for `/user` (`read:user`): answered as Forgejo
   * answers it, a 403 that names the scope.
   */
  userScopeMissing?: string;
  /** The account administers the instance: `is_admin` / `site_admin` on `/user`. */
  siteAdmin?: boolean;
  /** Called before each page of a repository listing is answered: the world moving mid-walk. */
  onRepoPage?: (page: number) => void;
  /** What `X-Total-Count` says on a repository listing, when it should lie. */
  repoTotalOverride?: number;
  /** Repositories (`owner/name`) whose `GET /repos/{o}/{r}` answers 500. */
  failRepos?: Set<string>;
}

export interface FakeForge {
  readonly url: string;
  readonly state: FakeState;
  /** `/api/v1` or the GitHub API root — what discovery should land on. */
  readonly apiUrl: string;
  stop(): void;
}

export function newFakeState(
  kind: FakeKind,
  login: string,
  token: string,
): FakeState {
  return {
    kind,
    login,
    token,
    repos: [],
    labels: new Map(),
    milestones: new Map(),
    issues: new Map(),
    comments: new Map(),
    reviews: new Map(),
    reviewStates: new Map(),
    branches: new Map(),
    tags: new Map(),
    files: new Map(),
    commits: new Map(),
    pullDiffs: new Map(),
    requests: [],
    rateLimitFor: 0,
    maxResponseItems: 50,
    etagsEnabled: false,
    conditionalHits: 0,
    refuseWrite: "",
    hooks: new Map(),
    forkDelayReads: 0,
    pendingForks: new Map(),
    refuseFork: "",
    searchDelayMs: 0,
    nextId: 1000,
  };
}

const jsonResponse = (
  data: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

/** Boot a fake forge. The returned `state` is live: mutate it mid-test. */
export function serveFakeForge(state: FakeState): FakeForge {
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const bodyText =
        request.method === "GET" || request.method === "HEAD"
          ? ""
          : await request.text();
      state.requests.push({
        method: request.method,
        path: url.pathname,
        query: url.search,
        authorization: request.headers.get("authorization") ?? "",
        body: bodyText,
      });

      if (
        state.holdLabels !== undefined &&
        request.method === "GET" &&
        url.pathname.endsWith("/labels")
      )
        await state.holdLabels;

      // The OAuth endpoints hang off the web origin and take no bearer
      // token, so they are answered before the API's auth check.
      if (state.oauth !== undefined) {
        const answered = oauthRoute(state.oauth, request, url, bodyText);
        if (answered) return answered;
      }

      if (state.rateLimitFor > 0) {
        state.rateLimitFor--;
        // GitHub's shape: a 403 with the budget spent, not a 429.
        return new Response("rate limited", {
          status: 403,
          headers: {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
          },
        });
      }

      const base = state.kind === "github" ? "" : "/api/v1";
      const path = url.pathname;

      // Discovery: only the Forgejo/Gitea family answers this.
      if (path === "/api/v1/version") {
        if (state.kind === "github")
          return new Response("nope", { status: 404 });
        return jsonResponse({
          version:
            state.kind === "forgejo" ? "16.0.1+gitea-1.22.0" : "1.27.0+dev-954",
        });
      }
      // Every live instance 404s this, and so do we.
      if (path === "/.well-known/nodeinfo")
        return new Response("Not Found", { status: 404 });

      // GitHub Enterprise hangs the same API off /api/v3; a fake that only
      // answers at the root would never exercise that path.
      const rest =
        base === ""
          ? path.startsWith("/api/v3")
            ? path.slice("/api/v3".length)
            : path
          : path.startsWith(base)
            ? path.slice(base.length)
            : "";
      if (rest === "") return new Response("no route", { status: 404 });

      const auth = request.headers.get("authorization") ?? "";
      if (!authorized(state, auth))
        return jsonResponse({ message: "Bad credentials" }, 401);

      return route(state, request, url, rest, bodyText);
    },
  });
  const url = `http://localhost:${server.port}`;
  // Every clone URL the fixture registered is relative to the *git* host the
  // test provided, so nothing here rewrites them.
  return {
    url,
    apiUrl: state.kind === "github" ? url : `${url}/api/v1`,
    state,
    stop: () => server.stop(true),
  };
}

function authorized(state: FakeState, header: string): boolean {
  const accepted = [state.token];
  // An OAuth access token is a credential for this instance too, and it is
  // whatever the token endpoint last issued.
  if (state.oauth !== undefined) accepted.push(state.oauth.accessToken);
  for (const token of accepted) {
    if (header === `Bearer ${token}`) return true;
    if (header === `token ${token}`) return true;
    if (header.startsWith("Basic ")) {
      const decoded = Buffer.from(header.slice(6), "base64").toString();
      if (decoded.endsWith(`:${token}`)) return true;
    }
  }
  return false;
}

function route(
  state: FakeState,
  request: Request,
  url: URL,
  rest: string,
  bodyText: string,
): Response | Promise<Response> {
  const q = url.searchParams;
  const method = request.method;

  if (rest === "/settings/api")
    return jsonResponse({ max_response_items: state.maxResponseItems });

  if (rest === "/user" && state.userScopeMissing !== undefined)
    return jsonResponse(
      {
        message: `token does not have at least one of required scope(s): [${state.userScopeMissing}]`,
        url: `${url.origin}/api/swagger`,
      },
      403,
    );
  if (rest === "/user")
    return jsonResponse(
      {
        id: 7,
        login: state.login,
        full_name: state.login,
        name: state.login,
        html_url: `${url.origin}/${state.login}`,
        ...(state.kind === "github"
          ? { site_admin: state.siteAdmin === true }
          : { is_admin: state.siteAdmin === true }),
      },
      200,
      state.scopes === undefined ? {} : { "x-oauth-scopes": state.scopes },
    );

  if (rest === "/user/repos" || rest === "/repos/search") {
    // Paged as Forgejo pages: `limit` clamped to the instance's ceiling,
    // `page` from 1, and `sort` (id, or updated: most recent first) when
    // asked; with no `limit`, everything at once, as before.
    const page = Math.max(1, Number(q.get("page") ?? "1") || 1);
    state.onRepoPage?.(page);
    const visibility = q.get("visibility");
    const ordered = state.repos.filter(
      (r) =>
        visibility === null ||
        visibility === "all" ||
        (visibility === "private") === (r.private ?? false),
    );
    if (q.get("sort") === "id") ordered.sort((a, b) => a.id - b.id);
    if (q.get("sort") === "updated")
      ordered.sort((a, b) => (b.pushedAt ?? "").localeCompare(a.pushedAt ?? ""));
    const asked = Number(q.get("limit") ?? "");
    const limit =
      Number.isFinite(asked) && asked > 0
        ? Math.min(asked, state.maxResponseItems)
        : ordered.length;
    const rows = ordered
      .slice((page - 1) * limit, page * limit)
      .map((r) => repoJson(state, r));
    const payload = rest === "/repos/search" ? { ok: true, data: rows } : rows;
    return jsonResponse(payload, 200, {
      "x-total-count": String(state.repoTotalOverride ?? state.repos.length),
    });
  }

  // Cross-repo issue search. Both forges hang it off a path that *looks*
  // like a repository path (`/repos/issues/search`), which is exactly the
  // trap an adapter falls into, so it is answered before the repo matcher.
  if (
    (rest === "/search/issues" && state.kind === "github") ||
    (rest === "/repos/issues/search" && state.kind !== "github")
  ) {
    const answer = searchIssuesJson(state, url, q.get("q") ?? "", q);
    if (state.searchDelayMs <= 0) return answer;
    return new Promise<Response>((resolve) =>
      setTimeout(() => resolve(answer), state.searchDelayMs),
    );
  }

  const repoMatch = /^\/repos\/([^/]+)\/([^/]+)(.*)$/.exec(rest);
  if (!repoMatch) return new Response("no route", { status: 404 });
  const fullName = `${repoMatch[1]}/${repoMatch[2]}`;
  const tail = repoMatch[3] ?? "";
  const repo = state.repos.find(
    (r) => r.fullName === fullName || r.formerNames?.includes(fullName),
  );
  if (!repo) return jsonResponse({ message: "Not Found" }, 404);

  // A fork the origin has accepted but not finished making is a 404 for as
  // many reads as the fixture asked for. This is the real GitHub behaviour
  // and the reason `forkOrigin` polls at all.
  const pending = state.pendingForks.get(fullName) ?? 0;
  if (pending > 0) {
    state.pendingForks.set(fullName, pending - 1);
    return jsonResponse({ message: "Not Found" }, 404);
  }

  // Forgejo's webhooks: listed, and made with a `config` holding url and secret.
  if (tail === "/hooks" && state.kind !== "github") {
    const hooks = state.hooks.get(fullName) ?? [];
    if (method === "GET") return jsonResponse(hooks);
    if (method === "POST") {
      if (state.refuseWrite !== "") return refuse(state);
      const made = { id: state.nextId++, ...(parse(bodyText) as Record<string, unknown>) };
      state.hooks.set(fullName, [...hooks, made]);
      return jsonResponse(made, 201);
    }
  }

  if (tail === "" && method === "PATCH") {
    if (repo.admin === false)
      return jsonResponse({ message: "Must have admin rights to Repository." }, 403);
    if (parse(bodyText).archived === true) repo.archived = true;
    return jsonResponse(repoJson(state, repo));
  }
  if (tail === "") {
    if (state.failRepos?.has(fullName))
      return jsonResponse({ message: "internal error" }, 500);
    return jsonResponse(repoJson(state, repo));
  }

  // ---- forking ----
  if (tail === "/forks" && method === "GET") {
    const forks = state.repos.filter((r) => r.parent === fullName);
    return jsonResponse(forks.map((r) => repoJson(state, r)), 200, {
      "x-total-count": String(forks.length),
    });
  }
  if (tail === "/forks" && method === "POST") {
    if (state.refuseFork !== "")
      return jsonResponse({ message: state.refuseFork }, 409);
    // `name` is the fork's own name when given (both forges take it).
    const asked = parse(bodyText).name;
    const name = typeof asked === "string" && asked !== "" ? asked : fullName.split("/")[1]!;
    const forkName = `${state.login}/${name}`;
    const already = state.repos.find((r) => r.fullName === forkName);
    // A name the account already uses for something else: Forgejo's 409.
    if (already !== undefined && already.parent !== fullName)
      return jsonResponse({ message: "repository is already exist" }, 409);
    if (already === undefined) {
      state.repos.push({
        id: state.nextId++,
        fullName: forkName,
        fork: true,
        parent: fullName,
        defaultBranch: repo.defaultBranch ?? "main",
        // A fork's git host is the origin's, exactly as the upstream's is.
        cloneUrl: repo.cloneUrl.replace(`/${fullName}.git`, `/${forkName}.git`),
        push: true,
        admin: true,
      });
      if (state.forkDelayReads > 0)
        state.pendingForks.set(forkName, state.forkDelayReads);
    }
    const created = state.repos.find((r) => r.fullName === forkName)!;
    // 202, not 201: the repository is promised, not yet made.
    return jsonResponse(repoJson(state, created), 202);
  }

  // ---- browsing: refs, files, log, diffs ----

  if (tail === "/branches" && method === "GET") {
    return jsonResponse(
      (state.branches.get(fullName) ?? []).map((b) => ({
        name: b.name,
        // GitHub says `commit.sha`; Forgejo says `commit.id`. Each fake
        // speaks only its own dialect, so an adapter reading the wrong one
        // gets nothing rather than something that happens to work.
        commit: state.kind === "github" ? { sha: b.sha } : { id: b.sha },
        protected: b.protected ?? false,
      })),
    );
  }

  if (tail === "/tags" && method === "GET") {
    return jsonResponse(
      (state.tags.get(fullName) ?? []).map((t) => ({
        name: t.name,
        commit: state.kind === "github" ? { sha: t.sha } : { id: t.sha },
      })),
    );
  }

  if (tail === "/readme" && method === "GET") {
    // Only GitHub has one; Forgejo's adapter has to find it in the tree.
    if (state.kind !== "github")
      return new Response("no route", { status: 404 });
    const files = state.files.get(fullName) ?? new Map<string, string>();
    const path = [...files.keys()].find((p) =>
      p.toLowerCase().startsWith("readme"),
    );
    if (path === undefined) return jsonResponse({ message: "Not Found" }, 404);
    return jsonResponse(fileJson(path, files.get(path)!));
  }

  if (tail === "/contents" || tail.startsWith("/contents/")) {
    if (method !== "GET") return new Response("no route", { status: 404 });
    const path = decodeURIComponent(tail.slice("/contents".length)).replace(
      /^\//,
      "",
    );
    const files = state.files.get(fullName) ?? new Map<string, string>();
    const content = files.get(path);
    if (content !== undefined) return jsonResponse(fileJson(path, content));
    const entries = listDir(files, path);
    if (entries.length === 0 && path !== "")
      return jsonResponse({ message: "Not Found" }, 404);
    return jsonResponse(entries);
  }

  if (tail === "/commits" && method === "GET") {
    const all = state.commits.get(fullName) ?? [];
    const from = q.get("sha");
    const start =
      from === null
        ? 0
        : Math.max(
            all.findIndex((c) => c.sha === from),
            0,
          );
    const limit = Number(q.get("per_page") ?? q.get("limit") ?? 30) || 30;
    const page = Math.max(Number(q.get("page") ?? 1) || 1, 1);
    const offset = start + (page - 1) * limit;
    return jsonResponse(all.slice(offset, offset + limit).map(commitJson));
  }

  // The diff: a media type on GitHub, a `.diff` path on Forgejo.
  const commitDiff = /^\/(?:git\/)?commits\/([^/]+?)(\.diff)?$/.exec(tail);
  if (commitDiff && method === "GET") {
    const sha = decodeURIComponent(commitDiff[1]!);
    const commit = (state.commits.get(fullName) ?? []).find(
      (c) => c.sha === sha,
    );
    if (!commit) return jsonResponse({ message: "Not Found" }, 404);
    const wantsDiff =
      commitDiff[2] === ".diff" ||
      (request.headers.get("accept") ?? "").includes("diff");
    if (!wantsDiff) return jsonResponse(commitJson(commit));
    return new Response(commit.diff ?? "", {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  const pullDiff = /^\/pulls\/(\d+)\.diff$/.exec(tail);
  if (pullDiff && method === "GET") {
    const key = `${fullName}#${pullDiff[1]}`;
    const text = state.pullDiffs.get(key);
    if (text === undefined) return jsonResponse({ message: "Not Found" }, 404);
    return new Response(text, {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  // ---- labels ----
  if (tail === "/labels" && method === "GET") {
    const labels = state.labels.get(fullName) ?? [];
    if (state.etagsEnabled) {
      const etag = `"labels-${labels.length}"`;
      if (request.headers.get("if-none-match") === etag) {
        state.conditionalHits++;
        return new Response(null, { status: 304, headers: { etag } });
      }
      return jsonResponse(labels, 200, { etag });
    }
    return jsonResponse(labels);
  }

  // ---- milestones ----
  if (tail === "/milestones" && method === "GET" && state.kind === "github") {
    return jsonResponse(
      (state.milestones.get(fullName) ?? []).map((m) => ({
        number: m.number,
        title: m.title,
        description: m.description ?? null,
        due_on: m.dueOn ?? null,
        state: m.state ?? "open",
      })),
    );
  }

  // ---- issues and pulls ----
  const issues = state.issues.get(fullName) ?? [];

  if (tail === "/issues" && method === "GET") {
    const since = q.get("since");
    const wantPulls =
      state.kind === "github" ? null : q.get("type") === "pulls";
    let rows = issues.filter((i) => {
      if (wantPulls !== null && (i.pull !== undefined) !== wantPulls)
        return false;
      const stateWanted = q.get("state") ?? "open";
      if (stateWanted !== "all" && (i.state ?? "open") !== stateWanted)
        return false;
      if (since !== null && (i.updatedAt ?? "") < since) return false;
      return true;
    });
    rows = rows.sort((a, b) =>
      (a.updatedAt ?? "").localeCompare(b.updatedAt ?? ""),
    );
    // GitHub returns pulls inline here; that is the whole trap.
    return jsonResponse(rows.map((i) => issueJson(state, url, i)));
  }

  if (tail === "/issues" && method === "POST") {
    if (state.refuseWrite !== "") return refuse(state);
    const input = parse(bodyText);
    const number = nextNumber(issues);
    const created: FakeIssue = {
      id: state.nextId++,
      number,
      title: String(input.title ?? ""),
      body: String(input.body ?? ""),
      user: state.login,
      state: "open",
      labels: Array.isArray(input.labels)
        ? input.labels.filter((l): l is string => typeof l === "string")
        : [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    issues.push(created);
    state.issues.set(fullName, issues);
    return jsonResponse(issueJson(state, url, created), 201);
  }

  if (tail === "/pulls" && method === "POST") {
    if (state.refuseWrite !== "") return refuse(state);
    const input = parse(bodyText);
    const number = nextNumber(issues);
    const created: FakeIssue = {
      id: state.nextId++,
      number,
      title: String(input.title ?? ""),
      body: String(input.body ?? ""),
      user: state.login,
      state: "open",
      labels: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      pull: {
        base: String(input.base ?? "main"),
        // `owner:branch` is the cross-repository head form. Split it, so a
        // test can assert both halves arrived.
        head:
          String(input.head ?? "")
            .split(":")
            .at(-1) ?? "",
        headRepo: headRepoOf(fullName, String(input.head ?? "")),
        baseSha: "b".repeat(40),
        headSha: "c".repeat(40),
        mergedAt: null,
      },
    };
    issues.push(created);
    state.issues.set(fullName, issues);
    return jsonResponse(pullJson(state, url, created), 201);
  }

  const numbered = /^\/(issues|pulls)\/(\d+)(.*)$/.exec(tail);
  if (numbered) {
    const kind = numbered[1]!;
    const number = Number(numbered[2]);
    const suffix = numbered[3] ?? "";
    const issue = issues.find((i) => i.number === number);
    if (!issue) return jsonResponse({ message: "Not Found" }, 404);

    // GitHub serves a pull's diff from the pull itself, behind a media type.
    if (
      suffix === "" &&
      method === "GET" &&
      kind === "pulls" &&
      (request.headers.get("accept") ?? "").includes("diff")
    ) {
      return new Response(state.pullDiffs.get(`${fullName}#${number}`) ?? "", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    if (suffix === "" && method === "GET") {
      // `/issues/{n}` on a pull returns the *issue* — carrying the
      // `pull_request` key that says it is one, and nothing about branches.
      // That is what both forges do, and it is why an adapter has to
      // hydrate from `/pulls/{n}` rather than trust the issue payload.
      return jsonResponse(
        kind === "pulls"
          ? pullJson(state, url, issue)
          : issueJson(state, url, issue),
      );
    }
    if (suffix === "" && method === "PATCH") {
      if (state.refuseWrite !== "") return refuse(state);
      const input = parse(bodyText);
      if (input.state === "closed" || input.state === "open") {
        issue.state = input.state;
        issue.closedAt =
          input.state === "closed" ? new Date().toISOString() : null;
      }
      issue.updatedAt = new Date().toISOString();
      // Forgejo answers 201 to a successful edit, which is a real trap.
      return jsonResponse(
        issue.pull ? pullJson(state, url, issue) : issueJson(state, url, issue),
        state.kind === "github" ? 200 : 201,
      );
    }
    if (suffix === "/labels" && method === "PUT") {
      if (state.refuseWrite !== "") return refuse(state);
      const input = parse(bodyText);
      const names = Array.isArray(input.labels)
        ? input.labels.filter((l): l is string => typeof l === "string")
        : [];
      issue.labels = names;
      issue.updatedAt = new Date().toISOString();
      const known = state.labels.get(fullName) ?? [];
      return jsonResponse(
        names.map(
          (name) =>
            known.find((l) => l.name === name) ?? {
              id: state.nextId++,
              name,
              color: "6b7280",
            },
        ),
      );
    }
    if (suffix === "/comments" && method === "GET") {
      const since = q.get("since");
      const rows = (state.comments.get(fullName) ?? []).filter(
        (c) =>
          c.issueNumber === number &&
          (since === null || (c.updatedAt ?? "") >= since),
      );
      // GitHub's review comments live at /pulls/{n}/comments.
      if (kind === "pulls" && state.kind === "github") {
        return jsonResponse(
          (state.reviews.get(fullName) ?? [])
            .filter((r) => r.issueNumber === number)
            .map((r) => reviewJson(url, r)),
        );
      }
      return jsonResponse(rows.map((c) => commentJson(url, c)));
    }
    if (suffix === "/comments" && method === "POST") {
      if (state.refuseWrite !== "") return refuse(state);
      const input = parse(bodyText);
      const created: FakeComment = {
        id: state.nextId++,
        issueNumber: number,
        body: String(input.body ?? ""),
        user: state.login,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const all = state.comments.get(fullName) ?? [];
      all.push(created);
      state.comments.set(fullName, all);
      issue.updatedAt = new Date().toISOString();
      return jsonResponse(commentJson(url, created), 201);
    }
    // `/reviews` serves both readings: the verdicts (which carry a `state`)
    // and, on Forgejo, the review objects whose comments the line-comment
    // walk follows. One list, exactly as both forges serve it.
    if (suffix === "/reviews" && method === "GET") {
      const rows = (state.reviews.get(fullName) ?? []).filter(
        (r) => r.issueNumber === number,
      );
      const verdicts = (state.reviewStates.get(fullName) ?? []).filter(
        (r) => r.issueNumber === number,
      );
      return jsonResponse([
        ...verdicts.map((r) => reviewStateJson(url, r)),
        ...rows.map((r) => ({
          id: r.id,
          body: "",
          user: { login: r.user },
        })),
      ]);
    }
    if (suffix === "/reviews" && method === "POST") {
      if (state.refuseWrite !== "") return refuse(state);
      const input = parse(bodyText);
      const created: FakeReviewState = {
        id: state.nextId++,
        issueNumber: number,
        user: state.login,
        state: String(input.event ?? ""),
        body: String(input.body ?? ""),
        commitId: issue.pull?.headSha ?? "",
        submittedAt: new Date().toISOString(),
      };
      const all = state.reviewStates.get(fullName) ?? [];
      all.push(created);
      state.reviewStates.set(fullName, all);
      return jsonResponse(reviewStateJson(url, created), 200);
    }
    const reviewComments = /^\/reviews\/(\d+)\/comments$/.exec(suffix);
    if (reviewComments && method === "GET") {
      const reviewId = Number(reviewComments[1]);
      const rows = (state.reviews.get(fullName) ?? []).filter(
        (r) => r.id === reviewId,
      );
      return jsonResponse(rows.map((r) => reviewJson(url, r)));
    }
  }

  return new Response("no route", { status: 404 });
}

function refuse(state: FakeState): Response {
  return jsonResponse({ message: state.refuseWrite }, 422);
}

/**
 * The cross-repo issue search, in each forge's own dialect: GitHub wraps its
 * hits in `{items}` and names the repo only through `repository_url`;
 * Forgejo returns a bare array whose rows carry `repository.full_name`.
 * The scope lives inside GitHub's query string (`user:<login>`), so that
 * token is stripped from the needle rather than matched against titles.
 */
function searchIssuesJson(
  state: FakeState,
  url: URL,
  query: string,
  params: URLSearchParams,
): Response {
  const needle = query
    .split(/\s+/)
    .filter((t) => t !== "" && !t.includes(":"))
    .join(" ")
    .toLowerCase();
  const limit =
    Number(params.get("per_page") ?? params.get("limit") ?? 30) || 30;

  const hits: { fullName: string; issue: FakeIssue }[] = [];
  for (const [fullName, issues] of state.issues) {
    for (const issue of issues) {
      const haystack = `${issue.title} ${issue.body ?? ""}`.toLowerCase();
      if (needle !== "" && !haystack.includes(needle)) continue;
      hits.push({ fullName, issue });
    }
  }
  const page = hits.slice(0, limit);

  if (state.kind === "github") {
    return jsonResponse({
      total_count: hits.length,
      incomplete_results: false,
      items: page.map(({ fullName, issue }) => ({
        ...(issue.pull
          ? pullJson(state, url, issue)
          : issueJson(state, url, issue)),
        repository_url: `${url.origin}/repos/${fullName}`,
      })),
    });
  }
  return jsonResponse(
    page.map(({ fullName, issue }) => ({
      ...(issue.pull
        ? pullJson(state, url, issue)
        : issueJson(state, url, issue)),
      repository: { full_name: fullName },
    })),
  );
}

const parse = (text: string): Record<string, unknown> => {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};

const nextNumber = (issues: FakeIssue[]): number =>
  issues.reduce((max, i) => Math.max(max, i.number), 0) + 1;

// ---- the browse shapes ----

/** git's own blob id, so a fake `sha` is a real one. */
const blobSha = (content: string): string => {
  const bytes = Buffer.from(content, "utf8");
  return createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
};

/** A file, as both forges' `contents` endpoint returns one. */
function fileJson(path: string, content: string): Record<string, unknown> {
  const bytes = Buffer.from(content, "utf8");
  const name = path.split("/").pop() ?? path;
  // Over a megabyte both forges stop sending the body and say so, which is
  // the answer a browse has to handle without holding the file.
  const tooBig = bytes.length > 1024 * 1024;
  return {
    name,
    path,
    type: "file",
    size: bytes.length,
    sha: blobSha(content),
    encoding: tooBig ? "none" : "base64",
    content: tooBig ? "" : bytes.toString("base64"),
  };
}

/** One directory level, derived from the flat path map. */
function listDir(
  files: Map<string, string>,
  path: string,
): Record<string, unknown>[] {
  const prefix = path === "" ? "" : `${path}/`;
  const rows = new Map<string, Record<string, unknown>>();
  for (const [full, content] of files) {
    if (!full.startsWith(prefix)) continue;
    const rest = full.slice(prefix.length);
    if (rest === "") continue;
    const slash = rest.indexOf("/");
    if (slash === -1) {
      rows.set(rest, {
        name: rest,
        path: full,
        type: "file",
        size: Buffer.byteLength(content, "utf8"),
        sha: blobSha(content),
      });
      continue;
    }
    const dir = rest.slice(0, slash);
    if (!rows.has(dir))
      rows.set(dir, {
        name: dir,
        path: `${prefix}${dir}`,
        type: "dir",
        size: 0,
        sha: blobSha(`${prefix}${dir}/`),
      });
  }
  return [...rows.values()];
}

/** A commit row — the one shape GitHub and Forgejo genuinely agree on. */
function commitJson(commit: FakeCommit): Record<string, unknown> {
  return {
    sha: commit.sha,
    commit: {
      message: commit.message,
      author: {
        name: commit.authorName,
        email: commit.authorEmail ?? `${commit.authorName}@example.invalid`,
        date: commit.date,
      },
    },
    author: commit.login === undefined ? null : { login: commit.login },
    parents: (commit.parents ?? []).map((sha) => ({ sha })),
  };
}

function repoJson(state: FakeState, repo: FakeRepo): Record<string, unknown> {
  const [owner, name] = repo.fullName.split("/");
  const common = {
    id: repo.id,
    full_name: repo.fullName,
    name,
    owner: { login: owner },
    description: repo.description ?? "",
    private: repo.private ?? false,
    fork: repo.fork ?? false,
    default_branch: repo.defaultBranch ?? "main",
    clone_url: repo.cloneUrl,
    ssh_url: "",
    html_url: repo.htmlUrl ?? `https://example.invalid/${repo.fullName}`,
    permissions: { push: repo.push ?? true, admin: repo.admin ?? true },
    size: repo.sizeKb ?? 0,
    // Both forges report the parent here and nowhere else, which is why the
    // picker's cache must keep the one it has when a listing omits it.
    ...(repo.parent === undefined
      ? {}
      : { parent: { full_name: repo.parent } }),
    ...(repo.root === undefined || state.kind !== "github"
      ? {}
      : { source: { full_name: repo.root } }),
  };
  return state.kind === "github"
    ? {
        ...common,
        pushed_at: repo.pushedAt ?? null,
        // GitHub's one number is issues AND pulls; there is no second field.
        open_issues_count: repo.openIssues ?? 0,
      }
    : {
        ...common,
        updated_at: repo.pushedAt ?? null,
        open_issues_count: repo.openIssues ?? 0,
        open_pr_counter: repo.openPulls ?? 0,
      };
}

function issueJson(
  state: FakeState,
  url: URL,
  issue: FakeIssue,
): Record<string, unknown> {
  const common = {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    // Nullable in the wild; the adapter must normalise it to "".
    body: issue.body ?? null,
    user: { login: issue.user },
    state: issue.state ?? "open",
    labels: (issue.labels ?? []).map((name) => ({ name })),
    created_at: issue.createdAt ?? new Date().toISOString(),
    updated_at: issue.updatedAt ?? issue.createdAt ?? new Date().toISOString(),
    closed_at: issue.closedAt ?? null,
    html_url: `${url.origin}/${issue.number}`,
    comments: issue.commentCount ?? 0,
    ...(issue.milestone === undefined
      ? {}
      : { milestone: { number: issue.milestone } }),
  };
  if (issue.pull === undefined) return common;
  // GitHub marks a pull by the mere presence of this key; Forgejo puts the
  // merge state inline.
  return state.kind === "github"
    ? { ...common, pull_request: { url: `${url.origin}/p/${issue.number}` } }
    : {
        ...common,
        pull_request: {
          merged: issue.pull.mergedAt != null,
          merged_at: issue.pull.mergedAt ?? null,
          draft: issue.pull.draft ?? false,
        },
      };
}

function pullJson(
  state: FakeState,
  url: URL,
  issue: FakeIssue,
): Record<string, unknown> {
  const pull = issue.pull ?? { base: "main", head: "topic" };
  const { pull: _pull, ...plain } = issue;
  return {
    ...issueJson(state, url, plain),
    base: {
      ref: pull.base,
      sha: pull.baseSha ?? "b".repeat(40),
      repo: { full_name: pull.headRepo ?? "" },
    },
    head: {
      ref: pull.head,
      sha: pull.headSha ?? "c".repeat(40),
      repo: { full_name: pull.headRepo ?? "" },
    },
    merged: pull.mergedAt != null,
    merged_at: pull.mergedAt ?? null,
    draft: pull.draft ?? false,
  };
}

const commentJson = (url: URL, c: FakeComment): Record<string, unknown> => ({
  id: c.id,
  body: c.body,
  user: { login: c.user },
  created_at: c.createdAt ?? new Date().toISOString(),
  updated_at: c.updatedAt ?? c.createdAt ?? new Date().toISOString(),
  html_url: `${url.origin}/c/${c.id}`,
});

const reviewJson = (url: URL, r: FakeReview): Record<string, unknown> => ({
  id: r.id,
  body: r.body,
  user: { login: r.user },
  path: r.path,
  diff_hunk: r.diffHunk,
  ...(r.line === undefined ? {} : { line: r.line }),
  ...(r.side === undefined ? {} : { side: r.side }),
  created_at: new Date().toISOString(),
  html_url: `${url.origin}/r/${r.id}`,
});
/**
 * A verdict, in the shape both forges serve. GitHub answers its POST with
 * `APPROVED` even though the request said `APPROVE`; the fake keeps whatever
 * word the request used, which is exactly the mismatch an adapter has to
 * survive.
 */
const reviewStateJson = (
  url: URL,
  r: FakeReviewState,
): Record<string, unknown> => ({
  id: r.id,
  user: { login: r.user },
  state: r.state,
  body: r.body ?? "",
  commit_id: r.commitId ?? "",
  submitted_at: r.submittedAt ?? new Date().toISOString(),
  html_url: `${url.origin}/rs/${r.id}`,
});

/**
 * `owner:branch` names a branch in another repository; a bare branch names
 * one in this repository. Both forges resolve the owner against a repo of
 * the same name, which is why a fork keeps the name it was forked from.
 */
function headRepoOf(fullName: string, head: string): string {
  const colon = head.indexOf(":");
  if (colon < 0) return fullName;
  return `${head.slice(0, colon)}/${fullName.split("/")[1] ?? ""}`;
}

// ---- OAuth, for the connect flows ----

export interface FakeOAuth {
  clientId: string;
  clientSecret: string;
  /** Device flow: what `POST /login/device/code` hands out. */
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  intervalSecs: number;
  /** Flip to true to stand in for the human approving it. */
  approved: boolean;
  /** Make the next device poll answer `slow_down`, then stop. */
  slowDownOnce: boolean;
  /** Make every device poll answer this error code. */
  deviceError: string;
  /** Code flow: the code the callback will present. */
  authCode: string;
  accessToken: string;
  refreshToken: string;
  /** Seconds; 0 for a non-expiring token. */
  expiresIn: number;
  /** Hand back a new refresh token on every refresh, as rotation does. */
  rotate: boolean;
  /** Called while a refresh is being answered: something racing it. */
  onRefresh?: () => void;
  /** Answer the next refresh with this OAuth error code. */
  refreshError: string;
  /** Every token-endpoint request body, parsed. */
  tokenRequests: Record<string, string>[];
  revoked: { clientId: string; authorization: string }[];
  /**
   * Code flow, optional strictness: when set, the exchange is refused unless
   * S256(code_verifier) equals this (what a real PKCE server checks against
   * the challenge it saw on the authorize leg).
   */
  expectedChallenge?: string;
  /** Code flow, optional strictness: the exchange's redirect_uri must match. */
  expectedRedirectUri?: string;
}

export function newFakeOAuth(clientId: string, secret = ""): FakeOAuth {
  return {
    clientId,
    clientSecret: secret,
    deviceCode: "device-code-abc",
    userCode: "WXYZ-1234",
    verificationUri: "https://example.invalid/device",
    intervalSecs: 1,
    approved: false,
    slowDownOnce: false,
    deviceError: "",
    authCode: "auth-code-xyz",
    accessToken: "gho_firstaccesstoken0000000000000000",
    refreshToken: "ghr_firstrefreshtoken000000000000000",
    expiresIn: 3600,
    rotate: true,
    refreshError: "",
    tokenRequests: [],
    revoked: [],
  };
}

/**
 * The OAuth endpoints, which live on the *web* origin and take no bearer
 * token — so they are answered before the fake's API auth check. Returns
 * undefined for a path this does not own.
 */
export function oauthRoute(
  oauth: FakeOAuth,
  request: Request,
  url: URL,
  bodyText: string,
): Response | undefined {
  const form = Object.fromEntries(new URLSearchParams(bodyText).entries());

  if (url.pathname === "/login/device/code" && request.method === "POST") {
    if (form.client_id !== oauth.clientId)
      return jsonResponse({ error: "Not Found" });
    return jsonResponse({
      device_code: oauth.deviceCode,
      user_code: oauth.userCode,
      verification_uri: oauth.verificationUri,
      interval: oauth.intervalSecs,
      expires_in: 900,
    });
  }

  if (
    url.pathname === "/login/oauth/access_token" &&
    request.method === "POST"
  ) {
    oauth.tokenRequests.push(form);
    if (form.client_id !== oauth.clientId)
      return jsonResponse({ error: "Not Found" });

    if (form.grant_type === "refresh_token") {
      if (oauth.refreshError !== "")
        return jsonResponse({
          error: oauth.refreshError,
          error_description: "token was already used",
        });
      if (form.refresh_token !== oauth.refreshToken)
        return jsonResponse({ error: "unauthorized_client" });
      oauth.onRefresh?.();
      oauth.accessToken = `gho_refreshed${oauth.tokenRequests.length}00000000000000000`;
      if (oauth.rotate)
        oauth.refreshToken = `ghr_rotated${oauth.tokenRequests.length}0000000000000000000`;
      return jsonResponse({
        access_token: oauth.accessToken,
        refresh_token: oauth.refreshToken,
        expires_in: oauth.expiresIn,
        token_type: "bearer",
      });
    }

    if (form.grant_type === "authorization_code") {
      if (form.code !== oauth.authCode)
        return jsonResponse({ error: "invalid_grant" });
      if (
        oauth.expectedChallenge !== undefined &&
        s256(form.code_verifier ?? "") !== oauth.expectedChallenge
      )
        return jsonResponse({
          error: "invalid_grant",
          error_description: "code_verifier does not match the challenge",
        });
      if (
        oauth.expectedRedirectUri !== undefined &&
        form.redirect_uri !== oauth.expectedRedirectUri
      )
        return jsonResponse({
          error: "invalid_grant",
          error_description: "redirect_uri mismatch",
        });
      return jsonResponse({
        access_token: oauth.accessToken,
        refresh_token: oauth.refreshToken,
        expires_in: oauth.expiresIn,
        token_type: "bearer",
      });
    }

    // The device grant.
    if (oauth.deviceError !== "")
      return jsonResponse({ error: oauth.deviceError });
    if (oauth.slowDownOnce) {
      oauth.slowDownOnce = false;
      return jsonResponse({ error: "slow_down" });
    }
    if (!oauth.approved)
      return jsonResponse({ error: "authorization_pending" });
    return jsonResponse({
      access_token: oauth.accessToken,
      refresh_token: oauth.refreshToken,
      expires_in: oauth.expiresIn,
      token_type: "bearer",
    });
  }

  const revoke = /^(?:\/api\/v3)?\/applications\/([^/]+)\/grant$/.exec(
    url.pathname,
  );
  if (revoke && request.method === "DELETE") {
    oauth.revoked.push({
      clientId: revoke[1]!,
      authorization: request.headers.get("authorization") ?? "",
    });
    return new Response(null, { status: 204 });
  }
  return undefined;
}

/** PKCE S256: base64url(sha256(verifier)), the check a real server makes. */
export const s256 = (verifier: string): string =>
  createHash("sha256").update(verifier).digest("base64url");
