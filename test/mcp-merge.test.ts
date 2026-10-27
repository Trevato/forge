/**
 * The `merge` tool over MCP (#6243): the pull page's Merge button from any
 * client. It plans unless `dryRun` is false, the plan is what `pull` reads,
 * landing is `mergePull`'s with its refusals, and an agent — even one on the
 * crew, who may write the repository — is refused: a person merges.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { addCrew, createAgentRow } from "../src/core/agents.ts";
import { getPull } from "../src/core/pulls.ts";
import { getRepo, type Repo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { resolveOid } from "../src/git/merge.ts";
import { repoDir } from "../src/git/repos.ts";
import { promote } from "./helpers/members.ts";

describe("the merge tool over MCP", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let repo: Repo;
  let alice: User;
  let aliceRw: string;
  let aliceRo: string;
  let bobRw: string;
  let agentRw: string;
  let nextId = 1;

  const tool = async (token: string, args: unknown) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: nextId++,
        method: "tools/call",
        params: { name: "merge", arguments: args },
      }),
    });
    const body = (await res.json()) as any;
    const text: string = body.result.content[0].text;
    return body.result.isError === true
      ? { error: text }
      : { value: JSON.parse(text) };
  };

  /** A pull on alice/game writing `path`, from a branch off main. */
  const pullOf = async (branch: string, path = `${branch}.txt`, content = `${branch}\n`) => {
    const made = await commitToBranch(app, alice, repo, {
      branch,
      message: branch,
      files: [{ path, content }],
    });
    if (!made.ok) throw new Error(JSON.stringify(made.error));
    const opened = await openPull(app, alice, repo, {
      title: branch,
      baseBranch: "main",
      headBranch: branch,
    });
    if (!opened.ok) throw new Error(String(opened.error));
    return opened.value;
  };

  const mainTip = () =>
    resolveOid(repoDir(app.reposRoot, "alice", "game"), "refs/heads/main");

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-merge-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const mk = async (username: string, first = false, agent = false) => {
      const made = await createUser(app.db, {
        origin: agent ? "agent" : "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: agent ? "" : "a-good-passphrase",
        adminIfFirst: first,
        ...(agent ? { agent: true } : {}),
      });
      if (!made.ok) throw new Error(made.error);
      return made.value;
    };
    alice = await mk("alice", true);
    const bob = await mk("bob");
    const wright = await mk("wright", false, true);
    createAgentRow(app.db, { userId: wright.id, brief: "Builds." });
    promote(app.db, alice, bob);
    aliceRw = createToken(app.db, alice.id, "rw", "rw").token;
    aliceRo = createToken(app.db, alice.id, "ro", "ro").token;
    bobRw = createToken(app.db, bob.id, "rw", "rw").token;
    agentRw = createToken(app.db, wright.id, "rw", "rw").token;
    const made = await createRepo(app, alice, { name: "game", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    await commitToBranch(app, alice, made.value, {
      message: "seed",
      files: [{ path: "README.md", content: "# game\n" }],
    });
    repo = getRepo(app.db, "alice", "game")!;
    // On the crew: the agent may write the repository, and still not land.
    addCrew(app.db, repo.id, wright.id, alice.id);
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("an agent's token is refused, dry run or not: a person merges", async () => {
    const pull = await pullOf("by-agent");
    const before = await mainTip();
    for (const dryRun of [undefined, false]) {
      const refused = await tool(agentRw, {
        repo: "alice/game",
        number: pull.number,
        ...(dryRun === undefined ? {} : { dryRun }),
      });
      expect(refused.error).toStartWith("forbidden:");
      expect(refused.error).toContain("a person merges");
    }
    expect(await mainTip()).toBe(before);
    expect(getPull(app.db, repo.id, pull.number)!.mergedAt).toBeNull();
  });

  test("the plan says what would land and changes nothing", async () => {
    const pull = await pullOf("planned");
    const before = await mainTip();
    // A read-only token may ask for the plan: it is a read.
    const plan = await tool(aliceRo, { repo: "alice/game", number: pull.number, strategy: "squash" });
    expect(plan.value).toMatchObject({
      dryRun: true,
      number: pull.number,
      state: "open",
      head: "planned",
      base: "main",
      strategy: "squash",
      mergeable: true,
      conflicts: [],
      check: { state: expect.any(String), baseOid: expect.any(String) },
      url: `/alice/game/pulls/${pull.number}`,
    });
    expect(await mainTip()).toBe(before);
    // … and may not land.
    const refused = await tool(aliceRo, { repo: "alice/game", number: pull.number, dryRun: false });
    expect(refused.error).toStartWith("forbidden:");
    expect(getPull(app.db, repo.id, pull.number)!.mergedAt).toBeNull();
  });

  test("a person's rw token merges a clean pull onto the base", async () => {
    const pull = await pullOf("clean");
    const landed = await tool(aliceRw, { repo: "alice/game", number: pull.number, dryRun: false });
    expect(landed.value).toMatchObject({
      dryRun: false,
      merged: true,
      strategy: "merge",
      url: `/alice/game/pulls/${pull.number}`,
    });
    expect(await mainTip()).toBe(landed.value.mergeOid);
    expect(getPull(app.db, repo.id, pull.number)!.mergedAt).not.toBeNull();
    // Once landed, again is mergePull's own refusal.
    const again = await tool(aliceRw, { repo: "alice/game", number: pull.number, dryRun: false });
    expect(again.error).toStartWith("already_merged:");
  });

  test("a conflict is refused in the page's words, and nothing lands", async () => {
    const first = await pullOf("left", "same.txt", "left\n");
    const second = await pullOf("right", "same.txt", "right\n");
    expect((await tool(aliceRw, { repo: "alice/game", number: first.number, dryRun: false })).value.merged).toBe(true);
    const tip = await mainTip();
    const plan = await tool(aliceRw, { repo: "alice/game", number: second.number });
    expect(plan.value.mergeable).toBe(false);
    expect(plan.value.conflicts).toEqual(["same.txt"]);
    const refused = await tool(aliceRw, { repo: "alice/game", number: second.number, dryRun: false });
    expect(refused.error).toStartWith("conflict:");
    expect(refused.error).toContain("The branches conflict in 1 file");
    expect(await mainTip()).toBe(tip);
  });

  test("a person who cannot write is refused by mergePull", async () => {
    const pull = await pullOf("not-yours");
    const refused = await tool(bobRw, { repo: "alice/game", number: pull.number, dryRun: false });
    expect(refused.error).toStartWith("forbidden:");
    expect(getPull(app.db, repo.id, pull.number)!.mergedAt).toBeNull();
  });

  test("bad input stops at the boundary", async () => {
    const pull = await pullOf("bad-input");
    const base = { repo: "alice/game", number: pull.number, dryRun: false };
    expect((await tool(aliceRw, { ...base, strategy: "rebase" })).error).toContain(
      "strategy is merge or squash",
    );
    expect((await tool(aliceRw, { ...base, number: 9999 })).error).toContain("no pull #9999");
    expect((await tool(aliceRw, { ...base, number: "1" })).error).toContain("no_such_pull");
    expect((await tool(aliceRw, { ...base, repo: "nope" })).error).toStartWith("not_found:");
    expect(getPull(app.db, repo.id, pull.number)!.mergedAt).toBeNull();
  });
});
