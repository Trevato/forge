/**
 * #865's follow-ups. A sealed repository is never public, said by the
 * database itself, whatever writes `repo.visibility`. And a writer who
 * fixes a sealed report by hand is offered the private repository: a pull
 * for a sealed issue from a public branch is refused unless a person says
 * yes to publishing it. Refusals first.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openIssue } from "../src/actions/issues.ts";
import { openPull } from "../src/actions/pulls.ts";
import {
  commitToBranch,
  createRepo,
  privateRepoForSealed,
} from "../src/actions/repos.ts";
import type { Issue } from "../src/core/issues.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { id } from "../src/kernel/id.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const PASSWORD = "a-long-sealed-passphrase";

describe("sealed work stays private", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let alice: User;
  let bob: User;
  let repo: Repo;
  let sealed: Issue;
  let open: Issue;
  let aliceRw = "";
  let bobRw = "";
  let aliceCookie = "";

  const api = (token: string | null, path: string, payload: unknown) =>
    fetch(`${servers.url}${path}`, {
      method: "POST",
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-sealed-private-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const a = await createUser(app.db, {
      username: "alice",
      email: "alice@forge.local",
      password: PASSWORD,
      adminIfFirst: true,
      trusted: true,
    });
    const b = await createUser(app.db, {
      username: "bob",
      email: "bob@forge.local",
      password: PASSWORD,
      trusted: true,
    });
    if (!a.ok || !b.ok) throw new Error("users");
    alice = a.value;
    bob = b.value;
    aliceRw = createToken(app.db, alice.id, "rw", "rw").token;
    bobRw = createToken(app.db, bob.id, "rw", "rw").token;
    const made = await createRepo(app, alice, {
      name: "vault",
      visibility: "public",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    await commitToBranch(app, alice, repo, {
      message: "seed",
      files: [{ path: "README.md", content: "# vault\n" }],
    });
    await createAgent(app, alice, { username: "vaultbot" });
    addToCrew(app, alice, repo, "vaultbot");
    const s = openIssue(app, alice, repo, {
      title: "The token check is missing",
      sealed: true,
    });
    const o = openIssue(app, alice, repo, { title: "A typo" });
    if (!s.ok || !o.ok) throw new Error("issues");
    sealed = s.value;
    open = o.value;
    // A fix pushed straight to the public base, as a writer might.
    await commitToBranch(app, alice, repo, {
      branch: "fix/token",
      base: "main",
      message: "Check the token",
      files: [{ path: "auth.ts", content: "export const checked = true;\n" }],
    });
    const res = await fetch(`${servers.url}/signin`, {
      method: "POST",
      body: new URLSearchParams({ username: "alice", password: PASSWORD }),
      redirect: "manual",
    });
    aliceCookie = `${(res.headers.get("set-cookie") ?? "").split(";")[0]!}; forge_mode=studio`;
  }, 30_000);

  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  const fix = {
    title: "Check the token",
    body: `Closes #1`,
    baseBranch: "main",
    headBranch: "fix/token",
  };

  test("a pull for a sealed issue from a public branch is refused", async () => {
    const tried = await openPull(app, alice, repo, fix);
    expect(tried.ok).toBe(false);
    if (!tried.ok) expect(tried.error).toBe("sealed_in_public");
    const res = await api(aliceRw, "/api/v1/repos/alice/vault/pulls", {
      title: fix.title,
      body: fix.body,
      base: "main",
      head: "fix/token",
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe(
      "sealed_in_public",
    );
  });

  test("an agent's yes is never taken", async () => {
    const bot = getUserByName(app.db, "vaultbot")!;
    const tried = await openPull(app, bot, repo, {
      ...fix,
      confirmPublic: true,
    });
    expect(tried.ok).toBe(false);
    if (!tried.ok) expect(tried.error).toBe("sealed_in_public");
  });

  test("only someone who may see the sealed report gets the private repository", async () => {
    expect(
      (await api(null, "/api/v1/repos/alice/vault/issues/1/private", {}))
        .status,
    ).toBe(401);
    expect(
      (await api(bobRw, "/api/v1/repos/alice/vault/issues/1/private", {}))
        .status,
    ).toBe(404);
    const plain = await api(
      aliceRw,
      `/api/v1/repos/alice/vault/issues/${open.number}/private`,
      {},
    );
    expect(plain.status).toBe(422);
    expect(((await plain.json()) as { error: string }).error).toBe(
      "not_sealed",
    );
  });

  test("the database refuses a public sealed repository, whatever writes it", async () => {
    const mine = await privateRepoForSealed(app, alice, repo, sealed);
    if (!mine.ok) throw new Error(String(mine.error));
    expect(() =>
      app.db
        .query("UPDATE repo SET visibility = 'public' WHERE id = ?1")
        .run(mine.value.id),
    ).toThrow("a sealed repository is never public");
    expect(getRepoById(app.db, mine.value.id)!.visibility).toBe("private");
    expect(() =>
      app.db
        .query(
          "INSERT INTO repo (id, owner_id, name, visibility, default_branch, sealed_for) VALUES (?1, ?2, 'leak', 'public', 'main', ?3)",
        )
        .run(id(), alice.id, repo.id),
    ).toThrow("a sealed repository is never public");
    // A public repository made sealed is refused the same way.
    expect(() =>
      app.db
        .query("UPDATE repo SET sealed_for = ?2 WHERE id = ?1")
        .run(repo.id, repo.id),
    ).toThrow("a sealed repository is never public");
  });

  test("a writer is offered the private repository, and its pull needs no yes", async () => {
    const res = await api(
      aliceRw,
      "/api/v1/repos/alice/vault/issues/1/private",
      {},
    );
    expect(res.status).toBe(201);
    const made = (await res.json()) as { repo: string; clone: string };
    expect(made.clone).toBe(`${servers.url}/${made.repo}.git`);
    const [owner, name] = made.repo.split("/");
    const privateRepo = getRepoById(
      app.db,
      app.db
        .query<
          { id: string },
          [string, string]
        >("SELECT repo.id AS id FROM repo JOIN user ON user.id = repo.owner_id WHERE user.username = ?1 AND repo.name = ?2")
        .get(owner!, name!)!.id,
    )!;
    expect(privateRepo.visibility).toBe("private");
    expect(privateRepo.sealedFor).toBe(repo.id);
    await commitToBranch(app, alice, privateRepo, {
      branch: "fix/private",
      base: "main",
      message: "Check the token, privately",
      files: [{ path: "auth.ts", content: "export const checked = 2;\n" }],
    });
    const opened = await openPull(app, alice, repo, {
      ...fix,
      headBranch: "fix/private",
      headRepo: privateRepo,
    });
    expect(opened.ok).toBe(true);
    if (opened.ok) expect(opened.value.sealed).toBe(true);
  });

  test("the sealed report's page offers it; the compose page asks for a deliberate yes", async () => {
    const page = (
      await (
        await fetch(`${servers.url}/alice/vault/issues/1`, {
          headers: { cookie: aliceCookie },
        })
      ).text()
    ).replace(/\s+/g, " ");
    expect(page).toContain('id="work-privately"');
    expect(page).toContain("is public: its fix shows where the hole is");
    const post = (extra: [string, string][]) =>
      fetch(`${servers.url}/alice/vault/pulls/new`, {
        method: "POST",
        headers: { cookie: aliceCookie, origin: servers.url },
        body: new URLSearchParams([
          ["baseRepo", "self"],
          ["title", fix.title],
          ["body", fix.body],
          ["base", "main"],
          ["head", "fix/token"],
          ...extra,
        ]),
        redirect: "manual",
      });
    const refused = await post([]);
    expect(refused.status).toBe(422);
    const words = (await refused.text()).replace(/\s+/g, " ");
    expect(words).toContain(
      "This fixes a sealed security report, and this branch is public",
    );
    expect(words).toContain('name="confirm_public"');
    const yes = await post([["confirm_public", "1"]]);
    expect(yes.status).toBe(303);
  });
});
