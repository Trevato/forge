/**
 * A repository mirrored from a read-only origin is private to its owner
 * everywhere (#10520): created private, refused a public visibility, and
 * absent from every list a stranger or a crew agent can read, while its
 * owner finds it. The origin's repo is public, so only the read-only flag
 * can be what keeps the mirror closed.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { createAgentRow, type Agent } from "../src/core/agents.ts";
import { createUser } from "../src/core/users.ts";
import { createIssue } from "../src/core/issues.ts";
import { getRepo } from "../src/core/repos.ts";
import { repoDir } from "../src/git/repos.ts";
import { systemPrompt, taskPrompt } from "../src/crew/brief.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { syncsSettled } from "../src/origins/sync.ts";
import { mirrorAndWait, newFakeState, serveFakeForge, type FakeForge } from "./fake-origin.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { proveAll } from "./helpers/verified.ts";

setDefaultTimeout(60_000);

const LOGIN = "octo";
const TOKEN = "octo-private-secret-7e2a";
const PASSWORD = "alice-login-secret";
const NAME = "quillmoth";
const COMMIT = "zephyrmarker first commit";
const basic = (u: string, p: string) => `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}`;

describe("a mirror of a read-only origin is private to its owner", () => {
  const dirs: string[] = [];
  let app: App;
  let servers: Servers;
  let originApp: App;
  let originServers: Servers;
  let fake: FakeForge;
  let originId = "";
  const cookies: Record<string, string> = {};
  let commit = "";
  let crewAgent: Agent;

  const api = (path: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set("content-type", "application/json");
    headers.set("authorization", basic("alice", PASSWORD));
    return fetch(`${servers.url}${path}`, { ...init, headers });
  };
  const as = (who: string, path: string) =>
    fetch(`${servers.url}${path}`, {
      headers: cookies[who] === undefined ? {} : { cookie: cookies[who]! },
      redirect: "manual",
    });

  beforeAll(async () => {
    for (const p of ["forge-rop-", "forge-rop-up-"]) dirs.push(await mkdtemp(join(tmpdir(), p)));
    originApp = createApp({ dataDir: dirs[1]!, port: 0 });
    originServers = await serve(originApp);
    await seedAdmin(originApp, { username: LOGIN, email: "octo@up.test", password: TOKEN });
    const oh = { "content-type": "application/json", authorization: basic(LOGIN, TOKEN) };
    await fetch(`${originServers.url}/api/v1/repos`, {
      method: "POST",
      headers: oh,
      body: JSON.stringify({ name: NAME, visibility: "public" }),
    });
    await fetch(`${originServers.url}/api/v1/repos/octo/${NAME}/contents`, {
      method: "POST",
      headers: oh,
      body: JSON.stringify({ branch: "main", message: COMMIT, files: [{ path: "a.txt", content: "one\n" }] }),
    });
    const state = newFakeState("github", LOGIN, TOKEN);
    state.repos.push({
      id: 9,
      fullName: `octo/${NAME}`,
      cloneUrl: `${originServers.url}/octo/${NAME}.git`,
      defaultBranch: "main",
      htmlUrl: `${originServers.url}/octo/${NAME}`,
      push: true,
    });
    fake = serveFakeForge(state);

    app = createApp({ dataDir: dirs[0]!, port: 0 });
    servers = await serve(app);
    const made = await seedAdmin(app, { username: "alice", email: "alice@forge.test", password: PASSWORD });
    if (!made.ok) throw new Error(made.error);
    const bob = await createUser(app.db, { username: "bob", email: "bob@forge.test", password: "a-good-passphrase", origin: "seed", trusted: true });
    const crew = await createUser(app.db, { username: "crewmate", email: "crew@forge.test", agent: true, origin: "agent" });
    if (!bob.ok || !crew.ok) throw new Error("users");
    crewAgent = createAgentRow(app.db, { userId: crew.value.id, brief: "builds." });
    cookies["owner"] = `forge_session=${createSession(app.db, made.value.id).token}`;
    cookies["stranger"] = `forge_session=${createSession(app.db, bob.value.id).token}`;
    cookies["agent"] = `forge_session=${createSession(app.db, crew.value.id).token}`;

    const connected = (await (
      await api("/api/v1/user/origins", {
        method: "POST",
        body: JSON.stringify({ host: fake.url, kind: "github", token: TOKEN, readOnly: true }),
      })
    ).json()) as { id: string };
    originId = connected.id;
    await mirrorAndWait(
      await api(`/api/v1/user/origins/${originId}/mirror`, {
        method: "POST",
        body: JSON.stringify({ fullName: `octo/${NAME}` }),
      }),
    );
    await syncsSettled();
    // A public repository beside it, so a count has something true to count.
    await api("/api/v1/repos", { method: "POST", body: JSON.stringify({ name: "openbox", visibility: "public" }) });
    const head = Bun.spawnSync(["git", "-C", repoDir(app.reposRoot, "alice", NAME), "rev-parse", "HEAD"]);
    commit = head.stdout.toString().trim();
    // An issue of its own, so the feeds and searches have a word to leak.
    createIssue(app.db, { repoId: getRepo(app.db, "alice", NAME)!.id, authorId: made.value.id, title: "zephyrissue to fix", body: "zephyrissue body" });
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

  test("it is created private although its origin repo is public", () => {
    const repo = getRepo(app.db, "alice", NAME);
    expect(repo).toBeDefined();
    expect(repo!.visibility).toBe("private");
  });

  test("it cannot be made public while the origin is read-only", async () => {
    const res = await api(`/api/v1/repos/alice/${NAME}`, {
      method: "PATCH",
      body: JSON.stringify({ visibility: "public" }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("origin_read_only");
    expect(getRepo(app.db, "alice", NAME)!.visibility).toBe("private");
  });

  const listings = [
    "/",
    "/explore",
    "/api/v1/explore",
    "/search?q=quillmo",
    "/api/v1/search?q=quillmo&kind=all",
    "/api/v1/search?q=zephyrm&kind=all",
    "/changelog",
    "/changelog.atom",
    "/api/v1/changelog",
    "/talk",
    "/alice",
    "/api/v1/users/alice/repos",
    "/api/v1/repos",
    "/api/v1/apps",
    "/api/v1/front",
    "/api/v1/forge",
    "/api/v1/map",
    "/api/v1/here",
    "/api/v1/users",
    "/api/v1/users/alice",
    "/api/v1/crew/now",
    "/api/v1/thoughts",
    "/api/v1/family",
    "/api/v1/fleet/rows",
    "/api/v1/telemetry/home",
    "/apps",
    "/crew",
    "/map",
    "/roadmap",
    "/people",
    "/llms.txt",
    "/sitemap.xml",
    "/feed",
    "/explore?sort=new",
    "/explore?q=quillmo",
    "/api/v1/explore?q=quillmo",
    "/api/v1/users/alice/repos?q=quillmo",
    "/talk?about=alice/quillmo",
    "/changelog?q=zephyrm",
    "/flow",
    "/flows",
    "/returns",
    "/next",
    "/now",
    "/week",
    "/waves",
    "/pulls",
    "/releases",
    "/bets",
    "/traffic",
    "/usage",
    "/api/v1/returns",
    "/api/v1/fleet/graph",
    "/api/v1/fleet/ops",
    "/api/v1/crew/scorecard",
    "/api/v1/usage",
    "/search?q=zephyrm",
    "/api/v1/search?q=zephyris&kind=all",
    "/search?q=zephyris",
    "/changelog?q=zephyris",
  ];

  for (const who of ["anonymous", "stranger", "agent"]) {
    test(`${who} finds no trace of its name or commits`, async () => {
      const leaks: string[] = [];
      for (const path of listings) {
        const body = await (await as(who, path)).text();
        if (body.includes(NAME) || body.includes("zephyrmarker") || body.includes("zephyrissue")) leaks.push(path);
      }
      expect(leaks).toEqual([]);
    });
  }

  test("the mirror has a commit id to leak, and no listing shows it", async () => {
    expect(commit).toMatch(/^[0-9a-f]{40}$/);
    for (const who of ["anonymous", "stranger", "agent"])
      for (const path of listings) {
        const body = await (await as(who, path)).text();
        expect(body.includes(commit) || body.includes(commit.slice(0, 7)), `${who} ${path}`).toBe(false);
      }
  });

  test("counts leave it out: filtered before counted", async () => {
    for (const who of ["anonymous", "stranger", "agent"]) {
      const repos = (await (await as(who, "/api/v1/users/alice/repos")).json()) as { items: unknown[] };
      expect(JSON.stringify(repos), who).toContain("openbox");
      expect(repos.items.length, who).toBe(1);
      const explore = (await (await as(who, "/api/v1/explore")).json()) as { items: unknown[] };
      expect(explore.items.length, who).toBeLessThanOrEqual(1);
    }
    const owner = (await (await as("owner", "/api/v1/users/alice/repos")).json()) as { items: unknown[] };
    expect(owner.items.length).toBe(2);
  });

  test("a crew brief for a run on another repository names nothing of the mirror", () => {
    const repo = getRepo(app.db, "alice", "openbox")!;
    const made = createIssue(app.db, { repoId: repo.id, authorId: repo.ownerId, title: "Make the box open", body: "It stays shut." });
    if (!made.ok) throw new Error(made.error);
    const input = {
      agent: crewAgent,
      repo,
      issue: made.value,
      branch: "crewmate/1",
      forgeUrl: "http://forge.test",
      isApp: false,
      resuming: false,
    };
    const system = systemPrompt(input);
    const task = taskPrompt({ ...input, reason: "assigned", comments: [], reviews: [], reviewComments: [], since: "" });
    // The brief is real: it names the repository the run is on.
    expect(system).toContain("alice/openbox");
    expect(task).toContain("Make the box open");
    for (const text of [system, task]) {
      expect(text).not.toContain(NAME);
      expect(text).not.toContain("zephyr");
      expect(text).not.toContain(commit);
    }
  });

  for (const who of ["anonymous", "stranger", "agent"]) {
    test(`${who} is told the repository does not exist`, async () => {
      expect((await as(who, `/alice/${NAME}`)).status).toBe(404);
      expect((await as(who, `/api/v1/repos/alice/${NAME}`)).status).toBe(404);
    });
  }

  test("the owner finds the same reads: changelog, Talk, issue title and commit id", async () => {
    const found = async (path: string) => (await as("owner", path)).text();
    expect(await found("/api/v1/search?q=zephyrissue&kind=all")).toContain(NAME);
    expect(await found("/search?q=zephyrm")).toContain(NAME);
    expect(await found("/search?q=zephyris")).toContain(NAME);
    expect(await found("/changelog?q=zephyrm")).toContain(NAME);
    expect(await found("/changelog?q=zephyris")).toContain(NAME);
    expect(await found("/talk?about=alice/quillmo")).toContain(NAME);
    expect(await found("/explore?q=quillmo")).toContain(NAME);
    expect(await found(`/alice/${NAME}/commits`)).toContain(commit.slice(0, 7));
    expect(await found(`/api/v1/repos/alice/${NAME}/commits`)).toContain(commit);
    expect(await found(`/api/v1/repos/alice/${NAME}/issues`)).toContain("zephyrissue");
  });

  test("the owner finds it", async () => {
    for (const path of ["/search?q=quillmo", "/api/v1/search?q=quillmo&kind=all", `/search?q=${NAME}`, `/api/v1/search?q=${NAME}&kind=all`, "/alice", `/alice/${NAME}`, `/api/v1/repos/alice/${NAME}`]) {
      const res = await as("owner", path);
      expect(res.status, path).toBeLessThan(300);
      expect(await res.text(), path).toContain(NAME);
    }
  });
});
