/**
 * Moving a repository to another owner (#569): `POST …/transfer {newOwner}`
 * moves the row and the bare repository, and the old web and API paths answer
 * 308 to the new ones — GETs and mutations alike. The refusals come first.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openIssue } from "../src/actions/issues.ts";
import { createOrg } from "../src/actions/orgs.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp as createAppRow, getAppByRepo } from "../src/core/apps.ts";
import { migrationFiles } from "../src/core/schema.ts";
import { createRepo as makeRepo, forkRepo, getRepo, getRepoById, type Repo } from "../src/core/repos.ts";
import { transferRepo, transfersOf } from "../src/core/transfer.ts";
import { getUserByName } from "../src/core/users.ts";
import { commitFiles } from "../src/git/write.ts";
import { readFileSync } from "node:fs";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { repoDir } from "../src/git/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const PASSWORD = "a-long-transfer-passphrase";

describe("transferring a repository", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let alice: User;
  let bob: User;
  let aliceRw = "";
  let aliceRo = "";
  let bobRw = "";
  let repo: Repo;
  let issueNumber = 0;
  let pullNumber = 0;

  const call = (path: string, token: string, method = "GET", payload?: unknown) =>
    fetch(`${servers.url}${path}`, {
      method,
      redirect: "manual",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-transfer-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const made = async (username: string, admin: boolean) => {
      const u = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: PASSWORD,
        adminIfFirst: admin,
      });
      if (!u.ok) throw new Error(u.error);
      return u.value;
    };
    alice = await made("alice", true);
    bob = await made("bob", false);
    aliceRw = createToken(app.db, alice.id, "rw", "rw").token;
    aliceRo = createToken(app.db, alice.id, "ro", "ro").token;
    bobRw = createToken(app.db, bob.id, "rw", "rw").token;
    const org = createOrg(app, alice, "lab");
    if (!org.ok) throw new Error(org.error);
    const r = await createRepo(app, alice, { name: "notes", visibility: "public" });
    if (!r.ok) throw new Error(String(r.error));
    repo = r.value;
    await commitToBranch(app, alice, repo, { message: "seed", files: [{ path: "README.md", content: "# notes\n" }] });
    await commitToBranch(app, alice, repo, {
      branch: "topic",
      base: "main",
      message: "topic",
      files: [{ path: "T.md", content: "t\n" }],
    });
    const pull = await openPull(app, alice, repo, { title: "Topic", body: "", baseBranch: "main", headBranch: "topic" });
    if (!pull.ok) throw new Error(String(pull.error));
    pullNumber = pull.value.number;
    const issue = openIssue(app, alice, repo, { title: "Bookmarked" });
    if (!issue.ok) throw new Error(String(issue.error));
    issueNumber = issue.value.number;
    const appRow = createAppRow(app.db, { repoId: repo.id, slug: "notes", access: "public" });
    if (!appRow.ok) throw new Error(appRow.error);
    // A second "notes" under bob, so moving there is refused.
    const clash = await makeRepo(app.db, app.reposRoot, { ownerId: bob.id, name: "notes", visibility: "public" });
    if (!clash.ok) throw new Error(String(clash.error));
  }, 30_000);

  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a read-only token, a stranger and a taken name are refused, and nothing moves", async () => {
    expect((await call("/api/v1/repos/alice/notes/transfer", aliceRo, "POST", { newOwner: "lab" })).status).toBe(403);
    expect((await call("/api/v1/repos/alice/notes/transfer", bobRw, "POST", { newOwner: "bob" })).status).toBe(404);
    const taken = await call("/api/v1/repos/alice/notes/transfer", aliceRw, "POST", { newOwner: "bob" });
    expect(taken.status).toBe(409);
    expect(((await taken.json()) as { error: string }).error).toBe("name_taken");
    expect((await call("/api/v1/repos/alice/notes/transfer", aliceRw, "POST", { newOwner: 7 })).status).toBe(422);
    expect((await call("/api/v1/repos/alice/notes/transfer", aliceRw, "POST", { newOwner: "nobody" })).status).toBe(
      422,
    );
    expect(getRepo(app.db, "alice", "notes")?.id).toBe(repo.id);
  });

  test("bob cannot move his own repository under an org he is not in", async () => {
    const res = await call("/api/v1/repos/bob/notes/transfer", bobRw, "POST", { newOwner: "lab" });
    expect(res.status).toBe(403);
  });

  test("the move takes the row, the bare repository and the app along", async () => {
    const res = await call("/api/v1/repos/alice/notes/transfer", aliceRw, "POST", { newOwner: "lab" });
    expect(res.status).toBe(200);
    expect(getRepo(app.db, "lab", "notes")?.id).toBe(repo.id);
    expect(getRepo(app.db, "alice", "notes")).toBeUndefined();
    expect(existsSync(join(repoDir(app.reposRoot, "lab", "notes"), "HEAD"))).toBe(true);
    expect(existsSync(repoDir(app.reposRoot, "alice", "notes"))).toBe(false);
    expect(getAppByRepo(app.db, repo.id)?.slug).toBe("notes");
    const event = app.db
      .query<{ actor_id: string; payload: string }, [string]>(
        "SELECT actor_id, payload FROM event WHERE kind = 'repo.transferred' AND repo_id = ?1",
      )
      .get(repo.id);
    expect(event?.actor_id).toBe(alice.id);
    expect(JSON.parse(event!.payload)).toMatchObject({ from: "alice/notes", to: "lab/notes" });
  });

  test("the old page, API path, issue and pull answer 308 to the new ones", async () => {
    const page = await call("/alice/notes", aliceRw);
    expect(page.status).toBe(308);
    expect(page.headers.get("location")).toBe("/lab/notes");
    const api = await call("/api/v1/repos/alice/notes?x=1", aliceRw);
    expect(api.status).toBe(308);
    expect(api.headers.get("location")).toBe("/api/v1/repos/lab/notes?x=1");
    const issue = await call(`/alice/notes/issues/${issueNumber}`, aliceRw);
    expect(issue.status).toBe(308);
    expect(issue.headers.get("location")).toBe(`/lab/notes/issues/${issueNumber}`);
    const pull = await call(`/api/v1/repos/alice/notes/pulls/${pullNumber}`, aliceRw);
    expect(pull.status).toBe(308);
    expect(pull.headers.get("location")).toBe(`/api/v1/repos/lab/notes/pulls/${pullNumber}`);
    // The new paths answer.
    expect((await call(`/api/v1/repos/lab/notes/pulls/${pullNumber}`, aliceRw)).status).toBe(200);
    expect((await call(`/api/v1/repos/lab/notes/issues/${issueNumber}`, aliceRw)).status).toBe(200);
  });

  test("a mutation under the old path is not applied: it answers 308", async () => {
    const res = await call("/api/v1/repos/alice/notes/issues", aliceRw, "POST", { title: "lost?" });
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("/api/v1/repos/alice/notes/issues".replace("alice", "lab"));
    const count = app.db
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM issue WHERE repo_id = ?1 AND title = 'lost?'")
      .get(repo.id);
    expect(count?.n).toBe(0);
  });

  test("the move leaves an audit row: who moved what from where to where", () => {
    expect(transfersOf(app.db, repo.id)).toEqual([
      expect.objectContaining({ from: "alice/notes", to: "lab/notes", actorId: alice.id }),
    ]);
  });

  test("a caller who cannot read the repository gets 404 from its old path, not where it went", async () => {
    const hidden = await createRepo(app, alice, { name: "hidden", visibility: "private" });
    if (!hidden.ok) throw new Error(String(hidden.error));
    expect((await call("/api/v1/repos/alice/hidden/transfer", aliceRw, "POST", { newOwner: "lab" })).status).toBe(200);
    expect((await call("/api/v1/repos/alice/hidden", aliceRw)).status).toBe(308);
    for (const path of ["/api/v1/repos/alice/hidden", "/alice/hidden"]) {
      const res = await call(path, bobRw);
      expect(res.status).toBe(404);
      expect(res.headers.get("location")).toBeNull();
    }
  });

  test("moved a second time, the first old path follows to the newest owner", async () => {
    const lab2 = createOrg(app, alice, "lab2");
    if (!lab2.ok) throw new Error(lab2.error);
    expect((await call("/api/v1/repos/lab/notes/transfer", aliceRw, "POST", { newOwner: "lab2" })).status).toBe(200);
    for (const old of ["alice", "lab"]) {
      const res = await call(`/${old}/notes/issues/${issueNumber}`, aliceRw);
      expect(res.status).toBe(308);
      expect(res.headers.get("location")).toBe(`/lab2/notes/issues/${issueNumber}`);
    }
    expect(transfersOf(app.db, repo.id).map((t) => t.to)).toEqual(["lab/notes", "lab2/notes"]);
  });

  test("a fork's borrowed objects follow its parent to the new place", async () => {
    const made = await makeRepo(app.db, app.reposRoot, { ownerId: alice.id, name: "parent", visibility: "public" });
    if (!made.ok) throw new Error(made.error);
    const c = await commitFiles(repoDir(app.reposRoot, "alice", "parent"), {
      branch: "main",
      message: "seed",
      files: [{ path: "a.txt", content: "a" }],
      author: { name: "T", email: "t@forge.test" },
    });
    if (!c.ok) throw new Error("commit failed");
    const fork = await forkRepo(app.db, app.reposRoot, made.value, bob.id);
    if (!fork.ok) throw new Error(fork.error);
    const forkDir = repoDir(app.reposRoot, "bob", fork.value.name);
    const moved = await transferRepo(app.db, app.reposRoot, made.value, getUserByName(app.db, "lab")!, alice.id);
    expect(moved.ok).toBe(true);
    const alternates = readFileSync(join(forkDir, "objects", "info", "alternates"), "utf8");
    expect(alternates).toContain(join(repoDir(app.reposRoot, "lab", "parent"), "objects"));
    expect(alternates).not.toContain(repoDir(app.reposRoot, "alice", "parent"));
    const fsck = Bun.spawnSync(["git", "cat-file", "-e", `${c.value.commitOid}^{commit}`], { cwd: forkDir });
    expect(fsck.exitCode).toBe(0);
  });

  test("when the transaction fails the directory is renamed back and nothing changes", async () => {
    const made = await makeRepo(app.db, app.reposRoot, { ownerId: alice.id, name: "stays", visibility: "public" });
    if (!made.ok) throw new Error(made.error);
    app.db.exec(
      "CREATE TRIGGER refuse_transfer BEFORE INSERT ON repo_transfer BEGIN SELECT RAISE(ABORT, 'refused'); END",
    );
    try {
      const moved = await transferRepo(app.db, app.reposRoot, made.value, getUserByName(app.db, "lab")!, alice.id);
      expect(moved.ok ? "ok" : moved.error).toBe("move_failed");
    } finally {
      app.db.exec("DROP TRIGGER refuse_transfer");
    }
    expect(getRepoById(app.db, made.value.id)?.ownerName).toBe("alice");
    expect(existsSync(join(repoDir(app.reposRoot, "alice", "stays"), "HEAD"))).toBe(true);
    expect(existsSync(repoDir(app.reposRoot, "lab", "stays"))).toBe(false);
    expect(transfersOf(app.db, made.value.id)).toEqual([]);
    expect((await call("/api/v1/repos/lab/stays", aliceRw)).status).toBe(404);
  });

  test("two moves to the same owner and name at once: one lands, the other is refused", async () => {
    const twins: Repo[] = [];
    for (const owner of [alice, bob]) {
      const made = await makeRepo(app.db, app.reposRoot, { ownerId: owner.id, name: "twin", visibility: "public" });
      if (!made.ok) throw new Error(made.error);
      twins.push(made.value);
    }
    const lab = getUserByName(app.db, "lab")!;
    const results = await Promise.all(twins.map((t) => transferRepo(app.db, app.reposRoot, t, lab, alice.id)));
    expect(results.map((r) => (r.ok ? "ok" : r.error)).sort()).toEqual(["name_taken", "ok"]);
    const landed = results.findIndex((r) => r.ok);
    const other = twins[1 - landed]!;
    expect(getRepoById(app.db, other.id)?.ownerId).toBe(other.ownerId);
    expect(existsSync(join(repoDir(app.reposRoot, other.ownerName, "twin"), "HEAD"))).toBe(true);
    expect(getRepo(app.db, "lab", "twin")?.id).toBe(twins[landed]!.id);
  });

  test("a repository made again at the old path takes it back", async () => {
    const again = await createRepo(app, alice, { name: "notes", visibility: "public" });
    expect(again.ok).toBe(true);
    expect((await call("/api/v1/repos/alice/notes", aliceRw)).status).toBe(200);
  });

  test("the migration applies twice without complaint", () => {
    const sql = migrationFiles.find((m) => m.name.includes("repo-redirect"))!.sql;
    expect(() => app.db.exec(sql)).not.toThrow();
  });
});
