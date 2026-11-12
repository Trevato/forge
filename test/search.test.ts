/**
 * One search across everything reachable: repos here, repos cached from an
 * origin, conversations, and the code itself.
 *
 * The adversarial half is the point. A code search hands a stranger's string
 * to `git grep`, so the tests that matter are the ones where the string
 * *looks* like an argument — a leading dash, an embedded `--` — and the one
 * that proves a private repo is not merely filtered out of the answer but
 * never searched at all. The query-plan test is the scale half: a search
 * that degrades into a scan of every issue in the forge is a search that
 * stops working the week it becomes useful.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIVE_BUDGET_MS, search } from "../src/actions/search.ts";
import { createApp, type App } from "../src/app.ts";
import { getRepo, listReposVisibleTo } from "../src/core/repos.ts";
import { searchLocalIssues, MAX_CODE_HITS } from "../src/core/search.ts";
import { getUserByName, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { newFakeState, serveFakeForge, type FakeForge } from "./fake-origin.ts";
import { seedAdmin } from "./helpers/admin.ts";

const read = async <T>(response: Response): Promise<T> =>
  (await response.json()) as T;

interface Results {
  note?: string;
  moreCode?: boolean;
  codeSkipped?: boolean;
  repos: (
    | {
        source: "local";
        owner: string;
        name: string;
        openIssues: number;
        openPulls: number;
      }
    | {
        source: "origin";
        fullName: string;
        htmlUrl: string;
        originId: string;
        mirroredAs: { owner: string; name: string } | null;
        openIssues: number;
        openPulls: number;
        openIssuesIncludingPulls: boolean;
      }
  )[];
  issues: (
    | {
        source: "local";
        repo: { owner: string; name: string };
        number: number;
        title: string;
      }
    | { source: "origin"; fullName: string; number: number; title: string }
  )[];
  code: {
    repo: { owner: string; name: string };
    archived?: boolean;
    path: string;
    line: number;
    text: string;
  }[];
  truncated: { repos: boolean; issues: boolean; code: boolean };
}

const ORIGIN_LOGIN = "octo";
const ORIGIN_TOKEN = "octo-search-secret-3312";

describe("search: one query, four sources", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let fake: FakeForge;
  let alice = "";
  let bob = "";
  let aliceUser: User;
  let bobUser: User;
  let originId = "";

  const api = (path: string, init?: RequestInit, token = alice) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
    });

  // Connecting an origin is an account-level act: a token never bootstraps
  // one, so these calls carry the password like a session would.
  const account = (path: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (init?.body !== undefined)
      headers.set("content-type", "application/json");
    headers.set(
      "authorization",
      `Basic ${Buffer.from("alice:alice-search-secret").toString("base64")}`,
    );
    return fetch(`${base}${path}`, { ...init, headers });
  };

  const signUp = async (username: string, password: string, scope = "rw") => {
    await fetch(`${base}/api/v1/users`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username,
        email: `${username}@forge.test`,
        password,
      }),
    });
    return tokenFor(username, password, scope);
  };
  const tokenFor = async (username: string, password: string, scope = "rw") =>
    read<{ token: string }>(
      await fetch(`${base}/api/v1/tokens`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ adminConfirm: true, username, password, name: scope, scope }),
      }),
    ).then((t) => t.token);

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-search-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;

    await seedAdmin(app, { username: "alice", email: "alice@forge.test", password: "alice-search-secret" });
    alice = await tokenFor("alice", "alice-search-secret");
    bob = await signUp("bob", "bob-search-secret");
    aliceUser = getUserByName(app.db, "alice")!;
    bobUser = getUserByName(app.db, "bob")!;

    await api("/api/v1/repos", {
      method: "POST",
      body: JSON.stringify({
        name: "widget-engine",
        visibility: "public",
        description: "the flux capacitor of widgets",
      }),
    });
    await api("/api/v1/repos", {
      method: "POST",
      body: JSON.stringify({
        name: "private-lab",
        visibility: "private",
        description: "flux experiments nobody may see",
      }),
    });

    await api("/api/v1/repos/alice/widget-engine/contents", {
      method: "POST",
      body: JSON.stringify({
        branch: "main",
        message: "first",
        files: [
          {
            path: "src/flux.ts",
            content:
              "export const flux = 1;\nconst cli = '--capacitor';\nconst dash = '-fluxive';\n",
          },
          { path: "README.md", content: "# widget engine\nflux everywhere\n" },
        ],
      }),
    });
    await api("/api/v1/repos/alice/private-lab/contents", {
      method: "POST",
      body: JSON.stringify({
        branch: "main",
        message: "first",
        files: [{ path: "secret.ts", content: "const flux = 'classified';\n" }],
      }),
    });

    await api("/api/v1/repos/alice/widget-engine/issues", {
      method: "POST",
      body: JSON.stringify({ title: "flux capacitor overheats", body: "hot" }),
    });
    await api("/api/v1/repos/alice/widget-engine/issues", {
      method: "POST",
      body: JSON.stringify({ title: "unrelated paperwork", body: "" }),
    });
    await api("/api/v1/repos/alice/private-lab/issues", {
      method: "POST",
      body: JSON.stringify({ title: "flux leak in the lab", body: "" }),
    });

    // An origin, with repos to cache and issues its own search can find.
    const state = newFakeState("forgejo", ORIGIN_LOGIN, ORIGIN_TOKEN);
    state.repos.push({
      id: 11,
      fullName: "octo/flux-upstream",
      description: "the upstream flux",
      cloneUrl: "http://localhost:1/octo/flux-upstream.git",
      htmlUrl: "https://origin.test/octo/flux-upstream",
      defaultBranch: "main",
      openIssues: 4,
      openPulls: 2,
    });
    state.issues.set("octo/flux-upstream", [
      {
        id: 900,
        number: 7,
        title: "flux drifts upstream",
        user: ORIGIN_LOGIN,
        state: "open",
        updatedAt: "2026-01-01T00:00:00Z",
      },
      {
        id: 901,
        number: 8,
        title: "nothing to do with it",
        user: ORIGIN_LOGIN,
        state: "open",
        updatedAt: "2026-01-02T00:00:00Z",
      },
    ]);
    fake = serveFakeForge(state);

    const connected = await read<{ id: string }>(
      await account("/api/v1/user/origins", {
        method: "POST",
        body: JSON.stringify({ host: fake.url, token: ORIGIN_TOKEN }),
      }),
    );
    originId = connected.id;
    expect(originId).toBeTruthy();
    // Fills the picker cache, which is what a repo search reads.
    const cached = await account(`/api/v1/user/origins/${originId}/repos`);
    expect(cached.status).toBe(200);
  });

  afterAll(async () => {
    fake.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const find = async (query: string, token = alice): Promise<Results> =>
    read<Results>(await api(`/api/v1/search?${query}`, undefined, token));

  test("repos come from here and from every connected origin", async () => {
    const results = await find("q=flux&kind=repos");
    const local = results.repos.filter((r) => r.source === "local");
    const origin = results.repos.filter((r) => r.source === "origin");

    expect(local.map((r) => `${r.owner}/${r.name}`).sort()).toEqual([
      "alice/private-lab",
      "alice/widget-engine",
    ]);
    expect(origin).toHaveLength(1);
    expect(origin[0]).toMatchObject({
      fullName: "octo/flux-upstream",
      htmlUrl: "https://origin.test/octo/flux-upstream",
      originId,
      mirroredAs: null,
      // Forgejo separates the two, so the honesty flag is off.
      openIssues: 4,
      openPulls: 2,
      openIssuesIncludingPulls: false,
    });
  });

  test("local repo hits carry their open counts", async () => {
    // Its own repo: other tests file issues in widget-engine, so counts
    // read there depend on which of them ran first.
    await api("/api/v1/repos", {
      method: "POST",
      body: JSON.stringify({ name: "tally-box", visibility: "public" }),
    });
    for (const title of ["first tally", "second tally"])
      await api("/api/v1/repos/alice/tally-box/issues", {
        method: "POST",
        body: JSON.stringify({ title, body: "" }),
      });
    const results = await find("q=tally-box&kind=repos");
    const hit = results.repos.find(
      (r) => r.source === "local" && r.name === "tally-box",
    );
    expect(hit).toMatchObject({ openIssues: 2, openPulls: 0 });
  });

  test("issues are found by title, across visible repos", async () => {
    const results = await find("q=flux&kind=issues");
    const titles = results.issues.map((i) => i.title).sort();
    expect(titles).toEqual([
      "flux capacitor overheats",
      "flux leak in the lab",
    ]);
    expect(results.issues.every((i) => i.source === "local")).toBe(true);
  });

  test("code search finds a line, and names where it is", async () => {
    const results = await find("q=capacitor&kind=code");
    expect(results.code.length).toBeGreaterThan(0);
    const hit = results.code.find((c) => c.path === "src/flux.ts");
    expect(hit).toBeDefined();
    expect(hit!.repo).toEqual({ owner: "alice", name: "widget-engine" });
    expect(hit!.line).toBe(2);
    expect(hit!.text).toContain("--capacitor");
  });

  test("a query that starts with a dash is a pattern, not a flag", async () => {
    const results = await find(`q=${encodeURIComponent("-fluxive")}&kind=code`);
    expect(results.code.map((c) => c.path)).toContain("src/flux.ts");
    expect(results.code[0]!.text).toContain("-fluxive");

    // The classic one: if `-e` were missing, this would be `git grep
    // --delete-everything`, and git would refuse or, worse, obey.
    const canary = join(dataDir, "written-by-git");
    const hostile = await find(
      `q=${encodeURIComponent(`--output=${canary}`)}&kind=code`,
    );
    expect(hostile.code).toEqual([]);
    expect(existsSync(canary)).toBe(false);
  });

  test("a query containing -- is matched literally", async () => {
    const results = await find(
      `q=${encodeURIComponent("--capacitor")}&kind=code`,
    );
    expect(results.code.map((c) => c.path)).toContain("src/flux.ts");
  });

  test("a private repo is never searched for somebody who cannot read it", async () => {
    // Bob can see the public repo and nothing else — in all three lists.
    const results = await find("q=flux", bob);
    expect(
      results.repos.map((r) => (r.source === "local" ? r.name : r.fullName)),
    ).toEqual(["widget-engine"]);
    expect(results.issues.map((i) => i.title)).toEqual([
      "flux capacitor overheats",
    ]);
    expect(results.code.every((c) => c.repo.name === "widget-engine")).toBe(
      true,
    );

    // And an anonymous caller gets the public half with no origins at all.
    const anonymous = await read<Results>(
      await fetch(`${base}/api/v1/search?q=flux`),
    );
    expect(anonymous.repos.every((r) => r.source === "local")).toBe(true);
    expect(
      anonymous.repos.map((r) => (r.source === "local" ? r.name : "")),
    ).toEqual(["widget-engine"]);
    expect(anonymous.issues.map((i) => i.title)).toEqual([
      "flux capacitor overheats",
    ]);
  });

  test("live=1 asks each origin's own issue search", async () => {
    const cached = await find("q=drifts&kind=issues");
    expect(cached.issues).toEqual([]);

    const live = await find("q=drifts&kind=issues&live=1");
    const remote = live.issues.filter((i) => i.source === "origin");
    expect(remote).toHaveLength(1);
    expect(remote[0]).toMatchObject({
      fullName: "octo/flux-upstream",
      number: 7,
      title: "flux drifts upstream",
    });

    // Bob has no origins, so live costs him nothing and finds nothing.
    const bobs = await find("q=drifts&kind=issues&live=1", bob);
    expect(bobs.issues).toEqual([]);
  });

  test("an origin that needs reconnecting is skipped, not retried", async () => {
    app.db
      .query("UPDATE origin SET needs_reauth = 1 WHERE id = ?1")
      .run(originId);
    const before = fake.state.requests.length;
    const live = await find("q=drifts&kind=issues&live=1");
    expect(live.issues.filter((i) => i.source === "origin")).toEqual([]);
    expect(fake.state.requests.length).toBe(before);
    app.db
      .query("UPDATE origin SET needs_reauth = 0 WHERE id = ?1")
      .run(originId);
  });

  test("an empty or whitespace query costs nothing and finds nothing", async () => {
    for (const q of ["", "%20%20", "%00"]) {
      const results = await find(`q=${q}`);
      expect(results.note).toContain("q is empty");
      expect({ ...results, note: undefined }).toEqual({
        note: undefined,
        repos: [],
        issues: [],
        code: [],
        moreCode: false,
        codeSkipped: false,
        truncated: { repos: false, issues: false, code: false },
      });
    }
  });

  test("every list is capped, and says so", async () => {
    // One file with more matching lines than a repo may contribute.
    await api("/api/v1/repos/alice/widget-engine/contents", {
      method: "POST",
      body: JSON.stringify({
        branch: "main",
        message: "many",
        files: [
          {
            path: "many.txt",
            content: Array.from(
              { length: 400 },
              (_, i) => `repeated ${i}`,
            ).join("\n"),
          },
        ],
      }),
    });
    const results = await search(app, aliceUser, {
      q: "repeated",
      kind: "code",
    });
    expect(results.code.length).toBeLessThanOrEqual(MAX_CODE_HITS);
    // The per-repo cap is what actually bounds it here: one repo cannot
    // spend the whole page.
    expect(results.code.length).toBeLessThanOrEqual(20);

    const capped = await search(app, aliceUser, {
      q: "flux",
      kind: "issues",
      limit: 1,
    });
    expect(capped.issues).toHaveLength(1);
    expect(capped.truncated.issues).toBe(true);
  });

  test("a path with a colon in it is attributed to the right file and line", async () => {
    await api("/api/v1/repos/alice/widget-engine/contents", {
      method: "POST",
      body: JSON.stringify({
        branch: "main",
        message: "colons",
        files: [
          {
            path: "notes/a:1:b.txt",
            content: "line one\ncolon needle here\n",
          },
        ],
      }),
    });
    const results = await find("q=colon+needle&kind=code");
    expect(results.code).toEqual([
      {
        repo: { owner: "alice", name: "widget-engine" },
        archived: false,
        path: "notes/a:1:b.txt",
        line: 2,
        text: "colon needle here",
      },
    ]);
  });

  test("a repo with no commits is searched without crashing", async () => {
    await api("/api/v1/repos", {
      method: "POST",
      body: JSON.stringify({ name: "unborn", visibility: "public" }),
    });
    const response = await api("/api/v1/search?q=flux&kind=code");
    expect(response.status).toBe(200);
    const results = await read<Results>(response);
    expect(results.code.some((h) => h.path.includes("flux"))).toBe(true);
    expect(results.code.some((h) => h.repo.name === "unborn")).toBe(false);
  });

  test("LIKE metacharacters in a query are literal, not wildcards", async () => {
    await api("/api/v1/repos/alice/widget-engine/issues", {
      method: "POST",
      body: JSON.stringify({ title: "100% done_right", body: "" }),
    });
    // `%` alone would match every title as a wildcard; escaped, it matches
    // the one title that contains a percent sign.
    const percent = await find(`q=${encodeURIComponent("0% d")}&kind=issues`);
    expect(percent.issues.map((i) => i.title)).toEqual(["100% done_right"]);
    const underscore = await find(`q=${encodeURIComponent("e_r")}&kind=issues`);
    expect(underscore.issues.map((i) => i.title)).toEqual(["100% done_right"]);
    // `_` is a single-character wildcard unescaped: it would match the `-`
    // in `widget-engine` and the `/` in every cached origin name.
    const repos = await find(`q=${encodeURIComponent("_")}&kind=repos`);
    expect(repos.repos).toEqual([]);
    const backslash = await find(`q=${encodeURIComponent("\\")}&kind=all`);
    expect(backslash.repos).toEqual([]);
    expect(backslash.issues).toEqual([]);
  });

  test("hostile queries are patterns to git grep, never flags, and never crash", async () => {
    const queries = [
      "-i",
      "--",
      "-e",
      "-F",
      "-z",
      "--max-count=1",
      "--open-files-in-pager=sh",
      "-O sh",
      "  ",
      // Longer than this and the transport answers 431 before we do.
      "a".repeat(4_000),
      "(flux|.*)+$",
      "[",
    ];
    for (const q of queries) {
      const response = await api(
        `/api/v1/search?q=${encodeURIComponent(q)}&kind=code`,
      );
      expect([q.slice(0, 20), response.status]).toEqual([q.slice(0, 20), 200]);
      const results = await read<Results>(response);
      // A regex metacharacter query under -F matches itself or nothing —
      // never every line.
      if (q === "(flux|.*)+$" || q === "[") expect(results.code).toEqual([]);
    }
    // A 100 KB paste is a paste, not a search: bounded to MAX_QUERY before
    // git ever sees it, and the NUL bytes in it are flattened.
    const pasted = await search(app, aliceUser, {
      q: `${"\u0000".repeat(50)}flux${"a".repeat(100 * 1024)}`,
      kind: "code",
    });
    expect(pasted.code).toEqual([]);
  });

  test("a hung origin spends the budget alone — the others still answer", async () => {
    const slow = newFakeState("forgejo", "sloth", "sloth-secret-0001");
    slow.repos.push({
      id: 21,
      fullName: "sloth/slow-flux",
      description: "never answers in time",
      cloneUrl: "http://localhost:1/sloth/slow-flux.git",
      htmlUrl: "https://slow.test/sloth/slow-flux",
      defaultBranch: "main",
    });
    slow.issues.set("sloth/slow-flux", [
      {
        id: 950,
        number: 1,
        title: "flux from the slow side",
        user: "sloth",
        state: "open",
        updatedAt: "2026-01-03T00:00:00Z",
      },
    ]);
    slow.searchDelayMs = LIVE_BUDGET_MS + 2_000;
    const slowFake = serveFakeForge(slow);
    try {
      const connected = await account("/api/v1/user/origins", {
        method: "POST",
        body: JSON.stringify({ host: slowFake.url, token: "sloth-secret-0001" }),
      });
      expect(connected.status).toBe(201);

      const started = Date.now();
      const results = await find("q=flux&kind=issues&live=1");
      const elapsed = Date.now() - started;
      // Bounded by the budget, not by the slowest origin…
      expect(elapsed).toBeLessThan(LIVE_BUDGET_MS + 1_500);
      // …and the origin that did answer is still in the page.
      const titles = results.issues
        .filter((i) => i.source === "origin")
        .map((i) => i.title);
      expect(titles).toContain("flux drifts upstream");
      expect(titles).not.toContain("flux from the slow side");
    } finally {
      slowFake.stop();
    }
  }, 20_000);

  test("the issue search never scans the issue table", () => {
    const repos = listReposVisibleTo(app.db, aliceUser, { limit: 50 });
    expect(repos.length).toBeGreaterThan(0);

    // Capture the statement the search actually runs, then ask SQLite to
    // explain it with the same shape of parameters.
    const original = app.db.query.bind(app.db);
    let captured = "";
    (app.db as unknown as { query: unknown }).query = (sql: string) => {
      if (sql.includes("FROM issue")) captured = sql;
      return original(sql);
    };
    try {
      searchLocalIssues(app.db, repos, "flux", 20);
    } finally {
      (app.db as unknown as { query: unknown }).query = original;
    }
    expect(captured).not.toBe("");

    const params = [...repos.map((r) => r.id), "%flux%", 20] as (
      | string
      | number
    )[];
    const plan = app.db
      .query<
        { detail: string },
        (string | number)[]
      >(`EXPLAIN QUERY PLAN ${captured}`)
      .all(...params);
    const details = plan.map((row) => row.detail);
    // A "SCAN" of the issue table is the failure this index exists to
    // prevent; a SEARCH (with or without a sort) is the pass.
    expect(details.some((d) => /^SCAN\b.*\bissue\b/.test(d))).toBe(false);
    expect(details.some((d) => /^SEARCH\b.*\bissue\b/.test(d))).toBe(true);
    // One walk a repository, newest first by `issue_repo_updated`, each cut at
    // the limit: a query matching every title reads `limit` rows a repository,
    // not every row it has (#11168).
    const walks = details.filter((d) => /^SEARCH issue\b/.test(d));
    expect(walks.length).toBe(repos.length);
    for (const d of walks) expect(d).toBe("SEARCH issue USING INDEX issue_repo_updated (repo_id=?)");
  });

  test("bob's own view is bounded the same way", () => {
    const repos = listReposVisibleTo(app.db, bobUser, { limit: 50 });
    const hits = searchLocalIssues(app.db, repos, "flux", 20);
    expect(hits.map((h) => h.title)).toEqual(["flux capacitor overheats"]);
    expect(getRepo(app.db, "alice", "private-lab")).toBeDefined();
  });
});
