/**
 * What the tokens bought (#798): spend set against what it landed, on a
 * fixture with a landed change, a failed run, a cancelled run and an issue
 * closed with nothing merged — and none of it for a reader or a stranger.
 * The refusals come first.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { enableApp } from "../src/actions/apps.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openIssue, setIssueState } from "../src/actions/issues.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { addDependency } from "../src/core/dependencies.ts";
import { getIssueById, type Issue } from "../src/core/issues.ts";
import type { Repo } from "../src/core/repos.ts";
import { reasonOf, tokenReturns, type PillarReturn } from "../src/core/returns.ts";
import { createRun } from "../src/core/runs.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const PASSWORD = "a-long-returns-passphrase";

describe("what the tokens bought", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let alice: User;
  let bob: User;
  let repo: Repo;
  let aliceCookie = "";
  let bobCookie = "";
  let aliceRw = "";
  let bobRw = "";

  const signIn = async (username: string): Promise<string> => {
    const res = await fetch(`${servers.url}/signin`, {
      method: "POST",
      body: new URLSearchParams({ username, password: PASSWORD }),
      redirect: "manual",
    });
    return `${(res.headers.get("set-cookie") ?? "").split(";")[0]!}; forge_mode=studio`;
  };

  const get = (path: string, auth: { cookie?: string; token?: string } = {}) =>
    fetch(`${servers.url}${path}`, {
      headers: {
        ...(auth.cookie ? { cookie: auth.cookie } : {}),
        ...(auth.token ? { authorization: `Bearer ${auth.token}` } : {}),
      },
      redirect: "manual",
    });

  const mcp = async (token: string, name: string, args: unknown) => {
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
        params: { name, arguments: args },
      }),
    });
    return (
      (await res.json()) as {
        result: { isError?: boolean; content: { text: string }[] };
      }
    ).result;
  };

  /** One agent run, as it ended. */
  const run = (
    issue: Issue,
    state: "ok" | "failed" | "cancelled",
    usd: number,
    options: { branch?: string; summary?: string } = {},
  ): void => {
    const made = createRun(app.db, {
      repoId: repo.id,
      kind: "agent",
      issueId: issue.id,
      branch: options.branch ?? "",
      actorId: getUserByName(app.db, "bot")!.id,
      reason: "assigned",
    });
    const start = new Date(Date.now() - 20 * 60_000).toISOString();
    app.db
      .query(
        `UPDATE run SET state = ?2, cost_usd = ?3, summary = ?4, started_at = ?5,
           finished_at = ?6 WHERE id = ?1`,
      )
      .run(
        made.id,
        state,
        usd,
        options.summary ?? state,
        start,
        new Date().toISOString(),
      );
  };

  const pullFrom = async (issue: Issue, branch: string) => {
    await commitToBranch(app, alice, repo, {
      branch,
      base: "main",
      message: branch,
      files: [{ path: `${branch.replace(/\W/g, "-")}.md`, content: "work\n" }],
    });
    const opened = await openPull(app, getUserByName(app.db, "bot")!, repo, {
      title: `Work on #${issue.number}`,
      body: `Closes #${issue.number}`,
      baseBranch: "main",
      headBranch: branch,
    });
    if (!opened.ok) throw new Error(String(opened.error));
    return opened.value;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-returns-"));
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
    const b = await createUser(app.db, { origin: "seed", username: "bob", email: "bob@forge.local", password: PASSWORD, trusted: true });
    if (!a.ok || !b.ok) throw new Error("users");
    alice = a.value;
    bob = b.value;
    aliceCookie = await signIn("alice");
    bobCookie = await signIn("bob");
    aliceRw = createToken(app.db, alice.id, "rw", "rw").token;
    bobRw = createToken(app.db, bob.id, "rw", "rw").token;
    // Public: bob can read it, and must still learn nothing of its spend.
    const made = await createRepo(app, alice, {
      name: "mill",
      visibility: "public",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    await commitToBranch(app, alice, repo, {
      message: "seed",
      files: [{ path: "README.md", content: "# mill\n" }],
    });
    await createAgent(app, alice, { username: "bot" });
    addToCrew(app, alice, repo, "bot");

    const issue = (title: string): Issue => {
      const opened = openIssue(app, alice, repo, { title });
      if (!opened.ok) throw new Error(String(opened.error));
      return opened.value;
    };
    // Landed: a failed try, then a good run whose pull merged.
    const landed = issue("Landed work");
    run(landed, "failed", 0.5, { summary: "failed: the check is red" });
    run(landed, "ok", 1, { branch: "bot/1-landed" });
    const pull = await pullFrom(landed, "bot/1-landed");
    app.db
      .query("UPDATE pull SET merged_at = ?2 WHERE issue_id = ?1")
      .run(pull.id, new Date().toISOString());
    // Closed with nothing merged: a declining run, the issue closed, no reason given.
    const declined = issue("Declined work");
    run(declined, "failed", 2, {
      summary: "declined: I had no feedback to act on, so I changed nothing.",
    });
    setIssueState(
      app,
      alice,
      repo,
      getIssueById(app.db, declined.id)!,
      "closed",
    );
    // Closed as not doing: a good run whose pull closed unmerged.
    const dropped = issue("Dropped work");
    run(dropped, "ok", 0.4, { branch: "bot/3-dropped" });
    const droppedPull = await pullFrom(dropped, "bot/3-dropped");
    setIssueState(
      app,
      alice,
      repo,
      getIssueById(app.db, droppedPull.id)!,
      "closed",
    );
    setIssueState(
      app,
      alice,
      repo,
      getIssueById(app.db, dropped.id)!,
      "closed",
    );
    // Still open: a cancelled run.
    run(issue("Open work"), "cancelled", 0.1);
  }, 30_000);

  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a reader and an anonymous visitor get none of it", async () => {
    expect((await get("/api/v1/returns")).status).toBe(401);
    const bobs = (await (
      await get("/api/v1/returns", { token: bobRw })
    ).json()) as { spent: { runs: number }; repos: string[] };
    expect(bobs.repos).toEqual([]);
    expect(bobs.spent.runs).toBe(0);
    expect(
      (await get("/api/v1/returns?repo=alice/mill", { token: bobRw })).status,
    ).toBe(404);
    expect((await mcp(bobRw, "returns", { repo: "alice/mill" })).isError).toBe(
      true,
    );
    expect(
      (await get("/board/returns?apps=alice/mill", { cookie: bobCookie }))
        .status,
    ).toBe(404);
    const board = await (await get("/board", { cookie: bobCookie })).text();
    expect(board).not.toContain('id="returns-line"');
    // Nor may a reader report spend here.
    const report = await fetch(`${servers.url}/api/v1/repos/alice/mill/spend`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bobRw}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ who: "bob's assistant", usd: 5 }),
    });
    expect(report.status).toBe(404);
  });

  test("the numbers add up: landed, failed, cancelled, closed with nothing merged", () => {
    const now = new Date(Date.now() + 1000);
    const r = tokenReturns(app.db, [repo.id], {
      since: new Date(now.getTime() - 7 * 86_400_000).toISOString(),
      until: now.toISOString(),
    });
    expect(r.spent).toEqual({ runs: 5, usd: 4 });
    expect(r.byState).toEqual({
      ok: { runs: 2, usd: 1.4 },
      failed: { runs: 2, usd: 2.5 },
      cancelled: { runs: 1, usd: 0.1 },
    });
    expect(r.landed).toBe(1);
    // The failed try counts toward the change that landed: it is part of its cost.
    expect(r.onLanded).toEqual({
      runs: 2,
      usd: 1.5,
      perChange: { median: 1.5, total: 1.5, changes: 1 },
    });
    expect(r.landedNothing.usd).toBe(2.5);
    expect(r.landedNothing.closed).toEqual({ runs: 2, usd: 2.4 });
    expect(r.landedNothing.open).toEqual({ runs: 1, usd: 0.1 });
    expect(r.landedNothing.failed).toEqual({ runs: 1, usd: 2 });
    expect(r.landedNothing.cancelled).toEqual({ runs: 1, usd: 0.1 });
    expect(r.landedNothing.topFailures[0]).toEqual({
      reason: "declined: I had no feedback to act on",
      runs: 1,
      usd: 2,
    });
    expect(r.onLanded.usd + r.landedNothing.usd).toBeCloseTo(r.spent.usd, 2);
    expect(r.costliest.map((c) => [c.title, c.outcome])).toEqual([
      ["Declined work", "closed"],
      ["Landed work", "landed"],
      ["Dropped work", "closed"],
      ["Open work", "open"],
    ]);
    expect(r.okRun.minutes.median).toBe(20);
  });

  test("a failure reason groups its repeats", () => {
    expect(
      reasonOf(
        "declined: The newest comment on #631 is my own reply again, not feedback",
      ),
    ).toBe(
      reasonOf(
        "declined: The newest comment on #12 is my own previous reply, so nothing",
      ),
    );
  });

  test("the owner sees one line on the board, one tap to the breakdown, and the same over the API and MCP", async () => {
    const board = await (await get("/board", { cookie: aliceCookie })).text();
    const line = /<a class="muted small" id="returns-line"[^>]*>([\s\S]*?)<\/a>/
      .exec(board)?.[1]
      ?.replace(/\s+/g, " ");
    expect(line).toContain("<b>$4.00</b> → <b>1</b> landed");
    expect(line).toContain("<b>$1.50</b> a landed change");
    // What did not land, split: closed with nothing is spent and gone; still
    // open is not an answer yet, and is never counted as waste.
    expect(line).toContain("<b>$2.40</b> closed with nothing");
    expect(line).toContain("<b>$0.10</b> still open");
    expect(line).not.toContain("landed nothing");
    // The spend line's way to the fleet graph: the viewer's whole selection,
    // the graph's own default, when nothing narrows the board (#578).
    expect(board).toContain('<a id="returns-graph" href="/fleet/graph">Fleet graph</a>');
    // Narrowed to something holding none of her money (mill is no app, so
    // not on the board): no line and no graph link, never the whole fleet.
    const narrowed = await (await get("/board?apps=alice/mill", { cookie: aliceCookie })).text();
    expect(narrowed).not.toContain('id="returns-line"');
    expect(narrowed).not.toContain('id="returns-graph"');
    // Once mill is an app the narrowed board carries it, and the graph only it.
    const enabled = enableApp(app, alice, repo, { slug: "mill" });
    if (!enabled.ok) throw new Error(String(enabled.error));
    const asked = await (await get("/board?apps=alice/mill", { cookie: aliceCookie })).text();
    expect(asked).toContain('<a id="returns-graph" href="/fleet/graph?repo=alice%2Fmill">Fleet graph</a>');
    const page = (
      await (await get("/board/returns", { cookie: aliceCookie })).text()
    ).replace(/\s+/g, " ");
    expect(page).toContain("What the tokens bought, 7 days");
    expect(page).toContain("of which: declined: I had no feedback to act on");
    expect(page).toContain("$2.40 closed with nothing · $0.10 still open");
    expect(page).toContain("closed with nothing merged");
    const api = (await (
      await get("/api/v1/returns?repo=alice/mill", { token: aliceRw })
    ).json()) as { spent: { usd: number } };
    expect(api.spent.usd).toBe(4);
    const tool = await mcp(aliceRw, "returns", {});
    expect(JSON.parse(tool.content[0]!.text).landed).toBe(1);
    expect(
      (await get("/api/v1/returns?days=0", { token: aliceRw })).status,
    ).toBe(422);
  });

  test("the line carries the day's median ask→live beside the dollars once a production deploy served a landing", async () => {
    const before = await (await get("/board", { cookie: aliceCookie })).text();
    expect(before).not.toContain("median ask→live");
    const merged = app.db
      .query<{ merged_at: string }, []>("SELECT merged_at FROM pull WHERE merged_at IS NOT NULL ORDER BY merged_at DESC LIMIT 1")
      .get();
    expect(merged).not.toBeNull();
    // Served the instant it merged; the ask was exactly three hours before: 3.0 h.
    const at = merged!.merged_at;
    app.db
      .query(
        `UPDATE issue SET created_at = ?1 WHERE kind = 'issue' AND repo_id = ?3 AND number IN (
           SELECT CAST(substr(i.body, 9) AS INTEGER) FROM pull p JOIN issue i ON i.id = p.issue_id WHERE p.merged_at = ?2)`,
      )
      .run(new Date(Date.parse(at) - 3 * 3_600_000).toISOString(), at, repo.id);
    const dep = createRun(app.db, { repoId: repo.id, kind: "deploy", env: "production" });
    app.db.query("UPDATE run SET state = 'ok', created_at = ?1, serving_at = ?1 WHERE id = ?2").run(at, dep.id);
    const board = await (await get("/board", { cookie: aliceCookie })).text();
    const line = /<a class="muted small" id="returns-line"[^>]*>([\s\S]*?)<\/a>/.exec(board)?.[1]?.replace(/\s+/g, " ");
    expect(line).toContain("median ask→live <b>3.0 h</b> (24 h)");
    expect(line).toContain("<b>$4.00</b> → <b>1</b> landed");
  });

  test("spend reported from outside shows apart and is never added in", async () => {
    const post = (payload: unknown) =>
      fetch(`${servers.url}/api/v1/repos/alice/mill/spend`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${aliceRw}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      });
    expect((await post({ who: "", usd: 1 })).status).toBe(422);
    expect((await post({ who: "the build team" })).status).toBe(422);
    expect((await post({ who: "the build team", usd: -1 })).status).toBe(422);
    expect(
      (await post({ who: "the build team", usd: 1, issue: 999 })).status,
    ).toBe(422);
    const made = await post({
      who: "the build team",
      model: "claude-opus-5-5",
      tokensIn: 1000,
      tokensOut: 200,
      usd: 3.25,
      issue: 1,
    });
    expect(made.status).toBe(201);
    const viaMcp = await mcp(aliceRw, "spend", {
      repo: "alice/mill",
      who: "my assistant",
      usd: 0.75,
    });
    expect(viaMcp.isError).toBeUndefined();
    const api = (await (
      await get("/api/v1/returns?repo=alice/mill", { token: aliceRw })
    ).json()) as {
      spent: { usd: number };
      outside: { who: string; reports: number; tokensIn: number; tokensOut: number; usd: number }[];
    };
    expect(api.spent.usd).toBe(4);
    expect(api.outside).toEqual([
      {
        who: "the build team",
        reports: 1,
        tokensIn: 1000,
        tokensOut: 200,
        usd: 3.25,
      },
      { who: "my assistant", reports: 1, tokensIn: 0, tokensOut: 0, usd: 0.75 },
    ]);
    const page = (
      await (await get("/board/returns", { cookie: aliceCookie })).text()
    ).replace(/\s+/g, " ");
    expect(page).toContain("Reported from outside");
    expect(page).toContain("the build team");
  });
  test("an open change with nothing merged is still open, never closed with nothing", async () => {
    const opened = openIssue(app, alice, repo, { title: "Open, with a pull" });
    if (!opened.ok) throw new Error(String(opened.error));
    run(opened.value, "ok", 0.7, { branch: "bot/9-open" });
    await pullFrom(opened.value, "bot/9-open");
    const now = new Date(Date.now() + 1000);
    const r = tokenReturns(app.db, [repo.id], {
      since: new Date(now.getTime() - 7 * 86_400_000).toISOString(),
      until: now.toISOString(),
    });
    expect(r.landedNothing.open).toEqual({ runs: 2, usd: 0.8 });
    expect(r.landedNothing.closed).toEqual({ runs: 2, usd: 2.4 });
  });

  test("by pillar: dollars, landed changes, closed and open add up; a reader gets none", async () => {
    const byTitle = (t: string): Issue =>
      getIssueById(
        app.db,
        app.db.query<{ id: string }, [string]>("SELECT id FROM issue WHERE title = ?1").get(t)!.id,
      )!;
    for (const [umbrella, children] of [
      ["P1 Ship: it", ["Landed work", "Declined work"]],
      ["P2 Tidy: up", ["Dropped work", "Open work"]],
    ] as const) {
      const made = openIssue(app, alice, repo, { title: umbrella });
      if (!made.ok) throw new Error(String(made.error));
      for (const c of children)
        addDependency(app.db, made.value, byTitle(c), alice.id);
    }
    const now = new Date(Date.now() + 1000);
    const r = tokenReturns(app.db, [repo.id], {
      since: new Date(now.getTime() - 7 * 86_400_000).toISOString(),
      until: now.toISOString(),
    });
    expect(r.byPillar.map((b) => b.pillar)).toEqual(["P1 Ship", "P2 Tidy", "no pillar"]);
    const [p1, p2, none] = r.byPillar as [PillarReturn, PillarReturn, PillarReturn];
    expect([p1.runs, p1.usd, p1.changes, p1.perChange]).toEqual([3, 3.5, 1, 1.5]);
    expect(p1.closed).toEqual({ runs: 1, usd: 2 });
    expect(p1.open).toEqual({ runs: 0, usd: 0 });
    expect([p2.runs, p2.usd, p2.changes, p2.perChange]).toEqual([2, 0.5, 0, 0]);
    expect(p2.closed).toEqual({ runs: 1, usd: 0.4 });
    expect(p2.open).toEqual({ runs: 1, usd: 0.1 });
    expect(none.usd).toBe(0.7);
    expect(r.byPillar.reduce((sum, b) => sum + b.usd, 0)).toBeCloseTo(r.spent.usd, 2);

    const page = await (await get("/board/returns", { cookie: aliceCookie })).text();
    expect(page).toContain("By pillar");
    expect(page).toContain("P1 Ship");
    const apiRead = (await (
      await get("/api/v1/returns", { token: aliceRw })
    ).json()) as { byPillar: PillarReturn[] };
    expect(apiRead.byPillar).toEqual(JSON.parse(JSON.stringify(r.byPillar)));
    const toolRead = JSON.parse((await mcp(aliceRw, "returns", {})).content[0]!.text) as {
      byPillar: PillarReturn[];
    };
    expect(toolRead.byPillar).toEqual(apiRead.byPillar);
    const bobTool = await mcp(bobRw, "returns", {});
    expect(bobTool.isError ? "" : bobTool.content[0]!.text).not.toContain("P1 Ship");
    const bobs = (await (await get("/api/v1/returns", { token: bobRw })).json()) as {
      byPillar: unknown[];
    };
    expect(bobs.byPillar).toEqual([]);
    const theirs = await (await get("/board/returns", { cookie: bobCookie })).text();
    expect(theirs).not.toContain("By pillar");
    expect(theirs).not.toContain("P1 Ship");
    expect((await get("/board/returns")).status).not.toBe(200);
  });
});
