/**
 * Only an agent is ever on a crew. A person put on one would be a writer by
 * the SQL write check (`REPO_WRITABLE`'s crew clause) and not by `onCrew`;
 * so no route may do it — settings, the API, the action, the core insert —
 * and one already there is reported, never removed.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { addCrew, isCrew, peopleOnCrews } from "../src/core/agents.ts";
import { canWrite, writableRepoIds, type Repo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const PASSWORD = "a-long-crew-passphrase";

describe("only an agent is on a crew", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let alice: User;
  let bob: User;
  let repo: Repo;
  let adminToken = "";
  let cookie = "";

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-crew-agents-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const a = await createUser(app.db, {
      origin: "seed",
      username: "alice",
      email: "alice@forge.local",
      password: PASSWORD,
      adminIfFirst: true,
      trusted: true,
    });
    const b = await createUser(app.db, {
      origin: "seed",
      username: "bob",
      email: "bob@forge.local",
      password: PASSWORD,
      trusted: true,
    });
    if (!a.ok || !b.ok) throw new Error("users");
    alice = a.value;
    bob = b.value;
    adminToken = createToken(app.db, alice.id, "admin", "admin").token;
    const made = await createRepo(app, alice, {
      name: "yard",
      visibility: "private",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    await commitToBranch(app, alice, repo, {
      message: "seed",
      files: [{ path: "README.md", content: "# yard\n" }],
    });
    await createAgent(app, alice, { username: "yardbot" });
    const res = await fetch(`${servers.url}/signin`, {
      method: "POST",
      body: new URLSearchParams({ username: "alice", password: PASSWORD }),
      redirect: "manual",
    });
    cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  }, 30_000);

  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the action refuses a person, and says so", () => {
    const added = addToCrew(app, alice, repo, "bob");
    expect(added.ok).toBe(false);
    if (!added.ok) expect(added.error).toBe("not_an_agent");
    expect(isCrew(app.db, repo.id, bob.id)).toBe(false);
  });

  test("the API refuses a person with a clear error", async () => {
    const res = await fetch(`${servers.url}/api/v1/repos/alice/yard/crew/bob`, {
      method: "PUT",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe(
      "not_an_agent",
    );
    expect(isCrew(app.db, repo.id, bob.id)).toBe(false);
  });

  test("the settings form refuses a person, in words", async () => {
    const res = await fetch(`${servers.url}/alice/yard/settings/crew`, {
      method: "POST",
      headers: { cookie, origin: servers.url },
      body: new URLSearchParams({ agent: "bob" }),
      redirect: "manual",
    });
    expect(res.status).toBe(303);
    expect(isCrew(app.db, repo.id, bob.id)).toBe(false);
  });

  test("the database refuses a person whatever route reaches it", () => {
    expect(() => addCrew(app.db, repo.id, bob.id, alice.id)).toThrow(
      "only an agent can be on a crew",
    );
    expect(() =>
      app.db
        .query(
          "INSERT OR IGNORE INTO repo_crew (repo_id, user_id) VALUES (?1, ?2)",
        )
        .run(repo.id, bob.id),
    ).toThrow("only an agent can be on a crew");
    expect(isCrew(app.db, repo.id, bob.id)).toBe(false);
  });

  test("an agent still joins, by every route", async () => {
    expect(addToCrew(app, alice, repo, "yardbot").ok).toBe(true);
    const yardbot = app.db
      .query<
        { id: string },
        []
      >("SELECT id FROM user WHERE username = 'yardbot'")
      .get()!;
    expect(isCrew(app.db, repo.id, yardbot.id)).toBe(true);
  });

  test("a person already on a crew from before is reported, never removed", () => {
    // As if put there before `repo_crew_agents_only`: the guard stands aside for one row.
    app.db.exec("DROP TRIGGER repo_crew_agents_only");
    app.db
      .query("INSERT INTO repo_crew (repo_id, user_id) VALUES (?1, ?2)")
      .run(repo.id, bob.id);
    app.db.exec(`CREATE TRIGGER repo_crew_agents_only BEFORE INSERT ON repo_crew
      WHEN NOT EXISTS (SELECT 1 FROM user WHERE id = NEW.user_id AND is_agent = 1)
      BEGIN SELECT RAISE(ABORT, 'only an agent can be on a crew'); END`);
    expect(peopleOnCrews(app.db)).toEqual([
      { repoId: repo.id, username: "bob" },
    ]);
    expect(isCrew(app.db, repo.id, bob.id)).toBe(true);
    // Kept, but no key: the SQL write check reads the crew grant as onCrew
    // does, agents only.
    expect(writableRepoIds(app.db, bob, [repo.id]).has(repo.id)).toBe(false);
    expect(canWrite(app.db, repo, bob)).toBe(false);
  });
});
