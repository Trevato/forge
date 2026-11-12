/**
 * Contributing with read access (owner, 2026-10-16): "If you have code read
 * you can clone or fork; with pull requests you can open a PR." A fork of a
 * mirror proposes upstream through the account's own fork at the origin
 * when it cannot push to the origin repository — and always for a
 * repository the operator protects, which this forge never pushes to.
 *
 * Two real forges and a fake API in front of one of them, as in
 * `fork-flow.test.ts`: the upstream forge is the git host the fake's clone
 * URLs point at, so a push that "landed" can be read back from its repos.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { originPush } from "../src/actions/branches.ts";
import { editFiles } from "../src/actions/contents.ts";
import { contribute } from "../src/actions/contribute.ts";
import { connectOrigin, startMirrorJob } from "../src/actions/origins.ts";
import { openPull } from "../src/actions/pulls.ts";
import { forkRepo } from "../src/actions/repos.ts";
import { proposeUpstream } from "../src/actions/upstream.ts";
import {
  clearCursor,
  getOriginFor,
  mirrorOf,
  type Origin,
} from "../src/core/origins.ts";
import { getForkOf, getRepoById, type Repo } from "../src/core/repos.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { promote } from "./helpers/members.ts";
import { tokenFor } from "./helpers/tokens.ts";
import { resolveOid } from "../src/git/merge.ts";
import { repoDir } from "../src/git/repos.ts";
import { noteGuardPassed, providerForOrigin } from "../src/origins/credential.ts";
import { ensureFork, pushToFork } from "../src/origins/fork-route.ts";
import { settled } from "../src/origins/jobs.ts";
import { carryBranchThrough } from "../src/origins/push-through.ts";
import { fastFirstFetch, quietLogs, withoutEnv } from "./helpers/globals.ts";
import { proveAll } from "./helpers/verified.ts";
import {
  newFakeState,
  serveFakeForge,
  type FakeForge,
  type FakeState,
} from "./fake-origin.ts";

quietLogs();
fastFirstFetch();
withoutEnv("FORGE_ORIGIN_CLIENT_ID", "FORGE_ORIGIN_DENY_PUSH", "FORGE_URL");

const ME = "me";
const UP = "octo";
const PASSWORD = "propose-via-fork-pass";

const basic = (user: string, secret: string): string =>
  `Basic ${Buffer.from(`${user}:${secret}`).toString("base64")}`;

describe("proposing through the account's own fork", () => {
  let upDir: string;
  let upApp: App;
  let up: Servers;
  let dir: string;
  let app: App;
  let servers: Servers;
  let fake: FakeForge;
  let state: FakeState;
  let token = "";
  let alice: User;
  let origin: Origin;

  const upstream = (path: string, as: string, body?: unknown): Promise<Response> =>
    fetch(`${up.url}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", authorization: basic(as, PASSWORD) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  /**
   * An ordinary, proven account on a forge, and a full token for it. Made
   * directly: sign-ups make no admin and are limited per address, and the
   * API mints `admin` tokens for admins only (`test/helpers/tokens.ts`).
   * Not an admin on purpose: the git host must refuse `me` a push to a
   * repository `me` only reads.
   */
  async function account(app: App, username: string): Promise<string> {
    const made = await createUser(app.db, {
      username,
      email: `${username}@p.dev`,
      password: PASSWORD,
      origin: "seed",
      trusted: true,
    });
    if (!made.ok) throw new Error(`no account ${username}: ${made.error}`);
    // A member, as an owner would make it: a guest owns no repository.
    promote(app.db, made.value);
    return tokenFor(app, username, "admin");
  }

  async function seed(name: string, owner = UP): Promise<void> {
    await upstream("/api/v1/repos", owner, { name, visibility: "public" });
    await upstream(`/api/v1/repos/${owner}/${name}/contents`, owner, {
      branch: "main",
      message: "first",
      files: [{ path: "a.txt", content: "one\n" }],
    });
  }

  const git = (owner: string, name: string) => `${up.url}/${owner}/${name}.git`;
  /** Where a branch stands on the upstream forge's own copy of a repository. */
  const tipUp = (owner: string, name: string, branch: string) =>
    resolveOid(repoDir(upApp.reposRoot, owner, name), `refs/heads/${branch}`);
  const asked = (method: string, suffix: string) =>
    state.requests.filter((r) => r.method === method && r.path.endsWith(suffix));
  const lastPullHead = (fullName: string): string =>
    String(
      (JSON.parse(asked("POST", `/repos/${fullName}/pulls`).at(-1)?.body ?? "{}") as {
        head?: string;
      }).head,
    );

  /**
   * The workbench: the origin repo mirrored, forked here, one branch
   * committed. The mirror and the fork are made once and found after, so
   * each test stands alone in any order.
   */
  async function workbench(
    fullName: string,
    branch: string,
  ): Promise<{ mirror: Repo; fork: Repo }> {
    const name = fullName.split("/")[1]!;
    let mirrorId = mirrorOf(app.db, origin.id, fullName);
    if (mirrorId === undefined) {
      const job = startMirrorJob(app, alice, origin.id, fullName, `${name}-mirror`);
      if (!job.ok) throw new Error("mirror refused");
      mirrorId = (await settled(job.value.id))!.repo!.id;
    }
    const mirror = getRepoById(app.db, mirrorId)!;
    let fork = getForkOf(app.db, alice.id, mirror.id);
    if (fork === undefined) {
      const made = await forkRepo(app, alice, mirror, `${name}-work`);
      if (!made.ok) throw new Error(`fork: ${made.error}`);
      fork = made.value;
    }
    const edited = await editFiles(app, alice, fork, {
      newBranch: branch,
      files: [{ path: `${branch}.txt`, content: `${branch}\n` }],
    });
    if (!edited.ok) throw new Error("edit failed");
    return { mirror, fork };
  }

  async function withEnv<T>(name: string, value: string, fn: () => Promise<T>): Promise<T> {
    const before = process.env[name];
    process.env[name] = value;
    try {
      return await fn();
    } finally {
      if (before === undefined) delete process.env[name];
      else process.env[name] = before;
    }
  }

  beforeAll(async () => {
    upDir = await mkdtemp(join(tmpdir(), "forge-pvf-up-"));
    upApp = createApp({ dataDir: upDir, port: 0 });
    up = await serve(upApp);
    await account(upApp, UP);
    token = await account(upApp, ME);
    proveAll(upApp);
    for (const name of ["gears", "widgets", "pushy"]) await seed(name);
    await seed("own", ME);
    // `me` really forks the upstreams it will propose to, so the fork's clone
    // URL is a repository that exists and that `me` may push to.
    for (const name of ["gears", "widgets", "pushy"]) {
      const forked = await upstream(`/api/v1/repos/${UP}/${name}/forks`, ME, {});
      expect(forked.status).toBe(201);
    }

    state = newFakeState("forgejo", ME, token);
    state.repos.push(
      // Read only: the premise.
      { id: 1, fullName: `${UP}/gears`, cloneUrl: git(UP, "gears"), push: false, admin: false },
      { id: 2, fullName: `${UP}/widgets`, cloneUrl: git(UP, "widgets"), push: false, admin: false },
      // The API says yes, git says no: a stale or wrong answer.
      { id: 3, fullName: `${UP}/pushy`, cloneUrl: git(UP, "pushy"), push: true, admin: false },
      { id: 4, fullName: `${ME}/own`, cloneUrl: git(ME, "own"), push: true, admin: true },
      // A name `me` already uses for something that is not a fork.
      { id: 5, fullName: `${UP}/thing`, cloneUrl: git(UP, "gears"), push: false },
      { id: 6, fullName: `${ME}/thing`, cloneUrl: git(ME, "own"), push: true },
      // A fork the account renamed: neither name this forge would guess.
      { id: 7, fullName: `${UP}/renamed`, cloneUrl: git(UP, "gears"), push: false },
      {
        id: 8,
        fullName: `${ME}/a-name-of-its-own`,
        cloneUrl: git(ME, "own"),
        fork: true,
        parent: `${UP}/renamed`,
        push: true,
      },
    );
    fake = serveFakeForge(state);

    dir = await mkdtemp(join(tmpdir(), "forge-pvf-"));
    app = createApp({ dataDir: dir, port: 0 });
    servers = await serve(app);
    await account(app, "alice");
    proveAll(app);
    alice = getUserByName(app.db, "alice")!;
    const connected = await connectOrigin(app, alice, { host: fake.url, token });
    if (!connected.ok) throw new Error("connect failed");
    origin = getOriginFor(app.db, alice.id, connected.value.id)!;
  });

  afterAll(async () => {
    fake.stop();
    servers.stop();
    up.stop();
    app.close();
    upApp.close();
    await rm(dir, { recursive: true, force: true });
    await rm(upDir, { recursive: true, force: true });
  });

  test("a read-only account proposes through its own fork, and the pull's head is <owner>:<branch>", async () => {
    const { mirror, fork } = await workbench(`${UP}/gears`, "topic");
    const pull = await openPull(app, alice, mirror, {
      title: "A change from a reader",
      baseBranch: "main",
      headBranch: "topic",
      headRepo: fork,
    });
    expect(pull.ok).toBe(true);
    expect(asked("POST", `/repos/${UP}/gears/forks`).length).toBeLessThanOrEqual(1);
    expect(lastPullHead(`${UP}/gears`)).toBe(`${ME}:topic`);
    // The branch is in the account's fork, and nowhere near the upstream.
    const tip = await resolveOid(repoDir(app.reposRoot, fork.ownerName, fork.name), "refs/heads/topic");
    expect(await tipUp(ME, "gears", "topic")).toBe(tip!);
    expect(await tipUp(UP, "gears", "topic")).toBeUndefined();
  });

  test("the fork is reused, not made twice", async () => {
    for (const branch of ["second", "third"]) {
      const { mirror, fork } = await workbench(`${UP}/gears`, branch);
      const pull = await openPull(app, alice, mirror, {
        title: `Proposal ${branch}`,
        baseBranch: "main",
        headBranch: branch,
        headRepo: fork,
      });
      expect(pull.ok).toBe(true);
      expect(lastPullHead(`${UP}/gears`)).toBe(`${ME}:${branch}`);
      // However many proposals, one fork was ever asked for.
      expect(asked("POST", `/repos/${UP}/gears/forks`)).toHaveLength(1);
    }
  });

  test("a fork's own default branch goes up under its owner's name, and the page says how", async () => {
    // gears: read-only in every test, so the picker's cache never says
    // otherwise (the protected-repository test lends widgets push rights).
    const { fork } = await workbench(`${UP}/gears`, "unused");
    const landed = await editFiles(app, alice, fork, {
      files: [{ path: "main.txt", content: "on main\n" }],
    });
    expect(landed.ok).toBe(true);
    const page = await (
      await fetch(`${servers.url}/${fork.ownerName}/${fork.name}`, {
        headers: { authorization: basic("alice", PASSWORD) },
      })
    ).text();
    expect(page).toContain("Propose via your fork");
    const proposed = await proposeUpstream(app, alice, fork);
    expect(proposed.ok).toBe(true);
    expect(lastPullHead(`${UP}/gears`)).toBe(`${ME}:alice/main`);
    expect(await tipUp(ME, "gears", "alice/main")).toBeDefined();
    expect(await tipUp(UP, "gears", "alice/main")).toBeUndefined();
  });

  test("an account that can push still pushes directly: no fork", async () => {
    const { mirror, fork } = await workbench(`${ME}/own`, "direct");
    const pull = await openPull(app, alice, mirror, {
      title: "Straight in",
      baseBranch: "main",
      headBranch: "direct",
      headRepo: fork,
    });
    expect(pull.ok).toBe(true);
    expect(asked("POST", `/repos/${ME}/own/forks`)).toHaveLength(0);
    expect(lastPullHead(`${ME}/own`)).toBe("direct");
    expect(await tipUp(ME, "own", "direct")).toBeDefined();
  });

  test("a push the origin refuses falls back to the fork", async () => {
    const { mirror, fork } = await workbench(`${UP}/pushy`, "fallback");
    const pull = await openPull(app, alice, mirror, {
      title: "Said yes, meant no",
      baseBranch: "main",
      headBranch: "fallback",
      headRepo: fork,
    });
    expect(pull.ok).toBe(true);
    expect(await tipUp(UP, "pushy", "fallback")).toBeUndefined();
    expect(asked("POST", `/repos/${UP}/pushy/forks`)).toHaveLength(1);
    expect(lastPullHead(`${UP}/pushy`)).toBe(`${ME}:fallback`);
  });

  test("a protected repository is never pushed to, even by an account that could: always the fork", async () => {
    await withEnv("FORGE_ORIGIN_DENY_PUSH", `${UP}/widgets`, async () => {
      // Checked when it connected; the account gained push rights since.
      noteGuardPassed(app, origin.id);
      state.repos.find((r) => r.fullName === `${UP}/widgets`)!.push = true;
      const { mirror, fork } = await workbench(`${UP}/widgets`, "guarded");
      const forksBefore = asked("POST", `/repos/${UP}/widgets/forks`).length;

      // The direct ways in are refused before anything moves.
      const carried = await carryBranchThrough(app, mirror, fork, "guarded", alice.id);
      expect(!carried.ok && carried.error.message).toContain("protected by this forge's operator");
      const pushed = await originPush(app, alice, mirror);
      expect(!pushed.ok && pushed.error).toBe("origin_protected");

      const pull = await openPull(app, alice, mirror, {
        title: "To a protected repository",
        baseBranch: "main",
        headBranch: "guarded",
        headRepo: fork,
      });
      expect(pull.ok).toBe(true);
      expect(lastPullHead(`${UP}/widgets`)).toBe(`${ME}:guarded`);
      expect(await tipUp(UP, "widgets", "guarded")).toBeUndefined();
      expect(asked("POST", `/repos/${UP}/widgets/forks`).length).toBeLessThanOrEqual(forksBefore + 1);

      // contribute takes its fork path there too.
      const made = await contribute(app, alice, {
        originId: origin.id,
        fullName: `${UP}/widgets`,
        branch: "contributed",
        files: [{ path: "c.txt", content: "c\n" }],
        openPull: { title: "Contributed" },
      });
      expect(made.ok && made.value.via).toBe("fork");
      expect(lastPullHead(`${UP}/widgets`)).toBe(`${ME}:contributed`);
      expect(await tipUp(UP, "widgets", "contributed")).toBeUndefined();
      state.repos.find((r) => r.fullName === `${UP}/widgets`)!.push = false;
    });
  });

  test("a name the account already uses: the fork takes a second name, then is found again", async () => {
    const provider = providerForOrigin(app, origin);
    if (!provider.ok) throw new Error("no provider");
    const first = await ensureFork(app, origin, provider.value, `${UP}/thing`);
    expect(first.ok && first.value.remote.fullName).toBe(`${ME}/${UP}-thing`);
    expect(first.ok && first.value.existed).toBe(false);
    const posts = asked("POST", `/repos/${UP}/thing/forks`).length;
    const again = await ensureFork(app, origin, provider.value, `${UP}/thing`);
    expect(again.ok && again.value.existed).toBe(true);
    expect(asked("POST", `/repos/${UP}/thing/forks`)).toHaveLength(posts);
  });

  test("a fork under a name of its own is found through the upstream's forks, not made again", async () => {
    const provider = providerForOrigin(app, origin);
    if (!provider.ok) throw new Error("no provider");
    const found = await ensureFork(app, origin, provider.value, `${UP}/renamed`);
    expect(found.ok && found.value.existed).toBe(true);
    expect(found.ok && found.value.remote.fullName).toBe(`${ME}/a-name-of-its-own`);
    expect(asked("GET", `/repos/${UP}/renamed/forks`).length).toBeGreaterThan(0);
    expect(asked("POST", `/repos/${UP}/renamed/forks`)).toHaveLength(0);
  });

  test("pushing into the fork asks for itself whether writes are paused", async () => {
    const provider = providerForOrigin(app, origin);
    if (!provider.ok) throw new Error("no provider");
    const fork = await ensureFork(app, origin, provider.value, `${UP}/gears`);
    if (!fork.ok) throw new Error("no fork");
    const { fork: local } = await workbench(`${UP}/gears`, "paused");
    await withEnv("FORGE_ORIGIN_DENY_PUSH", "nobody/nothing", async () => {
      // Guarded now, and never checked: writes wait for a check.
      clearCursor(app.db, origin.id, "guard_checked_at");
      const pushed = await pushToFork(
        app,
        getOriginFor(app.db, alice.id, origin.id)!,
        provider.value,
        fork.value.remote,
        repoDir(app.reposRoot, local.ownerName, local.name),
        "paused",
        "paused",
      );
      expect(!pushed.ok && pushed.error).toContain("writes through it are paused");
    });
    expect(await tipUp(ME, "gears", "paused")).toBeUndefined();
  });

  test("the guard is unchanged: an account that can push to a protected repository is refused", async () => {
    await account(app, "bob");
    proveAll(app);
    const bob = getUserByName(app.db, "bob")!;
    state.repos.find((r) => r.fullName === `${UP}/widgets`)!.push = true;
    const refused = await withEnv("FORGE_ORIGIN_DENY_PUSH", `${UP}/widgets`, () =>
      connectOrigin(app, bob, { host: fake.url, token }),
    );
    state.repos.find((r) => r.fullName === `${UP}/widgets`)!.push = false;
    expect(refused.ok).toBe(false);
    if (!refused.ok && typeof refused.error !== "string")
      expect(refused.error.error).toBe("can_push");
  });
});
