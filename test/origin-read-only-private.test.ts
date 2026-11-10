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
import { createAgentRow } from "../src/core/agents.ts";
import { createUser } from "../src/core/users.ts";
import { getRepo } from "../src/core/repos.ts";
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
    if (crew.ok) createAgentRow(app.db, { userId: crew.value.id, brief: "builds." });
    if (!bob.ok || !crew.ok) throw new Error("users");
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
  ];

  for (const who of ["anonymous", "stranger", "agent"]) {
    test(`${who} finds no trace of its name or commits`, async () => {
      for (const path of listings) {
        const res = await as(who, path);
        const body = await res.text();
        expect(body, `${who} ${path}`).not.toContain(NAME);
        expect(body, `${who} ${path}`).not.toContain("zephyrmarker");
      }
    });
  }

  for (const who of ["anonymous", "stranger", "agent"]) {
    test(`${who} is told the repository does not exist`, async () => {
      expect((await as(who, `/alice/${NAME}`)).status).toBe(404);
      expect((await as(who, `/api/v1/repos/alice/${NAME}`)).status).toBe(404);
    });
  }

  test("the owner finds it", async () => {
    for (const path of ["/search?q=quillmo", "/api/v1/search?q=quillmo&kind=all", `/search?q=${NAME}`, `/api/v1/search?q=${NAME}&kind=all`, "/alice", `/alice/${NAME}`, `/api/v1/repos/alice/${NAME}`]) {
      const res = await as("owner", path);
      expect(res.status, path).toBeLessThan(300);
      expect(await res.text(), path).toContain(NAME);
    }
  });
});
