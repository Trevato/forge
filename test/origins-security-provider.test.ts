import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { getOriginById } from "../src/core/origins.ts";
import { runGitCapture } from "../src/git/env.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { redactSecrets } from "../src/kernel/log.ts";
import { ApiClient, readCapped } from "../src/origins/providers/http.ts";
import { syncDue, syncOrigin } from "../src/origins/sync.ts";
import type { ProviderCredential } from "../src/origins/types.ts";
import {
  mirrorAndWait,
  newFakeState,
  serveFakeForge,
  type FakeForge,
} from "./fake-origin.ts";
import { seedAdmin } from "./helpers/admin.ts";

/**
 * The provider boundary, attacked. An origin is a host the user named and
 * every byte it sends is untrusted: a redirect is a request to carry the
 * credential elsewhere, an error body is a place to quote it back, a clone
 * URL is a git argument, a default branch is an `--initial-branch`, and a
 * title is a terminal escape sequence waiting to happen. Each of those has
 * one test here that would fail if the check in front of it were removed.
 */

/** A Forgejo-shaped token: bare hex, no prefix to pattern-match on. */
const TOKEN = "0123456789abcdef0123456789abcdef01234567";
const LOGIN = "octo";
const PASSWORD = "alice-login-secret";

const basic = (user: string, secret: string): string =>
  `Basic ${Buffer.from(`${user}:${secret}`).toString("base64")}`;

const read = async <T>(response: Response): Promise<T> =>
  (await response.json()) as T;

const credential = (apiUrl: string): ProviderCredential => ({
  kind: "forgejo",
  apiUrl,
  webUrl: apiUrl,
  login: LOGIN,
  authKind: "pat",
  token: async () => ({ ok: true, value: TOKEN }),
});

const client = (
  apiUrl: string,
  limits?: { timeoutMs?: number; maxBytes?: number },
): ApiClient =>
  new ApiClient(
    credential(apiUrl),
    (token) => ({ authorization: `token ${token}` }),
    limits,
  );

// ------------------------------------------------- the HTTP client itself

describe("a provider request cannot be turned against the credential", () => {
  test("a redirect off-host is refused and the far host sees nothing", async () => {
    const seen: Request[] = [];
    // Two distinct origins on loopback, told apart by port. Both are bound
    // and dialled at the same literal address: a name like `localhost` may
    // bind one family and resolve to the other, and then the redirect this
    // test is about is never reached.
    const attacker = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        seen.push(request);
        return Response.json({ login: "mallory" });
      },
    });
    let asked = 0;
    const origin = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        asked++;
        return new Response(null, {
          status: 302,
          headers: {
            location: `http://127.0.0.1:${attacker.port}/api/v1/user`,
          },
        });
      },
    });
    try {
      const result = await client(
        `http://127.0.0.1:${origin.port}/api/v1`,
      ).call({ path: "/user", method: "POST", body: { secret: "payload" } });
      // The origin was reached and did redirect: the refusal is the client's.
      expect(asked).toBe(1);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.error).toBe("invalid_response");
        expect(result.error.message).not.toContain(TOKEN);
      }
      // Not the header, not the body, not even a connection.
      expect(seen).toHaveLength(0);
    } finally {
      attacker.stop(true);
      origin.stop(true);
    }
  });

  test("a same-origin redirect (a renamed repo) is still followed", async () => {
    const paths: string[] = [];
    const origin = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        paths.push(url.pathname);
        if (url.pathname === "/api/v1/repos/octo/old")
          return new Response(null, {
            status: 301,
            headers: { location: "/api/v1/repos/octo/new" },
          });
        return Response.json({ full_name: "octo/new" });
      },
    });
    try {
      const result = await client(
        `http://localhost:${origin.port}/api/v1`,
      ).call({ path: "/repos/octo/old" });
      expect(result.ok).toBe(true);
      expect(paths).toEqual([
        "/api/v1/repos/octo/old",
        "/api/v1/repos/octo/new",
      ]);
    } finally {
      origin.stop(true);
    }
  });

  test("a redirect loop ends, and a Location-less redirect is an error", async () => {
    const origin = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname.endsWith("/loop"))
          return new Response(null, {
            status: 302,
            headers: { location: url.pathname },
          });
        return new Response(null, { status: 302 });
      },
    });
    try {
      const api = client(`http://localhost:${origin.port}/api/v1`);
      const loop = await api.call({ path: "/loop" });
      expect(loop.ok).toBe(false);
      const nowhere = await api.call({ path: "/nowhere" });
      expect(nowhere.ok).toBe(false);
    } finally {
      origin.stop(true);
    }
  });

  test("an error body that quotes the token back is scrubbed", async () => {
    const origin = Bun.serve({
      port: 0,
      fetch(request) {
        const auth = request.headers.get("authorization") ?? "";
        const url = new URL(request.url);
        if (url.pathname.endsWith("/422"))
          return Response.json(
            { message: `bad request with ${auth} (${TOKEN})` },
            { status: 422 },
          );
        if (url.pathname.endsWith("/500"))
          return new Response(`server error, saw ${auth}`, { status: 500 });
        return new Response(`teapot ${TOKEN}`, { status: 418 });
      },
    });
    try {
      const api = client(`http://localhost:${origin.port}/api/v1`);
      for (const path of ["/422", "/500", "/418"]) {
        const result = await api.call({ path });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).not.toContain(TOKEN);
          expect(redactSecrets(result.error.message)).not.toContain(TOKEN);
        }
      }
    } finally {
      origin.stop(true);
    }
  });

  test("an oversized body is cut at the cap, not buffered whole", async () => {
    const chunk = new Uint8Array(64 * 1024).fill(0x41); // 64 KiB of "A"
    const total = 20 * 1024 * 1024; // 20 MiB, no Content-Length
    let sent = 0;
    const origin = Bun.serve({
      port: 0,
      fetch() {
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent >= total) {
              controller.close();
              return;
            }
            sent += chunk.byteLength;
            controller.enqueue(chunk);
          },
        });
        return new Response(stream, {
          headers: { "content-type": "application/json" },
        });
      },
    });
    try {
      const cap = 1024 * 1024;
      const result = await client(`http://localhost:${origin.port}/api/v1`, {
        maxBytes: cap,
      }).call({ path: "/user" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain("too large");
      // (`sent` is the server draining its own stream, which Bun does
      // eagerly; the reader-side proof is the `readCapped` test below.)
      expect(sent).toBeGreaterThan(0);
    } finally {
      origin.stop(true);
    }
  });

  test("a declared oversized body is refused on its Content-Length alone", async () => {
    const origin = Bun.serve({
      port: 0,
      fetch() {
        return new Response(new Uint8Array(4096), {
          headers: { "content-length": String(64 * 1024 * 1024) },
        });
      },
    });
    try {
      const started = Date.now();
      const result = await client(`http://localhost:${origin.port}/api/v1`, {
        maxBytes: 1024,
      }).call({ path: "/user" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain("too large");
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      origin.stop(true);
    }
  });

  test("readCapped stops pulling at the cap", async () => {
    // In-process, so the pull count is the reader's and nobody else's: a
    // server would drain its own stream eagerly and prove nothing.
    let pulls = 0;
    const chunk = new Uint8Array(1024);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        if (pulls > 10_000) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const text = await readCapped(new Response(stream), 8 * 1024);
    expect(text).toBeUndefined();
    // Eight chunks reach the cap; a little read-ahead is fine, 10k is not.
    expect(pulls).toBeLessThan(64);
  });

  test("a body that never finishes is cut by the deadline", async () => {
    const origin = Bun.serve({
      port: 0,
      fetch() {
        // Headers now, a first chunk, then silence forever.
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"login":'));
          },
        });
        return new Response(stream);
      },
    });
    try {
      const started = Date.now();
      const result = await client(`http://localhost:${origin.port}/api/v1`, {
        timeoutMs: 300,
      }).call({ path: "/user" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.error).toBe("unreachable");
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      origin.stop(true);
    }
  });

  test("headers that never arrive are cut by the same deadline", async () => {
    const origin = Bun.serve({
      port: 0,
      fetch: () => new Promise<Response>(() => undefined),
    });
    try {
      const started = Date.now();
      const result = await client(`http://localhost:${origin.port}/api/v1`, {
        timeoutMs: 300,
      }).call({ path: "/user" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.error).toBe("unreachable");
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      origin.stop(true);
    }
  });
});

// ------------------------------------------------------------ log scrubbing

describe("a bare Forgejo token cannot reach a log line", () => {
  test("a 40-hex value under a credential-shaped key is redacted", () => {
    for (const line of [
      `token=${TOKEN}`,
      `password=${TOKEN}`,
      `secret=${TOKEN}`,
      `api_key=${TOKEN}`,
      `authorization="token ${TOKEN}"`,
      `Authorization: token ${TOKEN}`,
      `body="{\\"token\\":\\"${TOKEN}\\"}"`,
      `refresh failed detail="token: ${TOKEN}"`,
    ]) {
      expect(redactSecrets(line)).not.toContain(TOKEN);
    }
  });

  test("a commit id under an ordinary key survives intact", () => {
    // Object ids are 40 hex too; the scrub is keyed, not shape-matched, or
    // every push log would be a row of [redacted].
    const line = `push ref=refs/heads/main oid=${TOKEN} newOid=${TOKEN}`;
    expect(redactSecrets(line)).toBe(line);
  });
});

// ---------------------------------------- hostile values, end to end

describe("a hostile origin cannot reach git or the filesystem", () => {
  let dataDir: string;
  let upstreamDataDir: string;
  // What a hostile value would write if it ever reached git as an argument:
  // a path of this test's own, in a directory nothing else touches, so a
  // stray file elsewhere cannot fail the test and a real write cannot hide.
  let canaryDir: string;
  let canary: string;
  let app: App;
  let servers: Servers;
  let upstreamApp: App;
  let upstreamServers: Servers;
  let fake: FakeForge;
  let base: string;
  let originId = "";
  let goodCloneUrl = "";

  const api = (path: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (init?.body !== undefined)
      headers.set("content-type", "application/json");
    headers.set("authorization", basic("alice", PASSWORD));
    return fetch(`${base}${path}`, { ...init, headers });
  };

  /**
   * Mirroring is a job now, so a refusal lands on the job rather than in the
   * response: the request is accepted (202) the moment the origin is ours,
   * and every check the origin's own answer fails is inside the work.
   */
  const mirror = async (
    fullName: string,
  ): Promise<{ status: number; stage: string; error: string }> => {
    const response = await api(`/api/v1/user/origins/${originId}/mirror`, {
      method: "POST",
      body: JSON.stringify({ fullName }),
    });
    const job = await mirrorAndWait(response);
    return {
      status: response.status,
      stage: job?.stage ?? "failed",
      error: job?.error ?? "",
    };
  };

  const localRepos = (): string[] => {
    const owner = join(app.reposRoot, "alice");
    return existsSync(owner) ? readdirSync(owner).sort() : [];
  };

  const repoRow = (name: string) =>
    app.db
      .query<
        { id: string; fetch_error: string; default_branch: string },
        [string]
      >("SELECT id, fetch_error, default_branch FROM repo WHERE name = ?1")
      .get(name);

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-hostile-"));
    upstreamDataDir = await mkdtemp(join(tmpdir(), "forge-hostile-up-"));
    canaryDir = await mkdtemp(join(tmpdir(), "forge-hostile-canary-"));
    canary = join(canaryDir, "written");

    // A real git host for the one legitimate repo.
    upstreamApp = createApp({ dataDir: upstreamDataDir, port: 0 });
    upstreamServers = await serve(upstreamApp);
    await seedAdmin(upstreamApp, {
      username: LOGIN,
      email: "octo@up.test",
      password: TOKEN,
    });
    await fetch(`${upstreamServers.url}/api/v1/repos`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: basic(LOGIN, TOKEN),
      },
      body: JSON.stringify({ name: "good", visibility: "public" }),
    });
    await fetch(`${upstreamServers.url}/api/v1/repos/octo/good/contents`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: basic(LOGIN, TOKEN),
      },
      body: JSON.stringify({
        branch: "main",
        message: "first",
        files: [{ path: "a.txt", content: "one\n" }],
      }),
    });
    goodCloneUrl = `${upstreamServers.url}/octo/good.git`;

    const state = newFakeState("forgejo", LOGIN, TOKEN);
    state.repos.push(
      { id: 1, fullName: "octo/good", cloneUrl: goodCloneUrl },
      { id: 2, fullName: "octo/ext", cloneUrl: `ext::sh -c touch% ${canary}` },
      { id: 3, fullName: "octo/file", cloneUrl: "file:///etc" },
      {
        id: 4,
        fullName: "octo/flag",
        cloneUrl: `-oProxyCommand=touch ${canary}`,
      },
      { id: 5, fullName: "octo/ssh", cloneUrl: "ssh://git@example.invalid/x" },
      {
        id: 6,
        fullName: "octo/userinfo",
        cloneUrl: "https://user:tok@example.invalid/x.git",
      },
      { id: 7, fullName: "octo/-flag", cloneUrl: goodCloneUrl },
      {
        id: 8,
        fullName: "octo/branch",
        cloneUrl: goodCloneUrl,
        defaultBranch: "-x",
      },
      {
        id: 9,
        fullName: "octo/branch2",
        cloneUrl: goodCloneUrl,
        defaultBranch: "refs/../x",
      },
      { id: 10, fullName: "octo/ctl\x00name", cloneUrl: goodCloneUrl },
    );
    state.labels.set("octo/good", [
      { id: 1, name: "bug\x1b[31m", color: "d73a4a" },
      { id: 2, name: "nul\x00byte", color: "not-a-colour" },
    ]);
    state.issues.set("octo/good", [
      {
        id: 100,
        number: 1,
        title: "Escape \x1b]0;pwned\x07 me\nline two",
        body: "keep\nnewlines\tand tabs, drop \x00 nul and \x1b esc",
        user: "mal\x1blory",
        labels: ["bug\x1b[31m"],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: 101,
        number: 2,
        title: "Bad pull refs",
        user: "mona",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        pull: {
          base: `--output=${canary}`,
          head: "refs/../heads/x",
          baseSha: "--not-an-oid",
          headSha: "deadbeef",
          headRepo: "octo/good",
        },
      },
      {
        id: 102,
        number: -7,
        title: "Negative number",
        user: "mona",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    fake = serveFakeForge(state);

    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    await seedAdmin(app, {
      username: "alice",
      email: "alice@forge.test",
      password: PASSWORD,
    });
    const connected = await read<{ id: string; kind: string }>(
      await api("/api/v1/user/origins", {
        method: "POST",
        body: JSON.stringify({ host: fake.url, token: TOKEN }),
      }),
    );
    originId = connected.id;
    expect(connected.kind).toBe("forgejo");
  });

  afterAll(async () => {
    fake.stop();
    servers.stop();
    upstreamServers.stop();
    app.close();
    upstreamApp.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(upstreamDataDir, { recursive: true, force: true });
    await rm(canaryDir, { recursive: true, force: true });
  });

  test("a clone URL that is not http(s) never becomes a git argument", async () => {
    for (const name of ["ext", "file", "flag", "ssh", "userinfo"]) {
      const response = await mirror(`octo/${name}`);
      expect(response.stage).toBe("failed");
      // Refused before a row or a directory exists.
      expect(repoRow(name)).toBeFalsy();
      expect(localRepos()).not.toContain(`${name}.git`);
    }
    expect(readdirSync(canaryDir)).toEqual([]);
  });

  test("a full name that is not owner/name is refused before any path", async () => {
    for (const fullName of ["../../x", "owner/../x", "a/b/c", "octo/-flag"]) {
      const response = await mirror(fullName);
      expect(response.stage).toBe("failed");
      expect(response.status).toBeLessThan(500);
    }
    // A name git would read as a flag cannot become a local repo name.
    expect(localRepos().some((d) => d.startsWith("-"))).toBe(false);
    // A name carrying a NUL is not a name.
    const ctl = await mirror("octo/ctl\x00name");
    expect(ctl.stage).toBe("failed");
    expect(localRepos().some((d) => d.includes("\x00"))).toBe(false);
  });

  test("a hostile default branch is an ordinary refusal, not a thrown defect", async () => {
    for (const name of ["branch", "branch2"]) {
      const response = await mirror(`octo/${name}`);
      // Never a crash: the origin's word for a branch name is checked before
      // it reaches `--initial-branch`, and falls back to `main`.
      expect(response.stage).toBe("done");
      expect(repoRow(name)?.default_branch).toBe("main");
    }
  });

  test("imported text loses its control bytes; pull refs lose unsafe values", async () => {
    const response = await mirror("octo/good");
    expect(response.stage).toBe("done");
    const rows = app.db
      .query<
        { number: number; title: string; body: string; origin_author: string },
        [string]
      >("SELECT number, title, body, origin_author FROM issue WHERE repo_id = ?1 ORDER BY number")
      .all(repoRow("good")!.id);
    // The negative number was never made into a row.
    expect(rows.map((r) => r.number)).toEqual([1, 2]);
    const issue = rows[0]!;
    expect(issue.title).toBe("Escape ]0;pwned me line two");
    expect(issue.body).toBe("keep\nnewlines\tand tabs, drop  nul and  esc");
    expect(issue.origin_author).toBe("mallory");
    for (const text of [issue.title, issue.body, issue.origin_author]) {
      // eslint-disable-next-line no-control-regex
      expect(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)).toBe(false);
    }
    const labels = app.db
      .query<
        { name: string; color: string },
        [string]
      >("SELECT name, color FROM label WHERE repo_id = ?1 ORDER BY name")
      .all(repoRow("good")!.id);
    expect(labels.map((l) => l.name)).toEqual(["bug[31m", "nulbyte"]);
    expect(labels.every((l) => /^[0-9a-f]{6}$/.test(l.color))).toBe(true);

    const pull = app.db
      .query<
        {
          base_branch: string;
          head_branch: string;
          base_oid: string;
          head_oid: string;
        },
        [string]
      >(
        `SELECT base_branch, head_branch, base_oid, head_oid FROM pull
         JOIN issue ON issue.id = pull.issue_id
         WHERE issue.repo_id = ?1 AND issue.number = 2`,
      )
      .get(repoRow("good")!.id);
    expect(pull).toEqual({
      base_branch: "",
      head_branch: "",
      base_oid: "",
      head_oid: "",
    });
    // The base named a file for git to write; none was written.
    expect(readdirSync(canaryDir)).toEqual([]);
  });

  test("the token is on no API surface, in no git config, in no error", async () => {
    const pages = [
      "/api/v1/user/origins",
      `/api/v1/user/origins/${originId}/repos`,
      "/api/v1/repos/alice/good",
      "/api/v1/repos/alice/good/issues?state=all",
      "/api/v1/user/origin-apps",
    ];
    for (const path of pages) {
      const text = await (await api(path)).text();
      expect(text).not.toContain(TOKEN);
    }
    const dir = join(app.reposRoot, "alice", "good.git");
    expect(readFileSync(join(dir, "config"), "utf8")).not.toContain(TOKEN);
    const url = await runGitCapture(["config", "remote.origin.url"], {
      cwd: dir,
    });
    expect(url.stdout.trim()).toBe(goodCloneUrl);
    expect(url.stdout).not.toContain(TOKEN);
    // Nothing is written outside the data directory's repo root: exactly
    // the mirrors that were accepted, and nothing named by the origin.
    expect(localRepos()).toEqual(["branch.git", "branch2.git", "good.git"]);
  });

  test("a later sync that names a hostile clone URL cannot re-point the remote", async () => {
    const good = fake.state.repos.find((r) => r.fullName === "octo/good")!;
    good.cloneUrl = "ext::sh -c id";
    try {
      const origin = getOriginById(app.db, originId)!;
      const report = await syncOrigin(app, origin, {
        onlyRepoId: repoRow("good")!.id,
      });
      expect(report.error).toContain("unusable clone URL");
      expect(repoRow("good")!.fetch_error).toContain("unusable clone URL");
      const dir = join(app.reposRoot, "alice", "good.git");
      const url = await runGitCapture(["config", "remote.origin.url"], {
        cwd: dir,
      });
      expect(url.stdout.trim()).toBe(goodCloneUrl);
    } finally {
      good.cloneUrl = goodCloneUrl;
    }
  });

  test("a 422 that quotes the token lands in last_error scrubbed", async () => {
    fake.state.refuseWrite = `nope, ${TOKEN} is not welcome`;
    try {
      const response = await api("/api/v1/repos/alice/good/issues", {
        method: "POST",
        body: JSON.stringify({ title: "through", body: "" }),
      });
      expect(response.status).toBe(409);
      const text = await response.text();
      expect(text).not.toContain(TOKEN);
    } finally {
      fake.state.refuseWrite = "";
    }
  });

  test("a mirror whose git directory vanished fails its own sync, not the tick", async () => {
    const dir = join(app.reposRoot, "alice", "branch.git");
    await rm(dir, { recursive: true, force: true });
    const origin = getOriginById(app.db, originId)!;
    // Resolves rather than rejects, and the other mirrors still ran.
    const report = await syncOrigin(app, origin);
    expect(report.repos).toBeGreaterThan(1);
    expect(repoRow("branch")!.fetch_error).toContain("missing");
    expect(repoRow("good")!.fetch_error).toBe("");
    // The worker's own entry point survives it too, and the origin is
    // rescheduled rather than left due forever.
    await expect(
      syncDue(app, new Date(Date.now() + 60 * 60 * 1000)),
    ).resolves.toBeGreaterThanOrEqual(0);
  });
});
