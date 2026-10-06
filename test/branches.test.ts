/**
 * Branches: the unit that was missing, and the one whose absence made the
 * forge unusable for the thing it exists for. Two halves here — a native
 * repo, where a branch is a local ref plus an event, and a mirrored one,
 * where the origin gets the first word and the local ref moves only after.
 *
 * The mirror half runs against a real second forge (its git HTTP endpoint is
 * what we push to) with a fake forge in front of it for the API, because the
 * interesting failures are the ones a stub cannot produce: a ref that
 * already exists upstream, and a lease that therefore loses.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { listEvents } from "../src/core/events.ts";
import { serve, type Servers } from "../src/http/server.ts";
import {
  mirrorAndWait,
  newFakeState,
  serveFakeForge,
  type FakeForge,
} from "./fake-origin.ts";

const read = async <T>(response: Response): Promise<T> =>
  (await response.json()) as T;

interface BranchRow {
  name: string;
  oid: string;
  isDefault: boolean;
  ahead: number | null;
  behind: number | null;
  protected: boolean;
}

describe("branches on a native repo", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let rw = "";
  let admin = "";
  let bob = "";

  const auth = (token: string) => ({
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  });

  const api = (path: string, init?: RequestInit, token = rw) =>
    fetch(`${base}${path}`, { ...init, headers: auth(token) });

  const signUp = async (username: string, password: string, scope: string) => {
    await fetch(`${base}/api/v1/users`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username,
        email: `${username}@forge.test`,
        password,
      }),
    });
    const made = await read<{ token: string }>(
      await fetch(`${base}/api/v1/tokens`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ adminConfirm: true, username, password, name: scope, scope }),
      }),
    );
    return made.token;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-branches-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;

    rw = await signUp("alice", "alice-branch-secret", "rw");
    admin = await read<{ token: string }>(
      await fetch(`${base}/api/v1/tokens`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ adminConfirm: true,
          username: "alice",
          password: "alice-branch-secret",
          name: "a",
          scope: "admin",
        }),
      }),
    ).then((t) => t.token);
    bob = await signUp("bob", "bob-branch-secret", "rw");

    await api("/api/v1/repos", {
      method: "POST",
      body: JSON.stringify({ name: "app", visibility: "public" }),
    });
    await api("/api/v1/repos/alice/app/contents", {
      method: "POST",
      body: JSON.stringify({
        branch: "main",
        message: "first",
        files: [{ path: "a.txt", content: "one\n" }],
      }),
    });
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const branches = async (): Promise<BranchRow[]> =>
    read<BranchRow[]>(await api("/api/v1/repos/alice/app/branches"));

  const create = (payload: unknown) =>
    api("/api/v1/repos/alice/app/branches", {
      method: "POST",
      body: JSON.stringify(payload),
    });

  test("a branch is created at the default branch's tip", async () => {
    const before = await branches();
    const main = before.find((b) => b.isDefault);
    expect(main).toBeDefined();

    const response = await create({ name: "feat/x" });
    expect(response.status).toBe(201);
    const created = await read<{ name: string; oid: string }>(response);
    expect(created.name).toBe("feat/x");
    expect(created.oid).toBe(main!.oid);

    const after = await branches();
    expect(after.map((b) => b.name).sort()).toEqual(["feat/x", "main"]);
  });

  test("creating the same branch twice conflicts rather than moving it", async () => {
    const again = await create({ name: "feat/x" });
    expect(again.status).toBe(409);
    expect(await read<{ error: string }>(again)).toMatchObject({
      error: "exists",
    });
  });

  test("unsafe names never reach git", async () => {
    for (const name of [
      "-delete-everything",
      "a..b",
      "refs/heads/sneaky",
      "with space",
      "star*",
      "HEAD",
      "trailing/",
      ".hidden",
      "x.lock",
      "",
    ]) {
      const refused = await create({ name });
      expect({ name, status: refused.status }).toEqual({ name, status: 422 });
      expect(await read<{ error: string }>(refused)).toMatchObject({
        error: "invalid_name",
      });
    }
    // And nothing of the sort exists.
    const names = (await branches()).map((b) => b.name);
    expect(names.sort()).toEqual(["feat/x", "main"]);
  });

  test("a start point that does not resolve is refused", async () => {
    const refused = await create({ name: "orphan", from: "no-such-branch" });
    expect(refused.status).toBe(422);
    expect(await read<{ error: string }>(refused)).toMatchObject({
      error: "unknown_start",
    });
  });

  test("ahead and behind are counted against the default branch", async () => {
    await api("/api/v1/repos/alice/app/contents", {
      method: "POST",
      body: JSON.stringify({
        branch: "feat/x",
        message: "on the branch",
        files: [{ path: "b.txt", content: "two\n" }],
      }),
    });
    const rows = await branches();
    const feat = rows.find((b) => b.name === "feat/x")!;
    const main = rows.find((b) => b.isDefault)!;
    expect({ ahead: feat.ahead, behind: feat.behind }).toEqual({
      ahead: 1,
      behind: 0,
    });
    expect({ ahead: main.ahead, behind: main.behind }).toEqual({
      ahead: 0,
      behind: 0,
    });
    // The default sorts first, so a list renders it without re-sorting.
    expect(rows[0]!.isDefault).toBe(true);
  });

  test("protection is reported per branch, on the default only", async () => {
    await api(
      "/api/v1/repos/alice/app",
      {
        method: "PATCH",
        body: JSON.stringify({ protectDefault: true }),
      },
      admin,
    );
    const rows = await branches();
    expect(rows.find((b) => b.isDefault)!.protected).toBe(true);
    expect(rows.find((b) => b.name === "feat/x")!.protected).toBe(false);
  });

  test("the default branch cannot be deleted", async () => {
    const refused = await api("/api/v1/repos/alice/app/branches/main", {
      method: "DELETE",
    });
    expect(refused.status).toBe(409);
    expect(await read<{ error: string }>(refused)).toMatchObject({
      error: "default_branch",
    });
    expect((await branches()).some((b) => b.isDefault)).toBe(true);
  });

  test("a branch with slashes in its name deletes cleanly", async () => {
    const gone = await api("/api/v1/repos/alice/app/branches/feat/x", {
      method: "DELETE",
    });
    expect(gone.status).toBe(204);
    expect((await branches()).map((b) => b.name)).toEqual(["main"]);

    const twice = await api("/api/v1/repos/alice/app/branches/feat/x", {
      method: "DELETE",
    });
    expect(twice.status).toBe(404);
  });

  test("both mutations announce themselves on the outbox", () => {
    const kinds = listEvents(app.db, {})
      .map((e) => e.kind)
      .reverse();
    expect(kinds).toContain("branch.created");
    expect(kinds).toContain("branch.deleted");

    const created = listEvents(app.db, {}).find(
      (e) => e.kind === "branch.created",
    )!;
    expect(created.payload).toMatchObject({ name: "feat/x", from: "main" });
    expect(String(created.payload.oid)).toMatch(/^[0-9a-f]{40}$/);
  });

  test("a reader who cannot write is refused, and a stranger sees nothing", async () => {
    const forbidden = await api(
      "/api/v1/repos/alice/app/branches",
      { method: "POST", body: JSON.stringify({ name: "bobs" }) },
      bob,
    );
    expect(forbidden.status).toBe(403);

    // A private repo does not admit that it exists.
    await api("/api/v1/repos", {
      method: "POST",
      body: JSON.stringify({ name: "hidden", visibility: "private" }),
    });
    const invisible = await api(
      "/api/v1/repos/alice/hidden/branches",
      { method: "POST", body: JSON.stringify({ name: "bobs" }) },
      bob,
    );
    expect(invisible.status).toBe(404);
    expect(await read<{ error: string }>(invisible)).toMatchObject({
      error: "not_found",
    });
  });
});

describe("branches on a mirror go through the origin", () => {
  const ORIGIN_LOGIN = "octo";
  const ORIGIN_TOKEN = "octo-branch-secret-4417";
  const ALICE_PASSWORD = "alice-mirror-branch";

  const basic = (user: string, secret: string): string =>
    `Basic ${Buffer.from(`${user}:${secret}`).toString("base64")}`;

  let dataDir: string;
  let originDataDir: string;
  let app: App;
  let servers: Servers;
  let originApp: App;
  let originServers: Servers;
  let fake: FakeForge;
  let base: string;

  const api = (path: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (init?.body !== undefined)
      headers.set("content-type", "application/json");
    headers.set("authorization", basic("alice", ALICE_PASSWORD));
    return fetch(`${base}${path}`, { ...init, headers });
  };

  const upstream = (path: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (init?.body !== undefined)
      headers.set("content-type", "application/json");
    headers.set("authorization", basic(ORIGIN_LOGIN, ORIGIN_TOKEN));
    return fetch(`${originServers.url}${path}`, { ...init, headers });
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mb-"));
    originDataDir = await mkdtemp(join(tmpdir(), "forge-mb-up-"));

    originApp = createApp({ dataDir: originDataDir, port: 0 });
    originServers = await serve(originApp);
    await fetch(`${originServers.url}/api/v1/users`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: ORIGIN_LOGIN,
        email: "octo@up.test",
        password: ORIGIN_TOKEN,
      }),
    });
    await upstream("/api/v1/repos", {
      method: "POST",
      body: JSON.stringify({ name: "gears", visibility: "public" }),
    });
    await upstream("/api/v1/repos/octo/gears/contents", {
      method: "POST",
      body: JSON.stringify({
        branch: "main",
        message: "first",
        files: [{ path: "a.txt", content: "one\n" }],
      }),
    });

    const state = newFakeState("forgejo", ORIGIN_LOGIN, ORIGIN_TOKEN);
    state.repos.push({
      id: 3,
      fullName: "octo/gears",
      cloneUrl: `${originServers.url}/octo/gears.git`,
      defaultBranch: "main",
    });
    fake = serveFakeForge(state);

    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    await fetch(`${base}/api/v1/users`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "alice",
        email: "alice@forge.test",
        password: ALICE_PASSWORD,
      }),
    });

    const connected = await read<{ id: string }>(
      await api("/api/v1/user/origins", {
        method: "POST",
        body: JSON.stringify({ host: fake.url, token: ORIGIN_TOKEN }),
      }),
    );
    await mirrorAndWait(
      await api(`/api/v1/user/origins/${connected.id}/mirror`, {
        method: "POST",
        body: JSON.stringify({ fullName: "octo/gears" }),
      }),
    );
  });

  afterAll(async () => {
    fake.stop();
    servers.stop();
    originServers.stop();
    app.close();
    originApp.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(originDataDir, { recursive: true, force: true });
  });

  const localBranches = async (): Promise<BranchRow[]> =>
    read<BranchRow[]>(await api("/api/v1/repos/alice/gears/branches"));

  const upstreamBranches = async (): Promise<{ name: string }[]> =>
    read<{ name: string }[]>(
      await fetch(`${originServers.url}/api/v1/repos/octo/gears/branches`),
    );

  test("creating a branch lands it upstream, then here", async () => {
    const created = await api("/api/v1/repos/alice/gears/branches", {
      method: "POST",
      body: JSON.stringify({ name: "feat/up", from: "main" }),
    });
    expect(created.status).toBe(201);

    expect((await upstreamBranches()).map((b) => b.name).sort()).toEqual([
      "feat/up",
      "main",
    ]);
    expect((await localBranches()).map((b) => b.name).sort()).toEqual([
      "feat/up",
      "main",
    ]);
  });

  test("a branch the origin already holds is refused, and stays absent here", async () => {
    // The origin gains a branch this mirror has never seen. The create lease
    // is "must not already exist", so the origin refuses — and because the
    // local ref only moves after the origin agreed, nothing appears here.
    await upstream("/api/v1/repos/octo/gears/contents", {
      method: "POST",
      body: JSON.stringify({
        branch: "taken",
        base: "main",
        message: "upstream only",
        files: [{ path: "c.txt", content: "three\n" }],
      }),
    });

    const refused = await api("/api/v1/repos/alice/gears/branches", {
      method: "POST",
      body: JSON.stringify({ name: "taken", from: "main" }),
    });
    expect(refused.status).toBe(409);
    expect(await read<{ error: string }>(refused)).toMatchObject({
      error: "origin_refused",
    });
    expect((await localBranches()).map((b) => b.name)).not.toContain("taken");
  });

  test("deleting a branch removes it upstream first", async () => {
    const gone = await api("/api/v1/repos/alice/gears/branches/feat/up", {
      method: "DELETE",
    });
    expect(gone.status).toBe(204);
    expect((await upstreamBranches()).map((b) => b.name)).not.toContain(
      "feat/up",
    );
    expect((await localBranches()).map((b) => b.name)).not.toContain("feat/up");
  });
});
