import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { forkDeadline } from "../src/actions/contribute.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { firstFetchRetry } from "../src/origins/mirror.ts";
import {
  mirrorAndWait,
  newFakeState,
  serveFakeForge,
  type FakeForge,
} from "./fake-origin.ts";
import { proveAll } from "./helpers/verified.ts";
import { promote } from "./helpers/members.ts";
import { tokenFor } from "./helpers/tokens.ts";

/**
 * `contribute` to a repository the caller cannot push to makes a fork first.
 * When the fork never appears (`fork_timeout`) or its local mirror cannot be
 * made (`mirror_failed`), the answer is a refusal in words and nothing is
 * half-made: no branch, commit or pull at the origin, no new repository here.
 */

const ME = "me";
const OWNER = "octo";
const PASSWORD = "fork-failures-pass";

const read = async <T>(response: Response): Promise<T> =>
  (await response.json()) as T;

describe("contribute when the fork fails", () => {
  let dataDir = "";
  let originDataDir = "";
  let app: App;
  let servers: Servers;
  let originApp: App;
  let originServers: Servers;
  let fake: FakeForge;
  let aliceToken = "";
  let mirrorPath = "";
  const found = {
    deadline: forkDeadline.ms,
    retry: firstFetchRetry.ms,
  };

  const mkAccount = async (server: Servers, username: string) => {
    await fetch(`${server.url}/api/v1/users`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username,
        email: `${username}@f.dev`,
        password: PASSWORD,
      }),
    });
    return tokenFor(server === originServers ? originApp : app, username, "admin");
  };

  const contribute = (): Promise<Response> =>
    fetch(`${servers.url}/api/v1/repos/${mirrorPath}/contribute`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${aliceToken}`,
      },
      body: JSON.stringify({
        branch: "fix-typo",
        message: "fix",
        files: [{ path: "a.txt", content: "one, fixed\n" }],
        openPull: { title: "fix" },
      }),
    });

  const count = (sql: string): number =>
    app.db.query<{ n: number }, []>(sql).get()?.n ?? -1;

  const localDirs = async (): Promise<string[]> => {
    const out: string[] = [];
    const root = join(dataDir, "repos");
    for (const owner of await readdir(root))
      for (const name of await readdir(join(root, owner)))
        out.push(`${owner}/${name}`);
    return out.sort();
  };

  /** Everything a half-made contribution would have left behind. */
  const world = async () => ({
    fakeBranches: [...fake.state.branches.entries()],
    fakeCommits: [...fake.state.commits.entries()],
    fakeWrites: fake.state.requests.filter(
      (r) => r.method !== "GET" && !r.path.endsWith("/forks"),
    ).length,
    repos: count("SELECT COUNT(*) AS n FROM repo"),
    pulls: count("SELECT COUNT(*) AS n FROM pull"),
    dirs: await localDirs(),
  });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-cff-"));
    originDataDir = await mkdtemp(join(tmpdir(), "forge-cff-up-"));

    originApp = createApp({ dataDir: originDataDir, port: 0 });
    originServers = await serve(originApp);
    await mkAccount(originServers, OWNER);
    const originToken = await mkAccount(originServers, ME);
    proveAll(originApp);
    promote(originApp.db);

    const as = `Basic ${Buffer.from(`${OWNER}:${PASSWORD}`).toString("base64")}`;
    const up = (path: string, body: unknown) =>
      fetch(`${originServers.url}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: as },
        body: JSON.stringify(body),
      });
    await up("/api/v1/repos", { name: "gears", visibility: "public" });
    await up(`/api/v1/repos/${OWNER}/gears/contents`, {
      branch: "main",
      message: "first",
      files: [{ path: "a.txt", content: "one\n" }],
    });

    const state = newFakeState("forgejo", ME, originToken);
    state.repos.push({
      id: 1,
      fullName: `${OWNER}/gears`,
      cloneUrl: `${originServers.url}/${OWNER}/gears.git`,
      defaultBranch: "main",
      push: false,
      admin: false,
    });
    fake = serveFakeForge(state);

    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    aliceToken = await mkAccount(servers, "alice");
    proveAll(app);
    promote(app.db);

    const headers = {
      "content-type": "application/json",
      authorization: `Bearer ${aliceToken}`,
    };
    const connected = await fetch(`${servers.url}/api/v1/user/origins`, {
      method: "POST",
      headers,
      body: JSON.stringify({ host: fake.url, token: originToken }),
    });
    expect(connected.status).toBe(201);
    const originId = (await read<{ id: string }>(connected)).id;
    const job = await mirrorAndWait(
      await fetch(`${servers.url}/api/v1/user/origins/${originId}/mirror`, {
        method: "POST",
        headers,
        body: JSON.stringify({ fullName: `${OWNER}/gears` }),
      }),
    );
    expect(job?.stage).toBe("done");
    mirrorPath = `${job!.repo!.ownerName}/${job!.repo!.name}`;

    // Shortened for the tests below; put back in afterAll.
    forkDeadline.ms = 100;
    firstFetchRetry.ms = [];
  });

  afterAll(async () => {
    forkDeadline.ms = found.deadline;
    firstFetchRetry.ms = found.retry;
    fake.stop();
    servers.stop();
    originServers.stop();
    app.close();
    originApp.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(originDataDir, { recursive: true, force: true });
  });

  test("a fork that never appears is `fork_timeout`, and nothing is made", async () => {
    fake.state.forkDelayReads = 1_000_000;
    const before = await world();
    const started = Date.now();
    const response = await contribute();
    expect(Date.now() - started).toBeLessThan(5_000);

    expect(response.status).toBe(504);
    const refusal = await read<{ error: string; message: string }>(response);
    expect(refusal.error).toBe("fork_timeout");
    expect(refusal.message).toContain("fork has not appeared");
    expect(await world()).toEqual(before);
    // The origin was asked to fork, and that is all it was asked.
    expect(
      fake.state.requests.some((r) => r.method === "POST" && r.path.endsWith("/forks")),
    ).toBe(true);
    expect(fake.state.pendingForks.size).toBeGreaterThan(0);
  });

  test("a fork whose clone fails is `mirror_failed`, and no mirror is left behind", async () => {
    fake.state.pendingForks.clear();
    fake.state.forkDelayReads = 0;
    // (The first test left the fork the origin made, hidden behind its delay.)
    const fork = fake.state.repos.find((r) => r.fullName === `${ME}/gears`);
    expect(fork).toBeDefined();
    fork!.cloneUrl = "http://127.0.0.1:1/me/gears.git";
    const before = await world();
    const response = await contribute();

    expect(response.status).toBe(502);
    const refusal = await read<{ error: string; message: string }>(response);
    expect(refusal.error).toBe("mirror_failed");
    expect(refusal.message).toContain("local copy");
    expect(await world()).toEqual(before);
    expect(existsSync(join(dataDir, "repos", "alice", "gears"))).toBe(false);

    // Nothing stands in the way of trying again once the fork's git answers.
    fork!.cloneUrl = `${originServers.url}/${OWNER}/gears.git`.replace(
      `/${OWNER}/`,
      `/${ME}/`,
    );
    await fetch(`${originServers.url}/api/v1/repos/${OWNER}/gears/forks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Basic ${Buffer.from(`${ME}:${PASSWORD}`).toString("base64")}`,
      },
      body: "{}",
    });
    expect((await contribute()).status).toBe(201);
  });
});
