/** `feed_chips` through `/mcp`: a switched-off chip leaves `feed` and `asks`, bad input stores nothing, and chips are one's own. */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { assignIssue } from "../src/actions/issues.ts";
import { createOrg } from "../src/actions/orgs.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { chipsOf } from "../src/core/feed_chips.ts";
import { getIssueById } from "../src/core/issues.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";
import { mcpTool } from "./helpers/mcp.ts";

quietLogs();
setDefaultTimeout(30_000);

describe("MCP feed_chips", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let alice: User;
  let bob: User;
  let aliceTok = "";
  let bobTok = "";
  let pullId = "";

  const chips = (tok: string, args: unknown = {}) => mcpTool(servers.url, tok, "feed_chips", args);
  const feedIds = async (tok: string): Promise<string[]> =>
    ((await mcpTool(servers.url, tok, "feed", {})).value.items as { id: string }[]).map((i) => i.id);
  const askCount = async (tok: string): Promise<number> =>
    (await mcpTool(servers.url, tok, "asks", {})).value.rows.length;
  const pullItem = async (tok: string) =>
    ((await mcpTool(servers.url, tok, "feed", {})).value.items as { id: string; kind: string }[]).filter(
      (i) => i.kind === "pull",
    );

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-feed-chips-"));
    app = createApp({ dataDir, port: 0, disk: () => ({ freeBytes: 500e9, totalBytes: 1000e9 }) });
    servers = await serve(app);
    for (const name of ["alice", "bob"]) {
      const made = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username: name,
        email: `${name}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst: name === "alice",
      });
      if (!made.ok) throw new Error(made.error);
      if (name === "alice") alice = made.value;
      else bob = made.value;
    }
    aliceTok = createToken(app.db, alice.id, "rw", "rw").token;
    bobTok = createToken(app.db, bob.id, "rw", "rw").token;
    await createAgent(app, alice, { username: "bot" });
    const made = await createRepo(app, alice, { name: "open", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    const repo = made.value;
    await commitToBranch(app, alice, repo, {
      message: "seed",
      files: [{ path: "README.md", content: "# open\n" }],
    });
    addToCrew(app, alice, repo, "bot");
    await commitToBranch(app, alice, repo, {
      branch: "bot/1",
      base: "main",
      message: "Chip work",
      files: [{ path: "F.md", content: "1\n" }],
    });
    const opened = await openPull(app, getUserByName(app.db, "bot")!, repo, {
      title: "Chip work",
      body: "",
      baseBranch: "main",
      headBranch: "bot/1",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    pullId = opened.value.id;
    const run = createRun(app.db, {
      repoId: repo.id,
      kind: "check",
      issueId: pullId,
      env: `pull-${opened.value.number}`,
      commitOid: opened.value.headOid,
      reason: "pull",
    });
    claimRun(app.db, run.id);
    finishRun(app.db, run.id, { state: "ok", summary: "ok" });
    expect(assignIssue(app, alice, repo, getIssueById(app.db, pullId)!, alice).ok).toBe(true);
    if (!createOrg(app, alice, "guild").ok) throw new Error("org");
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("with no kind it lists the switched-off chips, none at first", async () => {
    expect((await chips(aliceTok)).value).toEqual({ kinds: [], people: [] });
  });

  test("a kind chip switched off leaves the pull out of feed and asks; on brings it back", async () => {
    expect(await pullItem(aliceTok)).toHaveLength(1);
    expect(await askCount(aliceTok)).toBe(1);
    const off = await chips(aliceTok, { kind: "kind", value: "reviews", hidden: true });
    expect(off.value).toEqual({ kinds: ["reviews"], people: [] });
    expect((await chips(aliceTok)).value.kinds).toEqual(["reviews"]);
    expect(await pullItem(aliceTok)).toHaveLength(0);
    expect(await askCount(aliceTok)).toBe(0);
    const on = await chips(aliceTok, { kind: "kind", value: "reviews", hidden: false });
    expect(on.value).toEqual({ kinds: [], people: [] });
    expect(await pullItem(aliceTok)).toHaveLength(1);
    expect(await askCount(aliceTok)).toBe(1);
  });

  test("a person chip hides that person's items, by username", async () => {
    const off = await chips(aliceTok, { kind: "person", value: "bot", hidden: true });
    expect(off.value).toEqual({ kinds: [], people: ["bot"] });
    expect(await pullItem(aliceTok)).toHaveLength(0);
    expect(await askCount(aliceTok)).toBe(0);
    expect((await chips(aliceTok, { kind: "person", value: "bot", hidden: false })).value.people).toEqual([]);
    expect(await pullItem(aliceTok)).toHaveLength(1);
    expect(await askCount(aliceTok)).toBe(1);
  });

  test("an unknown name or an org answers not_found", async () => {
    for (const value of ["nobody", "guild"]) {
      const r = await chips(aliceTok, { kind: "person", value, hidden: true });
      expect(r.error).toContain("not_found");
    }
    expect(chipsOf(app.db, alice.id).people.size).toBe(0);
  });

  test("a missing or non-boolean hidden, or a kind with no chip, answers invalid and stores nothing", async () => {
    const bads: unknown[] = [
      { kind: "kind", value: "reviews" },
      { kind: "kind", value: "reviews", hidden: "true" },
      { kind: "kind", value: "reviews", hidden: 1 },
      { kind: "person", value: "bot" },
      { kind: "person", value: "bot", hidden: "yes" },
      { kind: "kind", value: "runs", hidden: true },
      { kind: "kind", hidden: true },
    ];
    for (const args of bads) expect((await chips(aliceTok, args)).error).toContain("invalid");
    const stored = chipsOf(app.db, alice.id);
    expect(stored.kinds.size + stored.people.size).toBe(0);
    expect((await chips(aliceTok)).value).toEqual({ kinds: [], people: [] });
  });

  test("one person's chips never change another's feed", async () => {
    const before = await feedIds(bobTok);
    await chips(aliceTok, { kind: "kind", value: "reviews", hidden: true });
    await chips(aliceTok, { kind: "person", value: "bot", hidden: true });
    expect((await chips(bobTok)).value).toEqual({ kinds: [], people: [] });
    expect(await feedIds(bobTok)).toEqual(before);
    expect(await pullItem(bobTok)).toHaveLength(1);
    await chips(aliceTok, { kind: "kind", value: "reviews", hidden: false });
    await chips(aliceTok, { kind: "person", value: "bot", hidden: false });
  });
});
