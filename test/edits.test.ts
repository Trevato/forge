/**
 * Editing files as one call: write, delete, branch, propose. The tests that
 * matter here are the refusals — a traversal path, an oversized body, a
 * protected default branch, and an origin that has to agree first — because
 * every one of them is a way for a fast, automated writer to do damage that
 * a human editing one file at a time never would.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editFiles, MAX_FILE_BYTES } from "../src/actions/contents.ts";
import { createApp, type App } from "../src/app.ts";
import { getRepo } from "../src/core/repos.ts";
import { getUserByName, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import {
  mirrorAndWait,
  newFakeState,
  serveFakeForge,
  type FakeForge,
} from "./fake-origin.ts";
import { seedAdmin } from "./helpers/admin.ts";

const read = async <T>(response: Response): Promise<T> =>
  (await response.json()) as T;

interface EditResponse {
  commit: { commitOid: string; branch: string; created: boolean };
  branch: string;
  pull: { number: number; title: string } | null;
}

describe("edits: files, branches and a pull in one call", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let rw = "";
  let admin = "";
  let bobToken = "";
  let alice: User;
  let bob: User;

  const api = (path: string, init?: RequestInit, token = rw) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
    });

  const tokenFor = async (username: string, password: string, scope: string) =>
    read<{ token: string }>(
      await fetch(`${base}/api/v1/tokens`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ adminConfirm: true, username, password, name: scope, scope }),
      }),
    ).then((t) => t.token);

  const signUp = async (username: string, password: string) => {
    await fetch(`${base}/api/v1/users`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username,
        email: `${username}@forge.test`,
        password,
      }),
    });
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-edits-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;

    await seedAdmin(app, { username: "alice", email: "alice@forge.test", password: "alice-edit-secret" });
    await signUp("bob", "bob-edit-secret");
    rw = await tokenFor("alice", "alice-edit-secret", "rw");
    admin = await tokenFor("alice", "alice-edit-secret", "admin");
    bobToken = await tokenFor("bob", "bob-edit-secret", "rw");
    alice = getUserByName(app.db, "alice")!;
    bob = getUserByName(app.db, "bob")!;

    await api("/api/v1/repos", {
      method: "POST",
      body: JSON.stringify({ name: "app", visibility: "public" }),
    });
    await api("/api/v1/repos/alice/app/contents", {
      method: "POST",
      body: JSON.stringify({
        branch: "main",
        message: "first",
        files: [
          { path: "a.txt", content: "one\n" },
          { path: "doomed.txt", content: "delete me\n" },
        ],
      }),
    });

    // An org repo, so there is a writer who is not an admin — the only way
    // to prove a protected branch actually stops somebody.
    await api(
      "/api/v1/orgs",
      { method: "POST", body: JSON.stringify({ name: "acme" }) },
      admin,
    );
    await api(
      "/api/v1/orgs/acme/teams",
      {
        method: "POST",
        body: JSON.stringify({ name: "devs", permission: "write" }),
      },
      admin,
    );
    await api(
      "/api/v1/orgs/acme/teams/devs/members",
      { method: "POST", body: JSON.stringify({ user: "bob" }) },
      admin,
    );
    await api("/api/v1/repos", {
      method: "POST",
      body: JSON.stringify({
        owner: "acme",
        name: "widget",
        visibility: "public",
      }),
    });
    await api("/api/v1/repos/acme/widget/contents", {
      method: "POST",
      body: JSON.stringify({
        branch: "main",
        message: "first",
        files: [{ path: "w.txt", content: "widget\n" }],
      }),
    });
    await api(
      "/api/v1/repos/acme/widget",
      { method: "PATCH", body: JSON.stringify({ protectDefault: true }) },
      admin,
    );
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const edit = (repo: string, payload: unknown, token = rw) =>
    api(
      `/api/v1/repos/${repo}/edits`,
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
      token,
    );

  const fileAt = async (repo: string, path: string, ref: string) =>
    api(`/api/v1/repos/${repo}/contents/${path}?ref=${ref}`);

  test("an edit on an existing branch commits and is readable back", async () => {
    const response = await edit("alice/app", {
      branch: "main",
      message: "change a",
      files: [{ path: "a.txt", content: "one and a half\n" }],
    });
    expect(response.status).toBe(201);
    const edited = await read<EditResponse>(response);
    expect(edited.branch).toBe("main");
    expect(edited.commit.commitOid).toMatch(/^[0-9a-f]{40}$/);
    expect(edited.pull).toBeNull();

    const file = await read<{ content: string }>(
      await fileAt("alice/app", "a.txt", "main"),
    );
    expect(file.content).toBe("one and a half\n");
  });

  test("a null content deletes the path", async () => {
    const response = await edit("alice/app", {
      branch: "main",
      message: "drop it",
      files: [{ path: "doomed.txt", content: null }],
    });
    expect(response.status).toBe(201);
    expect((await fileAt("alice/app", "doomed.txt", "main")).status).toBe(404);
    // The neighbouring file is untouched — a delete is not a tree reset.
    expect((await fileAt("alice/app", "a.txt", "main")).status).toBe(200);
  });

  test("a new branch plus a pull is one call", async () => {
    const response = await edit("alice/app", {
      newBranch: "feat/edit",
      base: "main",
      message: "propose a change",
      files: [{ path: "new.txt", content: "hello\n" }],
      openPull: { title: "Add new.txt", body: "please" },
    });
    expect(response.status).toBe(201);
    const edited = await read<EditResponse>(response);
    expect(edited.branch).toBe("feat/edit");
    expect(edited.pull).toMatchObject({ title: "Add new.txt" });

    // The branch exists, carries the file, and main does not.
    const branches = await read<{ name: string }[]>(
      await api("/api/v1/repos/alice/app/branches"),
    );
    expect(branches.map((b) => b.name)).toContain("feat/edit");
    expect((await fileAt("alice/app", "new.txt", "feat/edit")).status).toBe(
      200,
    );
    expect((await fileAt("alice/app", "new.txt", "main")).status).toBe(404);

    const pull = await read<{ headBranch: string; baseBranch: string }>(
      await api(`/api/v1/repos/alice/app/pulls/${edited.pull!.number}`),
    );
    expect(pull).toMatchObject({ headBranch: "feat/edit", baseBranch: "main" });
  });

  test("a traversal path never reaches the index", async () => {
    for (const path of ["../escape.txt", "/etc/passwd", "a/../../b", "x/./y"]) {
      const refused = await edit("alice/app", {
        branch: "main",
        files: [{ path, content: "no" }],
      });
      expect({ path, status: refused.status }).toEqual({ path, status: 422 });
      expect(await read<{ error: string }>(refused)).toMatchObject({
        error: "invalid_path",
        path,
      });
    }
  });

  test("the size caps are refused before any object is written", async () => {
    const oversized = await editFiles(
      app,
      alice,
      getRepo(app.db, "alice", "app")!,
      {
        branch: "main",
        files: [{ path: "big.bin", content: "x".repeat(MAX_FILE_BYTES + 1) }],
      },
    );
    expect(oversized).toMatchObject({
      ok: false,
      error: { kind: "file_too_large", path: "big.bin" },
    });

    const bulky = await editFiles(
      app,
      alice,
      getRepo(app.db, "alice", "app")!,
      {
        branch: "main",
        files: Array.from({ length: 6 }, (_, i) => ({
          path: `bulk-${i}.bin`,
          content: "y".repeat(MAX_FILE_BYTES),
        })),
      },
    );
    expect(bulky).toMatchObject({
      ok: false,
      error: { kind: "commit_too_large" },
    });

    // Nothing landed: main still holds exactly what the earlier tests left.
    const tree = await read<{ entries: { name: string }[] }>(
      await api("/api/v1/repos/alice/app/contents?ref=main"),
    );
    expect(tree.entries.map((e) => e.name).sort()).toEqual(["a.txt"]);
  });

  test("a protected default refuses a writer and accepts an admin", async () => {
    const refused = await edit(
      "acme/widget",
      {
        branch: "main",
        message: "sneak",
        files: [{ path: "w.txt", content: "bob was here\n" }],
      },
      bobToken,
    );
    expect(refused.status).toBe(403);
    expect(await read<{ error: string }>(refused)).toMatchObject({
      error: "protected_branch",
      branch: "main",
    });

    // The same writer may branch and propose — protection guards the branch,
    // not the contributor.
    const proposed = await edit(
      "acme/widget",
      {
        newBranch: "bob/fix",
        message: "propose instead",
        files: [{ path: "w.txt", content: "bob was here\n" }],
        openPull: { title: "Fix the widget" },
      },
      bobToken,
    );
    expect(proposed.status).toBe(201);
    expect((await read<EditResponse>(proposed)).pull).not.toBeNull();

    // And an org admin still lands on the protected branch directly.
    const allowed = await edit("acme/widget", {
      branch: "main",
      message: "admin change",
      files: [{ path: "w.txt", content: "admin was here\n" }],
    });
    expect(allowed.status).toBe(201);
  });

  test("the action refuses the same things when called directly", async () => {
    const widget = getRepo(app.db, "acme", "widget")!;
    const asWriter = await editFiles(app, bob, widget, {
      branch: "main",
      files: [{ path: "w.txt", content: "still no\n" }],
    });
    expect(asWriter).toMatchObject({
      ok: false,
      error: { kind: "protected_branch" },
    });

    const asStranger = await editFiles(app, undefined, widget, {
      files: [{ path: "w.txt", content: "anonymous\n" }],
    });
    expect(asStranger).toEqual({ ok: false, error: "unauthorized" });
  });

  test("an empty file list is refused", async () => {
    const refused = await edit("alice/app", { branch: "main", files: [] });
    expect(refused.status).toBe(422);
    expect(await read<{ error: string }>(refused)).toMatchObject({
      error: "no_files",
    });
  });
});

describe("edits on a mirror land upstream first", () => {
  const ORIGIN_LOGIN = "octo";
  const ORIGIN_TOKEN = "octo-edit-secret-9920";
  const ALICE_PASSWORD = "alice-mirror-edit";

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
    dataDir = await mkdtemp(join(tmpdir(), "forge-me-"));
    originDataDir = await mkdtemp(join(tmpdir(), "forge-me-up-"));

    originApp = createApp({ dataDir: originDataDir, port: 0 });
    originServers = await serve(originApp);
    await seedAdmin(originApp, {
      username: ORIGIN_LOGIN,
      email: "octo@up.test",
      password: ORIGIN_TOKEN,
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
      id: 5,
      fullName: "octo/gears",
      cloneUrl: `${originServers.url}/octo/gears.git`,
      defaultBranch: "main",
    });
    fake = serveFakeForge(state);

    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    await seedAdmin(app, {
      username: "alice",
      email: "alice@forge.test",
      password: ALICE_PASSWORD,
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

  test("a commit made here appears on the origin", async () => {
    const response = await api("/api/v1/repos/alice/gears/edits", {
      method: "POST",
      body: JSON.stringify({
        branch: "main",
        message: "edited through the mirror",
        files: [{ path: "a.txt", content: "changed\n" }],
      }),
    });
    expect(response.status).toBe(201);
    const edited = await read<EditResponse>(response);

    const upstreamMain = await read<{ name: string; oid: string }[]>(
      await fetch(`${originServers.url}/api/v1/repos/octo/gears/branches`),
    );
    expect(upstreamMain.find((b) => b.name === "main")?.oid).toBe(
      edited.commit.commitOid,
    );

    const upstreamFile = await read<{ content: string }>(
      await fetch(
        `${originServers.url}/api/v1/repos/octo/gears/contents/a.txt?ref=main`,
      ),
    );
    expect(upstreamFile.content).toBe("changed\n");
  });

  test("an edit on a new branch creates that branch upstream too", async () => {
    const response = await api("/api/v1/repos/alice/gears/edits", {
      method: "POST",
      body: JSON.stringify({
        newBranch: "feat/mirror",
        base: "main",
        message: "on a branch",
        files: [{ path: "b.txt", content: "two\n" }],
      }),
    });
    expect(response.status).toBe(201);
    const edited = await read<EditResponse>(response);

    const branches = await read<{ name: string; oid: string }[]>(
      await fetch(`${originServers.url}/api/v1/repos/octo/gears/branches`),
    );
    expect(branches.find((b) => b.name === "feat/mirror")?.oid).toBe(
      edited.commit.commitOid,
    );
  });
});
