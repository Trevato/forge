/**
 * Adversarial edits and branches. The fast, automated writer this API exists
 * for will send the odd path, the racing retry, the typo'd branch and the
 * duplicated file — and every one of those has to land as a clean refusal
 * with a stable code, or land exactly once. Nothing here may leave a branch
 * with no commit on it, an orphan history, or a tree silently replaced.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { runGitCapture } from "../src/git/env.ts";
import { listBranches } from "../src/git/branches.ts";
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

interface Failure {
  error: string;
  message?: string;
  path?: string;
  reason?: string;
  commit?: { commitOid: string; branch: string };
}

interface Edited {
  commit: { commitOid: string; branch: string; created: boolean };
  branch: string;
  pull: { number: number } | null;
}

describe("edits: refusals that must leave nothing behind", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let rw = "";
  let dir = "";

  const api = (path: string, init?: RequestInit, token = rw) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
    });
  const git = (args: string[]) => runGitCapture(args, { cwd: dir });
  const refs = async (): Promise<string[]> =>
    (await git(["for-each-ref", "--format=%(refname)"])).stdout
      .trim()
      .split("\n")
      .filter((r) => r !== "");
  const tip = async (branch: string): Promise<string> =>
    (await git(["rev-parse", `refs/heads/${branch}`])).stdout.trim();
  const objects = async (): Promise<number> => {
    const out = (await git(["count-objects", "-v"])).stdout;
    const field = (key: string): number =>
      Number(new RegExp(`^${key}: (\\d+)`, "m").exec(out)?.[1] ?? 0);
    return field("count") + field("in-pack");
  };
  const edit = async (
    bodyObj: unknown,
  ): Promise<{ status: number; body: Failure & Edited }> => {
    const r = await api("/api/v1/repos/alice/app/edits", {
      method: "POST",
      body: JSON.stringify(bodyObj),
    });
    return { status: r.status, body: (await r.json()) as Failure & Edited };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-edit-sec-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    await seedAdmin(app, {
      username: "alice",
      email: "alice@forge.test",
      password: "alice-password-1",
    });
    rw = (
      await read<{ token: string }>(
        await fetch(`${base}/api/v1/tokens`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ adminConfirm: true,
            username: "alice",
            password: "alice-password-1",
            name: "rw",
            scope: "rw",
          }),
        }),
      )
    ).token;
    await api("/api/v1/repos", {
      method: "POST",
      body: JSON.stringify({ name: "app", visibility: "public" }),
    });
    dir = join(app.reposRoot, "alice", "app.git");
    const seeded = await edit({
      message: "init",
      files: [
        { path: "README.md", content: "# app\n" },
        { path: "src/index.ts", content: "hi\n" },
      ],
    });
    expect(seeded.status).toBe(201);
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a path that is a directory is refused by name, and the tree survives", async () => {
    const before = await tip("main");
    const r = await edit({ files: [{ path: "src", content: "x" }] });
    expect(r.status).toBe(422);
    expect(r.body.error).toBe("path_conflict");
    expect(r.body.path).toBe("src");
    expect(await tip("main")).toBe(before);
    expect(
      (await git(["ls-tree", "-r", "--name-only", "main"])).stdout,
    ).toContain("src/index.ts");

    const under = await edit({
      files: [{ path: "README.md/x", content: "x" }],
    });
    expect(under.status).toBe(422);
    expect(under.body.error).toBe("path_conflict");
    expect(under.body.path).toBe("README.md/x");
  });

  test("a new branch made for an edit that fails is taken back", async () => {
    const r = await edit({
      newBranch: "stray",
      files: [{ path: "src", content: "x" }],
    });
    expect(r.status).toBe(422);
    expect(r.body.error).toBe("path_conflict");
    // No branch with nothing on it: the half-finished state one call exists
    // to prevent.
    expect(await refs()).not.toContain("refs/heads/stray");
    // And the outbox agrees with git: created, then deleted.
    const kinds = app.db
      .query<{ kind: string }, []>(
        "SELECT kind FROM event WHERE kind LIKE 'branch.%' ORDER BY rowid",
      )
      .all()
      .map((e) => e.kind);
    expect(kinds).toEqual(["branch.created", "branch.deleted"]);
  });

  test("a working branch that does not exist forks from the default, never from nothing", async () => {
    const r = await edit({
      branch: "typo",
      files: [{ path: "z.txt", content: "x" }],
    });
    expect(r.status).toBe(201);
    expect(r.body.branch).toBe("typo");
    // Shares history with main (so it is mergeable) rather than being an
    // orphan root with one file in it.
    const ancestor = await git(["merge-base", "--is-ancestor", "main", "typo"]);
    expect(ancestor.code).toBe(0);
    const names = (await git(["ls-tree", "-r", "--name-only", "typo"])).stdout;
    expect(names).toContain("README.md");
    expect(names).toContain("z.txt");
    // An explicit fork point is still honoured.
    const forked = await edit({
      branch: "from-typo",
      base: "typo",
      files: [{ path: "y.txt", content: "y" }],
    });
    expect(forked.status).toBe(201);
    expect(
      (await git(["merge-base", "--is-ancestor", "typo", "from-typo"])).code,
    ).toBe(0);
  });

  test("odd paths are refused before a single object is written", async () => {
    const before = await objects();
    const cases: [string, string][] = [
      ["../x", "invalid_path"],
      ["a//b", "invalid_path"],
      ["a/", "invalid_path"],
      ["/abs", "invalid_path"],
      ["a\u0000b", "invalid_path"],
      ["a\nb", "invalid_path"],
      [".git/config", "invalid_path"],
      ["sub/.GIT/hooks/pre-receive", "invalid_path"],
      [`${"a/".repeat(4000)}x`, "invalid_path"],
      ["", "invalid_path"],
    ];
    for (const [path, code] of cases) {
      const r = await edit({ files: [{ path, content: "pwned" }] });
      expect([path, r.status]).toEqual([path, 422]);
      expect([path, r.body.error]).toEqual([path, code]);
    }
    expect(await objects()).toBe(before);
    expect(await refs()).not.toContain("refs/heads/stray");
  });

  test("the same path twice in one edit is an ambiguity, not a last-wins", async () => {
    const r = await edit({
      files: [
        { path: "dup.txt", content: "one" },
        { path: "dup.txt", content: "two" },
      ],
    });
    expect(r.status).toBe(422);
    expect(r.body.error).toBe("duplicate_path");
    expect(r.body.path).toBe("dup.txt");
  });

  test("branch_failed and pull_failed keep their stable codes, with the detail beside them", async () => {
    const same = await edit({
      branch: "main",
      newBranch: "main",
      files: [{ path: "z.txt", content: "x" }],
    });
    expect(same.status).toBe(422);
    expect(same.body.error).toBe("branch_failed");
    expect(same.body.reason).toBe("exists");

    const before = await refs();
    const pull = await edit({
      newBranch: "proposal",
      files: [{ path: "p.txt", content: "p" }],
      openPull: { title: "" },
    });
    expect(pull.status).toBe(422);
    expect(pull.body.error).toBe("pull_failed");
    expect(pull.body.reason).toBe("empty_title");
    // The commit did land, on the branch it names, and the caller is told.
    expect(pull.body.commit?.commitOid).toMatch(/^[0-9a-f]{40}$/);
    expect(await tip("proposal")).toBe(pull.body.commit!.commitOid);
    expect(await refs()).toEqual([...before, "refs/heads/proposal"].sort());
  });

  // The actor's, at the address they publish — the no-reply one by default.
  test("commit identity is the actor's, whatever the body claims", async () => {
    const r = await edit({
      author: { name: "Mallory", email: "mallory@evil.test" },
      committer: { name: "Mallory", email: "mallory@evil.test" },
      files: [{ path: "who.txt", content: "me" }],
    });
    expect(r.status).toBe(201);
    const who = (
      await git(["log", "-1", "--format=%an <%ae>|%cn <%ce>", "main"])
    ).stdout.trim();
    expect(who).toBe(
      "alice <alice@users.noreply.localhost>|alice <alice@users.noreply.localhost>",
    );
  });

  test("racing edits to one branch: exactly one lands, the rest hear branch_moved", async () => {
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((i) =>
        edit({ files: [{ path: `race-${i}.txt`, content: "x" }] }),
      ),
    );
    const won = results.filter((r) => r.status === 201);
    const lost = results.filter((r) => r.status !== 201);
    expect(won.length).toBe(1);
    expect(lost.length).toBe(4);
    for (const r of lost) {
      expect(r.status).toBe(409);
      expect(r.body.error).toBe("branch_moved");
    }
    expect(await tip("main")).toBe(won[0]!.body.commit.commitOid);
  });

  test("an Idempotency-Key replay on /edits returns the first commit, not a second", async () => {
    const send = () =>
      fetch(`${base}/api/v1/repos/alice/app/edits`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${rw}`,
          "content-type": "application/json",
          "idempotency-key": "edit-retry-1",
        },
        body: JSON.stringify({
          message: "once",
          files: [{ path: "once.txt", content: "1" }],
        }),
      });
    const first = await send();
    const again = await send();
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(again.headers.get("idempotent-replay")).toBe("true");
    const a = await read<Edited>(first);
    const b = await read<Edited>(again);
    expect(b.commit.commitOid).toBe(a.commit.commitOid);
    expect(await tip("main")).toBe(a.commit.commitOid);
    // A different body under the same key is a bug in the caller.
    const other = await fetch(`${base}/api/v1/repos/alice/app/edits`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${rw}`,
        "content-type": "application/json",
        "idempotency-key": "edit-retry-1",
      },
      body: JSON.stringify({ files: [{ path: "once.txt", content: "2" }] }),
    });
    expect(other.status).toBe(422);
    expect((await read<Failure>(other)).error).toBe("idempotency_key_reused");
    expect(await tip("main")).toBe(a.commit.commitOid);
  });

  test("a branch name past the filesystem's limit is a bad name, not a git failure", async () => {
    const r = await api("/api/v1/repos/alice/app/branches", {
      method: "POST",
      body: JSON.stringify({ name: "x".repeat(300) }),
    });
    expect(r.status).toBe(422);
    expect((await read<Failure>(r)).error).toBe("invalid_name");
    // Bytes, not characters: 200 three-byte glyphs are 600 bytes.
    const wide = await api("/api/v1/repos/alice/app/branches", {
      method: "POST",
      body: JSON.stringify({ name: "é".repeat(200) }),
    });
    expect(wide.status).toBe(422);
    expect((await read<Failure>(wide)).error).toBe("invalid_name");
  });

  test("racing creates of one branch: exactly one 201", async () => {
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map(() =>
        api("/api/v1/repos/alice/app/branches", {
          method: "POST",
          body: JSON.stringify({ name: "racy" }),
        }),
      ),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409, 409, 409, 409]);
  });

  test("past the comparison cap, ahead/behind are null — not zero, not a guess", async () => {
    const head = await tip("main");
    for (let i = 0; i < 205; i++) {
      await git(["update-ref", `refs/heads/many/b${i}`, head]);
    }
    const listed = await listBranches(dir, "main");
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.compared).toBe(false);
    expect(listed.value.branches.length).toBeGreaterThan(200);
    for (const b of listed.value.branches) {
      expect(b.ahead).toBeNull();
      expect(b.behind).toBeNull();
    }
    const rows = (
      await read<{ items: { ahead: number | null }[] }>(
        await api("/api/v1/repos/alice/app/branches"),
      )
    ).items;
    expect(rows.every((b) => b.ahead === null)).toBe(true);
  });
});

describe("edits on a mirror: the origin's refusal is final", () => {
  const ORIGIN_LOGIN = "octo";
  const ORIGIN_TOKEN = "octo-edit-secret-7731";
  const ALICE_PASSWORD = "alice-mirror-refuse";

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
  let dir = "";

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

  const git = (args: string[]) => runGitCapture(args, { cwd: dir });
  const refs = async (): Promise<string[]> =>
    (await git(["for-each-ref", "--format=%(refname)"])).stdout
      .trim()
      .split("\n")
      .filter((r) => r !== "");
  const upstreamBranches = async (): Promise<string[]> =>
    (
      await read<{ items: { name: string }[] }>(
        await fetch(`${originServers.url}/api/v1/repos/octo/gears/branches`),
      )
    ).items
      .map((b) => b.name)
      .sort();

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mr-"));
    originDataDir = await mkdtemp(join(tmpdir(), "forge-mr-up-"));

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
        files: [
          { path: "a.txt", content: "one\n" },
          { path: "lib/b.txt", content: "two\n" },
        ],
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
    dir = join(app.reposRoot, "alice", "gears.git");
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

  test("a stale base is refused by the origin; the local ref stays put and nothing dangles", async () => {
    const before = (await git(["rev-parse", "refs/heads/main"])).stdout.trim();
    // The origin moves on while this forge still holds the old tip.
    const moved = await upstream("/api/v1/repos/octo/gears/contents", {
      method: "POST",
      body: JSON.stringify({
        branch: "main",
        message: "upstream moved",
        files: [{ path: "c.txt", content: "three\n" }],
      }),
    });
    expect(moved.status).toBe(201);

    const r = await api("/api/v1/repos/alice/gears/edits", {
      method: "POST",
      body: JSON.stringify({
        message: "late",
        files: [{ path: "a.txt", content: "stale\n" }],
      }),
    });
    expect(r.status).toBe(422);
    const failure = await read<Failure>(r);
    expect(failure.error).toBe("land_refused");
    // The origin's words came back, and no token did.
    expect(failure.message ?? "").not.toContain(ORIGIN_TOKEN);
    // Local ref unchanged; nothing new is reachable from any ref.
    expect((await git(["rev-parse", "refs/heads/main"])).stdout.trim()).toBe(
      before,
    );
    const reachable = (await git(["rev-list", "--all"])).stdout
      .trim()
      .split("\n");
    expect(reachable).toEqual([before]);
  });

  test("a new branch whose commit the origin cannot take is removed upstream too", async () => {
    const upstreamBefore = await upstreamBranches();
    const r = await api("/api/v1/repos/alice/gears/edits", {
      method: "POST",
      body: JSON.stringify({
        newBranch: "feat/conflict",
        files: [{ path: "lib", content: "a file where a directory is" }],
      }),
    });
    expect(r.status).toBe(422);
    expect((await read<Failure>(r)).error).toBe("path_conflict");
    expect(await refs()).not.toContain("refs/heads/feat/conflict");
    expect(await upstreamBranches()).toEqual(upstreamBefore);
  });
});
