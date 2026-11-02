/**
 * An agent's pull that waits for a person's review is never a silent hold
 * (#597): what needs you lists it with why and since when, the board says
 * so, the autonomy settings say "No reviewer: agent pulls wait for you",
 * and the MCP's `now` lists it with its age — to the owner, and to nobody
 * who only reads.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { getPull, type Pull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { landIfGreen } from "../src/crew/autonomy.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { askLinesFor } from "../src/web/studio/asks.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const PASSWORD = "a-long-review-passphrase";

describe("an agent pull that waits for a person's review says so", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let alice: User;
  let bob: User;
  let repo: Repo;
  let aliceCookie = "";
  let bobCookie = "";
  let aliceRo = "";
  let bobRo = "";
  let waiting: Pull;
  let own: Pull;

  const signIn = async (username: string) => {
    const res = await fetch(`${servers.url}/signin`, {
      method: "POST",
      body: new URLSearchParams({ username, password: PASSWORD }),
      redirect: "manual",
    });
    return `${(res.headers.get("set-cookie") ?? "").split(";")[0]!}; forge_mode=studio`;
  };
  const page = async (cookie: string, path: string) =>
    (
      await (
        await fetch(`${servers.url}${path}`, { headers: { cookie } })
      ).text()
    ).replace(/\s+/g, " ");
  const now = async (token: string) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "now", arguments: {} },
      }),
    });
    const body = (await res.json()) as {
      result: { content: { text: string }[] };
    };
    return JSON.parse(body.result.content[0]!.text) as {
      why: string;
      on: string;
      says?: string;
      since: string;
    }[];
  };

  const greenPull = async (author: User, name: string): Promise<Pull> => {
    await commitToBranch(app, alice, repo, {
      branch: `feature/${name}`,
      base: "main",
      message: name,
      files: [{ path: `${name}.ts`, content: `export const n = "${name}";\n` }],
    });
    const opened = await openPull(app, alice, repo, {
      title: name,
      baseBranch: "main",
      headBranch: `feature/${name}`,
    });
    if (!opened.ok) throw new Error(String(opened.error));
    app.db
      .query("UPDATE issue SET author_id = ?2 WHERE id = ?1")
      .run(opened.value.id, author.id);
    const pull = getPull(app.db, repo.id, opened.value.number)!;
    const check = createRun(app.db, {
      repoId: repo.id,
      kind: "check",
      issueId: pull.id,
      env: `pull-${pull.number}`,
      commitOid: pull.headOid,
      reason: "pull",
    });
    claimRun(app.db, check.id);
    finishRun(app.db, check.id, { state: "ok", summary: "check passed" });
    return pull;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-review-waits-"));
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
    // Public: bob reads it, and still is asked nothing and told nothing of its review.
    const made = await createRepo(app, alice, {
      name: "engine",
      visibility: "public",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    await commitToBranch(app, alice, repo, {
      message: "seed",
      files: [{ path: "README.md", content: "# engine\n" }],
    });
    await createAgent(app, alice, { username: "mason" });
    addToCrew(app, alice, repo, "mason");
    app.db
      .query(
        "UPDATE repo SET autonomy = 'autonomous', autonomy_by = ?2 WHERE id = ?1",
      )
      .run(repo.id, alice.id);
    repo = { ...repo, autonomy: "autonomous", autonomyBy: alice.id };
    // An app: the board and the MCP's `now` speak of apps.
    app.db
      .query("INSERT INTO app (id, repo_id, slug, access, preview_data) VALUES (?1, ?2, 'engine', 'public', 'copy')")
      .run(`app-${repo.id}`, repo.id);
    aliceCookie = await signIn("alice");
    bobCookie = await signIn("bob");
    aliceRo = createToken(app.db, alice.id, "ro", "ro").token;
    bobRo = createToken(app.db, bob.id, "ro", "ro").token;
    waiting = await greenPull(getUserByName(app.db, "mason")!, "agent-work");
    own = await greenPull(alice, "person-work");
  }, 30_000);

  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a reader is asked nothing and told nothing of it", async () => {
    expect(askLinesFor(app.db, bob).some((l) => l.kind === "review")).toBe(
      false,
    );
    expect(await page(bobCookie, "/board")).not.toContain("No reviewer");
    expect((await now(bobRo)).some((r) => r.why === "review")).toBe(false);
  });

  test("with no reviewer the agent's pull does not land, and a person's own does", async () => {
    expect(await landIfGreen(app, repo, waiting)).toBe(false);
    expect(await landIfGreen(app, repo, own)).toBe(true);
  });

  test("what needs you lists it: why, and since when", () => {
    const line = askLinesFor(app.db, alice).find(
      (l) => l.id === `review:${waiting.id}`,
    );
    expect(line?.line).toContain(
      '"agent-work" waits for your review: no reviewer on the crew, since',
    );
    expect(
      askLinesFor(app.db, alice).some((l) => l.line.includes("person-work")),
    ).toBe(false);
  });

  test("the board and the autonomy settings say so", async () => {
    const board = await page(aliceCookie, "/board");
    expect(board).toContain('<details id="notes-list" class="disclosure">');
    expect(board).toContain("No reviewer: agent pulls wait for you");
    expect(board).toContain("<b>1</b> waiting since");
    const settings = await page(aliceCookie, "/alice/engine/settings");
    expect(settings).toContain("No reviewer: agent pulls wait for you.");
    expect(settings.split("No reviewer").length).toBe(2);
    expect(settings).toContain('data-auto="on"');
    expect(settings).toContain("No planner: your direction goes nowhere");
  });

  test("with auto mode off an empty seat is an invitation, not a warning", async () => {
    app.db.query("UPDATE repo SET autonomy = 'off' WHERE id = ?1").run(repo.id);
    const settings = await page(aliceCookie, "/alice/engine/settings");
    expect(settings).toContain('data-auto="off"');
    expect(settings).toContain("open seat");
    expect(settings).not.toContain("No planner:");
    app.db.query("UPDATE repo SET autonomy = 'autonomous' WHERE id = ?1").run(repo.id);
  });

  test("the MCP's now lists it with its age", async () => {
    const row = (await now(aliceRo)).find((r) => r.why === "review");
    expect(row?.on).toBe(`#${waiting.number} agent-work`);
    expect(row?.says).toBe("no reviewer on the crew");
    expect(Date.parse(row!.since)).toBeLessThanOrEqual(Date.now());
  });
});
