/**
 * A read-only origin's mirrors show on their owner's profile as
 * "work (read-only)" with the last fetch and, on failure, one plain line
 * (#10522); and the scheduled sync lands commits, branches, open and merged
 * pulls and reviews from a fake remote.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { getOriginById } from "../src/core/origins.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { syncOrigin, syncsSettled } from "../src/origins/sync.ts";
import { workLines } from "../src/tui/screens/work.ts";
import { gitFailureWords, readOnlyWork } from "../src/origins/read-only-work.ts";
import { mirrorAndWait, newFakeState, serveFakeForge, type FakeForge } from "./fake-origin.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { proveAll } from "./helpers/verified.ts";

setDefaultTimeout(60_000);

const LOGIN = "octo";
const TOKEN = "octo-profile-secret-5c1d";
const PASSWORD = "alice-login-secret";
const NAME = "quillmoth";
const FULL = `octo/${NAME}`;
const basic = (u: string, p: string) => `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}`;

describe("work (read-only) on the owner's profile", () => {
  const dirs: string[] = [];
  let app: App;
  let servers: Servers;
  let originApp: App;
  let originServers: Servers;
  let fake: FakeForge;
  let originId = "";
  const cookies: Record<string, string> = {};

  const api = (path: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set("content-type", "application/json");
    headers.set("authorization", basic("alice", PASSWORD));
    return fetch(`${servers.url}${path}`, { ...init, headers });
  };
  const as = (who: string, path: string) =>
    fetch(`${servers.url}${path}`, {
      headers: cookies[who] === undefined ? {} : { cookie: cookies[who]! },
    });
  const sweep = async () => {
    const origin = getOriginById(app.db, originId)!;
    await syncOrigin(app, origin);
    await syncsSettled();
  };

  beforeAll(async () => {
    for (const p of ["forge-rop2-", "forge-rop2-up-"]) dirs.push(await mkdtemp(join(tmpdir(), p)));
    originApp = createApp({ dataDir: dirs[1]!, port: 0 });
    originServers = await serve(originApp);
    await seedAdmin(originApp, { username: LOGIN, email: "octo@up.test", password: TOKEN });
    const oh = { "content-type": "application/json", authorization: basic(LOGIN, TOKEN) };
    await fetch(`${originServers.url}/api/v1/repos`, {
      method: "POST",
      headers: oh,
      body: JSON.stringify({ name: NAME, visibility: "public" }),
    });
    for (const [branch, message, path] of [
      ["main", "zephyrmarker first commit", "a.txt"],
      ["main", "second upstream commit", "b.txt"],
      ["feature-x", "work on the feature", "c.txt"],
    ] as const) {
      const r = await fetch(`${originServers.url}/api/v1/repos/${FULL}/contents`, {
        method: "POST",
        headers: oh,
        body: JSON.stringify({ branch, message, files: [{ path, content: "one\n" }] }),
      });
      expect(r.status, message).toBeLessThan(300);
    }
    const state = newFakeState("github", LOGIN, TOKEN);
    state.repos.push({
      id: 9,
      fullName: FULL,
      cloneUrl: `${originServers.url}/${FULL}.git`,
      defaultBranch: "main",
      htmlUrl: `${originServers.url}/${FULL}`,
      push: true,
    });
    const at = "2026-01-01T00:00:00.000Z";
    state.issues.set(FULL, [
      { id: 100, number: 1, title: "Open pull upstream", user: "mona", createdAt: at, updatedAt: at, pull: { base: "main", head: "feature-x", headRepo: FULL } },
      { id: 101, number: 2, title: "Merged pull upstream", user: "hubot", state: "closed", createdAt: at, updatedAt: at, closedAt: at, pull: { base: "main", head: "feature-x", headRepo: FULL, mergedAt: at } },
    ]);
    state.reviews.set(FULL, [
      { id: 500, issueNumber: 1, body: "inline remark", user: "mona", path: "c.txt", diffHunk: "@@ -0,0 +1 @@", line: 1, side: "RIGHT" },
    ]);
    state.reviewStates.set(FULL, [
      { id: 600, issueNumber: 1, user: "hubot", state: "APPROVED", body: "ship it", submittedAt: at },
    ]);
    fake = serveFakeForge(state);

    app = createApp({ dataDir: dirs[0]!, port: 0 });
    servers = await serve(app);
    const made = await seedAdmin(app, { username: "alice", email: "alice@forge.test", password: PASSWORD });
    if (!made.ok) throw new Error(made.error);
    const bob = await createUser(app.db, { username: "bob", email: "bob@forge.test", password: "a-good-passphrase", origin: "seed", trusted: true });
    if (!bob.ok) throw new Error("users");
    cookies["owner"] = `forge_session=${createSession(app.db, made.value.id).token}`;
    cookies["stranger"] = `forge_session=${createSession(app.db, bob.value.id).token}`;

    const connected = (await (
      await api("/api/v1/user/origins", {
        method: "POST",
        body: JSON.stringify({ host: fake.url, kind: "github", token: TOKEN, readOnly: true }),
      })
    ).json()) as { id: string };
    originId = connected.id;
    await mirrorAndWait(
      await api(`/api/v1/user/origins/${originId}/mirror`, { method: "POST", body: JSON.stringify({ fullName: FULL }) }),
    );
    await syncsSettled();
    proveAll(app);
  });

  afterAll(async () => {
    await syncsSettled();
    fake.stop();
    servers.stop();
    originServers.stop();
    app.close();
    originApp.close();
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  test("a scheduled sweep lands commits, branches, open and merged pulls and reviews", async () => {
    await sweep();
    const commits = (await (await api(`/api/v1/repos/alice/${NAME}/commits?ref=main`)).json()) as { items?: { message: string }[] };
    const text = JSON.stringify(commits);
    expect(text).toContain("second upstream commit");
    expect(text).toContain("zephyrmarker");
    const branches = await (await api(`/api/v1/repos/alice/${NAME}/branches`)).text();
    expect(branches).toContain("feature-x");
    const pulls = (await (await api(`/api/v1/repos/alice/${NAME}/pulls?state=all`)).json()) as {
      items: { number: number; state: string; mergedAt?: string }[];
    };
    const byNumber = new Map(pulls.items.map((p) => [p.number, p]));
    expect(byNumber.get(1)?.state).toBe("open");
    expect(byNumber.get(2)).toMatchObject({ state: "closed", mergedAt: "2026-01-01T00:00:00.000Z" });
    const comment = app.db.query("SELECT body FROM comment WHERE body = 'inline remark'").get();
    expect(comment).not.toBeNull();
    const review = app.db.query("SELECT state FROM review").all();
    expect(review.length).toBe(1);
  });

  test("the owner sees work (read-only) with its last fetch; nobody else sees the section", async () => {
    const mine = await (await as("owner", "/alice")).text();
    expect(mine).toContain("work (read-only)");
    expect(mine).toContain(FULL);
    expect(mine).toContain("Last fetch");
    expect(mine).not.toContain("Last fetch failed");
    for (const who of ["stranger", "anonymous"]) {
      const body = await (await as(who, "/alice")).text();
      expect(body, who).not.toContain("work (read-only)");
      expect(body, who).not.toContain(FULL);
    }
    expect(readOnlyWork(app.db, "someone-else")).toEqual([]);
    // Once: the mirror is not also listed under Repositories.
    expect(mine.split(`href="/alice/${NAME}"`).length - 1).toBe(1);
  });

  test("the terminal screen carries the same lines", () => {
    const alice = app.db.query<{ id: string }, []>("SELECT id FROM user WHERE username = 'alice'").get()!;
    const text = workLines(readOnlyWork(app.db, alice.id)).join("\n");
    expect(text).toContain(FULL);
    expect(text).toMatch(/Last fetch /);
    expect(workLines([])).toEqual(["Nothing mirrored from a read-only origin."]);
  });

  test("a refused token is explained in one line, not a stack", async () => {
    fake.state.token = "rotated-away";
    await sweep();
    const mine = await (await as("owner", "/alice")).text();
    expect(mine).toContain("Last fetch failed: the token was refused");
    expect(mine).not.toMatch(/\bat \S+\.ts:\d+/);
    fake.state.token = TOKEN;
  });

  test("a repository that is gone is explained", async () => {
    const kept = fake.state.repos.splice(0);
    await sweep();
    const mine = await (await as("owner", "/alice")).text();
    expect(mine).toContain("Last fetch failed: the repository is gone");
    fake.state.repos.push(...kept);
    await sweep();
    expect(await (await as("owner", "/alice")).text()).not.toContain("Last fetch failed");
  });

  test("git's own complaints become one line", () => {
    expect(gitFailureWords("fatal: Authentication failed for 'x'")).toContain("token was refused");
    expect(gitFailureWords("fatal: repository 'x' not found")).toContain("gone");
    expect(gitFailureWords("fatal: unable to access: Could not resolve host")).toContain("could not be reached");
    expect(gitFailureWords("something\n  at stack.ts:1")).not.toContain("\n");
  });
});
