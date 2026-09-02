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

export type FakeKind = "github" | "forgejo" | "gitea";

export interface FakeRepo {
  id: number;
  fullName: string;
  description?: string;
  private?: boolean;
  fork?: boolean;
  defaultBranch?: string;
  cloneUrl: string;
  htmlUrl?: string;
  pushedAt?: string;
  push?: boolean;
  admin?: boolean;
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

export interface FakeLabel {
  id: number;
  name: string;
  color: string;
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
  issues: Map<string, FakeIssue[]>;
  comments: Map<string, FakeComment[]>;
  reviews: Map<string, FakeReview[]>;
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
  nextId: number;
  /** The OAuth endpoints, when a test wants the connect flows. */
  oauth?: FakeOAuth;
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
    issues: new Map(),
    comments: new Map(),
    reviews: new Map(),
    requests: [],
    rateLimitFor: 0,
    maxResponseItems: 50,
    etagsEnabled: false,
    conditionalHits: 0,
    refuseWrite: "",
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
): Response {
  const q = url.searchParams;
  const method = request.method;

  if (rest === "/settings/api")
    return jsonResponse({ max_response_items: state.maxResponseItems });

  if (rest === "/user")
    return jsonResponse({
      id: 7,
      login: state.login,
      full_name: state.login,
      name: state.login,
      html_url: `${url.origin}/${state.login}`,
    });

  if (rest === "/user/repos" || rest === "/repos/search") {
    const rows = state.repos.map((r) => repoJson(state, r));
    const payload = rest === "/repos/search" ? { ok: true, data: rows } : rows;
    return jsonResponse(payload, 200, { "x-total-count": String(rows.length) });
  }

  const repoMatch = /^\/repos\/([^/]+)\/([^/]+)(.*)$/.exec(rest);
  if (!repoMatch) return new Response("no route", { status: 404 });
  const fullName = `${repoMatch[1]}/${repoMatch[2]}`;
  const tail = repoMatch[3] ?? "";
  const repo = state.repos.find((r) => r.fullName === fullName);
  if (!repo) return jsonResponse({ message: "Not Found" }, 404);

  if (tail === "") return jsonResponse(repoJson(state, repo));

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
        head: String(input.head ?? ""),
        headRepo: fullName,
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

    if (suffix === "" && method === "GET") {
      return jsonResponse(
        kind === "pulls" || issue.pull !== undefined
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
    // Forgejo: reviews, then each review's comments.
    if (suffix === "/reviews" && method === "GET") {
      const rows = (state.reviews.get(fullName) ?? []).filter(
        (r) => r.issueNumber === number,
      );
      return jsonResponse(
        rows.map((r) => ({
          id: r.id,
          body: "",
          user: { login: r.user },
        })),
      );
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
  };
  return state.kind === "github"
    ? { ...common, pushed_at: repo.pushedAt ?? null }
    : { ...common, updated_at: repo.pushedAt ?? null };
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
    comments: 0,
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
  /** Answer the next refresh with this OAuth error code. */
  refreshError: string;
  /** Every token-endpoint request body, parsed. */
  tokenRequests: Record<string, string>[];
  revoked: { clientId: string; authorization: string }[];
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
