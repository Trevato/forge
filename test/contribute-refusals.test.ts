import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
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
 * `contribute` refuses up front so nothing is half-made (#6977): every
 * refusal below leaves the origin without a new fork, branch or commit and
 * the forge without a new repository or pull. And the one failure that comes
 * after the commit landed — opening the pull — carries the commit.
 */

const ME = "me";
const OWNER = "octo";
const PASSWORD = "refusals-account-pass";

/**
 * This is the one test that really forks, mirrors and commits through git;
 * on a loaded full-suite machine that outruns bun's 5 s default (#9425).
 */
const SLOW = 30_000;

const read = async <T>(response: Response): Promise<T> =>
  (await response.json()) as T;

describe("contribute refusals", () => {
  let dataDir = "";
  let originDataDir = "";
  let app: App;
  let servers: Servers;
  let originApp: App;
  let originServers: Servers;
  let fake: FakeForge;
  let aliceToken = "";
  let bobToken = "";
  let carolToken = "";
  let originToken = "";
  let mirrorPath = "";

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

  const contribute = (
    body: Record<string, unknown>,
    token: string | null = aliceToken,
  ): Promise<Response> =>
    fetch(`${servers.url}/api/v1/repos/${mirrorPath}/contribute`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify(body),
    });

  const attempt = {
    branch: "fix-typo",
    message: "fix",
    files: [{ path: "a.txt", content: "one, fixed\n" }],
    openPull: { title: "fix" },
  };

  const count = (sql: string): number =>
    app.db.query<{ n: number }, []>(sql).get()?.n ?? -1;

  /** Everything a half-made contribution would have left behind. */
  const world = async () => ({
    fakeRepos: fake.state.repos.map((r) => r.fullName).sort(),
    fakeBranches: [...fake.state.branches.entries()],
    fakeCommits: [...fake.state.commits.entries()],
    fakeWrites: fake.state.requests.filter((r) => r.method !== "GET").length,
    forkBranches: await (
      await fetch(`${originServers.url}/api/v1/repos/${ME}/gears/branches`)
    ).text(),
    repos: count("SELECT COUNT(*) AS n FROM repo"),
    pulls: count("SELECT COUNT(*) AS n FROM pull"),
  });

  const refused = async (
    response: Response,
    status: number,
    code: string,
    before: Awaited<ReturnType<typeof world>>,
  ) => {
    expect(response.status).toBe(status);
    expect((await read<{ error: string }>(response)).error).toBe(code);
    expect(await world()).toEqual(before);
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-cr-"));
    originDataDir = await mkdtemp(join(tmpdir(), "forge-cr-up-"));

    originApp = createApp({ dataDir: originDataDir, port: 0 });
    originServers = await serve(originApp);
    await mkAccount(originServers, OWNER);
    originToken = await mkAccount(originServers, ME);
    proveAll(originApp);
    promote(originApp.db);

    const as = (user: string) =>
      `Basic ${Buffer.from(`${user}:${PASSWORD}`).toString("base64")}`;
    const up = (path: string, user: string, body: unknown) =>
      fetch(`${originServers.url}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: as(user) },
        body: JSON.stringify(body),
      });
    await up("/api/v1/repos", OWNER, { name: "gears", visibility: "public" });
    await up(`/api/v1/repos/${OWNER}/gears/contents`, OWNER, {
      branch: "main",
      message: "first",
      files: [{ path: "a.txt", content: "one\n" }],
    });
    const forked = await up(`/api/v1/repos/${OWNER}/gears/forks`, ME, {});
    expect(forked.status).toBe(201);

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
    bobToken = await mkAccount(servers, "bob");
    proveAll(app);
    promote(app.db);
    // Made after everyone else was proven: this one never is.
    carolToken = await mkAccount(servers, "carol");

    const connected = await fetch(`${servers.url}/api/v1/user/origins`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${aliceToken}`,
      },
      body: JSON.stringify({ host: fake.url, token: originToken }),
    });
    expect(connected.status).toBe(201);
    const originId = (await read<{ id: string }>(connected)).id;
    const job = await mirrorAndWait(
      await fetch(`${servers.url}/api/v1/user/origins/${originId}/mirror`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${aliceToken}`,
        },
        body: JSON.stringify({ fullName: `${OWNER}/gears` }),
      }),
    );
    expect(job?.stage).toBe("done");
    mirrorPath = `${job!.repo!.ownerName}/${job!.repo!.name}`;
  }, SLOW);

  afterAll(async () => {
    fake.stop();
    servers.stop();
    originServers.stop();
    app.close();
    originApp.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(originDataDir, { recursive: true, force: true });
  });

  test("signed out is refused", async () => {
    const before = await world();
    const response = await contribute(attempt, null);
    expect([401, 404]).toContain(response.status);
    expect(await world()).toEqual(before);
  });

  test("an unverified account is `unverified`", async () => {
    const before = await world();
    await refused(await contribute(attempt, carolToken), 403, "unverified", before);
  });

  test("an origin that is not the caller's is `not_found`", async () => {
    const before = await world();
    const response = await contribute(attempt, bobToken);
    expect(response.status).toBe(404);
    expect(await world()).toEqual(before);
  });

  test.each(["refs/heads/x", "a..b", "x/../y"])(
    "branch %p is `invalid_branch`",
    async (branch) => {
      const before = await world();
      await refused(
        await contribute({ ...attempt, branch }),
        422,
        "invalid_branch",
        before,
      );
    },
  );

  test("a base the upstream does not have is `unknown_base`", async () => {
    const before = await world();
    await refused(
      await contribute({ ...attempt, base: "no-such-branch" }),
      422,
      "unknown_base",
      before,
    );
    await refused(
      await contribute({ ...attempt, base: "a..b" }),
      422,
      "unknown_base",
      before,
    );
  });

  test("a pull that cannot open after the commit landed carries the commit", async () => {
    fake.state.refuseWrite = "no pulls today";
    const response = await contribute(attempt);
    fake.state.refuseWrite = "";
    expect(response.status).toBe(422);
    const failed = await read<{
      error: string;
      commit: { commitOid: string };
    }>(response);
    expect(failed.error).toBe("pull_failed");
    expect(failed.commit.commitOid).toMatch(/^[0-9a-f]{40}$/);

    // The commit is not a claim: it is on the fork at the origin.
    const branches = await read<{ items: { name: string; oid: string }[] }>(
      await fetch(`${originServers.url}/api/v1/repos/${ME}/gears/branches`),
    );
    expect(branches.items.find((b) => b.name === "fix-typo")?.oid).toBe(
      failed.commit.commitOid,
    );
  }, SLOW);
});
