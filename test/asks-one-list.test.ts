/**
 * What is assigned to you and what asks you are one list (#1826): one row
 * source, so the home, the count and the MCP's `asks` count the same rows,
 * and a pull that is both is one row.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openIssue } from "../src/actions/issues.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { recordInteraction, removeMutes } from "../src/core/interactions.ts";
import { getIssueById, setAssignee } from "../src/core/issues.ts";
import type { Repo } from "../src/core/repos.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { applyAsksBulk, undoAsksBulk } from "../src/actions/asks_bulk.ts";
import { askCountFor, askLinesFor } from "../src/web/studio/asks.ts";
import { readFeed } from "../src/feed/feed.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("one list", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let alice: User;
  let repo: Repo;
  let cookie = "";
  let token = "";

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-asks-one-list-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const made = await createUser(app.db, {
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-long-one-list-passphrase",
      adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    alice = made.value;
    const res = await fetch(`${servers.url}/signin`, {
      method: "POST",
      body: new URLSearchParams({ username: "alice", password: "a-long-one-list-passphrase" }),
      redirect: "manual",
    });
    cookie = `${(res.headers.get("set-cookie") ?? "").split(";")[0]!}; forge_mode=studio`;
    token = createToken(app.db, alice.id, "ro", "ro").token;
    const made2 = await createRepo(app, alice, { name: "one", visibility: "public" });
    if (!made2.ok) throw new Error(String(made2.error));
    repo = made2.value;
    await commitToBranch(app, alice, repo, {
      message: "seed",
      files: [{ path: "README.md", content: "# one\n" }],
    });
  }, 30_000);

  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  /** The three doors' counts of the same rows. */
  const counts = async () => {
    const mcp = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "asks", arguments: {} },
      }),
    });
    const body = JSON.parse(await mcp.text().then((t) => t.slice(t.indexOf("{")))) as {
      result: { content: { text: string }[] };
    };
    const answer = JSON.parse(body.result.content[0]!.text) as { rows: unknown[]; forge: unknown[] };
    const home = await (await fetch(`${servers.url}/live/on-you`, { headers: { cookie } })).text();
    const said = /(\d+) things? needs? you/.exec(home);
    return {
      header: askCountFor({ app, auth: { user: alice } } as never, alice),
      mcp: answer.rows.length + answer.forge.length,
      home: said === null ? 0 : Number(said[1]),
      html: home,
    };
  };

  test("an issue assigned to you is a row that says so, and every door counts it", async () => {
    const made = openIssue(app, alice, repo, { title: "Sweep <the> path", body: "" });
    if (!made.ok) throw new Error(String(made.error));
    const before = await counts();
    setAssignee(app.db, made.value.id, alice.id);
    const after = await counts();
    expect(after.header).toBe(before.header + 1);
    expect(after.mcp).toBe(after.header);
    expect(after.home).toBe(after.header);
    expect(after.html).toContain('data-waiting="assigned to you"');
    expect(after.html).toContain("Sweep &lt;the&gt; path");
    const row = askLinesFor(app.db, alice).find((l) => l.id === `assigned:${made.value.id}`);
    expect(row?.waitingFor).toEqual({ word: "assigned to you", on: "you" });
    // Mute silences it for this person; listening again brings it back.
    recordInteraction(app.db, {
      viewerId: alice.id,
      itemId: `repo:${repo.id}`,
      kind: "muted",
      repoId: repo.id,
      actorId: null,
    });
    expect(askLinesFor(app.db, alice).some((l) => l.id === `assigned:${made.value.id}`)).toBe(false);
    expect((await counts()).header).toBe(before.header);
    removeMutes(app.db, alice.id, [`repo:${repo.id}`]);
    expect((await counts()).header).toBe(after.header);
    setAssignee(app.db, made.value.id, null);
  });

  test("a green pull that is an ask and assigned to you counts once", async () => {
    await commitToBranch(app, alice, repo, {
      branch: "feat",
      base: "main",
      message: "Feature",
      files: [{ path: "F.md", content: "f\n" }],
    });
    const pull = await openPull(app, alice, repo, {
      title: "Feature",
      body: "",
      baseBranch: "main",
      headBranch: "feat",
    });
    if (!pull.ok) throw new Error(String(pull.error));
    const run = createRun(app.db, {
      repoId: repo.id,
      kind: "check",
      issueId: pull.value.id,
      env: `pull-${pull.value.number}`,
      commitOid: pull.value.headOid,
      reason: "pull",
    });
    claimRun(app.db, run.id);
    finishRun(app.db, run.id, { state: "ok", summary: "green" });
    const unassigned = await counts();
    setAssignee(app.db, pull.value.id, alice.id);
    const assigned = await counts();
    expect(assigned.header).toBe(unassigned.header);
    expect(assigned.mcp).toBe(assigned.header);
    expect(assigned.home).toBe(assigned.header);
    const ids = askLinesFor(app.db, alice).flatMap((l) => l.items);
    expect(ids.filter((i) => i.endsWith(pull.value.id))).toEqual([`look:${pull.value.id}`]);
    expect(assigned.html).toContain('data-waiting="ready to land"');
    expect(assigned.html).not.toContain('data-waiting="assigned to you"');
  });
  test("declining an assigned row sets it aside, and undo brings it back", async () => {
    const made = openIssue(app, alice, repo, { title: "Set me aside", body: "" });
    if (!made.ok) throw new Error(String(made.error));
    setAssignee(app.db, made.value.id, alice.id);
    const id = `assigned:${made.value.id}`;
    const listed = () => askLinesFor(app.db, alice).some((l) => l.id === id);
    expect(listed()).toBe(true);
    const done = await applyAsksBulk(app, alice, "decline", [id]);
    if (!done.ok) throw new Error(done.error.message);
    expect(done.value.skipped).toEqual([]);
    expect(listed()).toBe(false);
    expect((await counts()).home).toBe(askCountFor({ app, auth: { user: alice } } as never, alice));
    expect((await undoAsksBulk(app, alice, done.value.id)).ok).toBe(true);
    expect(listed()).toBe(true);
    setAssignee(app.db, made.value.id, null);
  });

  test("close, mute and ship act on assigned rows; ship refuses a plain issue", async () => {
    const made = openIssue(app, alice, repo, { title: "Close or ship me", body: "" });
    if (!made.ok) throw new Error(String(made.error));
    setAssignee(app.db, made.value.id, alice.id);
    const id = `assigned:${made.value.id}`;
    const listed = () => askLinesFor(app.db, alice).some((l) => l.id === id);

    const shipped = await applyAsksBulk(app, alice, "ship", [id]);
    if (!shipped.ok) throw new Error(shipped.error.message);
    expect(shipped.value.skipped).toEqual([]);
    expect(shipped.value.rows.map((r) => [r.outcome, r.reason])).toEqual([
      ["refused", "not a change"],
    ]);
    expect(getIssueById(app.db, made.value.id)!.state).toBe("open");
    expect(listed()).toBe(true);

    const closed = await applyAsksBulk(app, alice, "close", [id], "done elsewhere");
    if (!closed.ok) throw new Error(closed.error.message);
    expect(closed.value.rows.map((r) => r.outcome)).toEqual(["ok"]);
    expect(getIssueById(app.db, made.value.id)!.state).toBe("closed");
    expect(listed()).toBe(false);
    expect((await undoAsksBulk(app, alice, closed.value.id)).ok).toBe(true);
    expect(getIssueById(app.db, made.value.id)!.state).toBe("open");
    expect(listed()).toBe(true);

    const muted = await applyAsksBulk(app, alice, "mute", [id]);
    if (!muted.ok) throw new Error(muted.error.message);
    expect(muted.value.rows.map((r) => r.outcome)).toEqual(["ok"]);
    expect(listed()).toBe(false);
    expect((await undoAsksBulk(app, alice, muted.value.id)).ok).toBe(true);
    expect(listed()).toBe(true);
    setAssignee(app.db, made.value.id, null);
  });

  test("the home's feed page is never filled by the asks pinned above it", async () => {
    const opened: string[] = [];
    for (let n = 0; n < 4; n++) {
      const made = openIssue(app, alice, repo, { title: `Pinned ${n}`, body: "" });
      if (!made.ok) throw new Error(String(made.error));
      setAssignee(app.db, made.value.id, alice.id);
      opened.push(made.value.id);
    }
    const limit = 3;
    // Without the option, the asks fill the page: the test bites.
    const all = readFeed(app.db, alice, { limit }).items;
    expect(all.filter((i) => i.kind === "ask").length).toBe(limit);
    const page = readFeed(app.db, alice, { limit, withoutAsks: true }).items;
    expect(page.length).toBeGreaterThan(0);
    expect(page.some((i) => i.kind === "ask" || i.id.startsWith("ask:"))).toBe(false);
    for (const id of opened) setAssignee(app.db, id, null);
  });
});
