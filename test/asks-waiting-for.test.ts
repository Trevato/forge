/**
 * Every ask row says what it waits for (#1825): one pure word, and the
 * same word on the home, in `/api/v1/asks` and in the MCP `asks` tool.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { waitingFor, type WaitFacts } from "../src/core/waiting_for.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { askLinesFor } from "../src/web/studio/asks.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const facts = (over: Partial<WaitFacts>): WaitFacts => ({
  kind: "look",
  conflicts: 0,
  assignedToViewer: false,
  who: "bot",
  ...over,
});

describe("waitingFor", () => {
  test("a green change is ready to land, on you", () => {
    expect(waitingFor(facts({}))).toEqual({ word: "ready to land", on: "you" });
  });
  test("a change that cannot merge conflicts with main, on its author", () => {
    expect(waitingFor(facts({ kind: "stopped", conflicts: 2 }))).toEqual({
      word: "conflicts with main",
      on: "bot",
    });
  });
  test("a review or a handover waits for a review", () => {
    for (const kind of ["review", "handover"] as const)
      expect(waitingFor(facts({ kind })).word).toBe("a review");
  });
  test("a stop, a park, a decline and a pause are decisions", () => {
    for (const kind of ["stopped", "parked", "declined", "paused"] as const)
      expect(waitingFor(facts({ kind }))).toEqual({ word: "a decision", on: "you" });
  });
  test("what is assigned to the viewer says so, unless a more specific word applies", () => {
    expect(waitingFor(facts({ kind: "parked", assignedToViewer: true })).word).toBe(
      "assigned to you",
    );
    expect(waitingFor(facts({ kind: "look", assignedToViewer: true })).word).toBe(
      "ready to land",
    );
  });
});

describe("the word on a row", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let alice: User;
  let cookie = "";
  let token = "";

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-asks-waiting-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-long-waiting-passphrase",
      adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    alice = made.value;
    const res = await fetch(`${servers.url}/signin`, {
      method: "POST",
      body: new URLSearchParams({ username: "alice", password: "a-long-waiting-passphrase" }),
      redirect: "manual",
    });
    cookie = `${(res.headers.get("set-cookie") ?? "").split(";")[0]!}; forge_mode=studio`;
    token = createToken(app.db, alice.id, "ro", "ro").token;
    const repo = await createRepo(app, alice, { name: "wait", visibility: "public" });
    if (!repo.ok) throw new Error(String(repo.error));
    await commitToBranch(app, alice, repo.value, {
      message: "seed",
      files: [{ path: "README.md", content: "# wait\n" }],
    });
    await commitToBranch(app, alice, repo.value, {
      branch: "feat",
      base: "main",
      message: "Feature",
      files: [{ path: "F.md", content: "f\n" }],
    });
    const pull = await openPull(app, alice, repo.value, {
      title: "Feature <b>",
      body: "",
      baseBranch: "main",
      headBranch: "feat",
    });
    if (!pull.ok) throw new Error(String(pull.error));
    const run = createRun(app.db, {
      repoId: repo.value.id,
      kind: "check",
      issueId: pull.value.id,
      env: `pull-${pull.value.number}`,
      commitOid: pull.value.headOid,
      reason: "pull",
    });
    claimRun(app.db, run.id);
    finishRun(app.db, run.id, { state: "ok", summary: "green" });
  }, 30_000);

  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the asks page, /api/v1/asks and MCP give the same word for the same row", async () => {
    const lines = askLinesFor(app.db, alice);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.waitingFor).toEqual({ word: "ready to land", on: "you" });

    const api = await fetch(`${servers.url}/api/v1/asks`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const apiRows = ((await api.json()) as { rows: { id: string; waitingFor: unknown }[] }).rows;
    expect(apiRows.map((r) => r.waitingFor)).toEqual([lines[0]!.waitingFor]);

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
    const text = await mcp.text();
    expect(text).toContain("ready to land");
    expect(text).toContain("waitingFor");

    const page = await (await fetch(`${servers.url}/asks`, { headers: { cookie } })).text();
    expect(page).toContain('data-waiting="ready to land"');
    expect(page).toContain('<span class="sr-only">waiting for </span>ready to land');
    expect(page).toContain("ready to land · on you");
    expect(page).not.toContain("Feature <b>");
  });
});
