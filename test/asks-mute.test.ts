/**
 * Muting a repository from the home's needs-you (#1597): its asks leave the
 * viewer's home, `/api/v1/asks` (and so the inbox and the phone, which read
 * `askLinesFor`) and On you; they still exist, and still count on the
 * repository's own page. Unmuting brings them back.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { assignIssue } from "../src/actions/issues.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { getIssueById } from "../src/core/issues.ts";
import { createApp as createAppRecord } from "../src/core/apps.ts";
import { setChip } from "../src/core/feed_chips.ts";
import { mutedRepos } from "../src/core/interactions.ts";
import type { Repo } from "../src/core/repos.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { mcpTool } from "./helpers/mcp.ts";
import { askCountFor, askLinesFor, forgeNeedsFor, repoAsks } from "../src/web/studio/asks.ts";
import { quietLogs } from "./helpers/globals.ts";
import { listAt } from "./mcp-list.ts";

quietLogs();
// Every test here is HTTP round trips against a server on a shared machine: the 5s default measures its load, not the code.
setDefaultTimeout(30_000);

const PASSWORD = "a-long-mute-passphrase";

describe("muting a repository's asks", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let alice: User;
  let bob: User;
  let cookie = "";
  let bobCookie = "";
  let repo: Repo;
  let pullId = "";

  const headers = (c: string) => ({ cookie: `${c}; forge_mode=studio`, origin: servers.url });
  const post = (c: string, path: string, fields: [string, string][]) =>
    fetch(`${servers.url}${path}`, {
      method: "POST",
      headers: headers(c),
      body: new URLSearchParams(fields),
      redirect: "manual",
    });
  const onYou = async () =>
    await fetch(`${servers.url}/live/on-you`, { headers: headers(cookie) }).then((r) => r.text());
  const apiAsks = async () => {
    const token = createToken(app.db, alice.id, "ro", "ro").token;
    const res = await fetch(`${servers.url}/api/v1/asks`, {
      headers: { authorization: `Bearer ${token}` },
    });
    return ((await res.json()) as { rows: unknown[] }).rows;
  };
  const home = async () =>
    await fetch(`${servers.url}/asks`, { headers: headers(cookie) }).then((r) => r.text());

  const signIn = async (username: string) => {
    const res = await fetch(`${servers.url}/signin`, {
      method: "POST",
      body: new URLSearchParams({ username, password: PASSWORD }),
      redirect: "manual",
    });
    return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-asks-mute-"));
    // The forge's own needs ride in the count: a fixed disk reading keeps the machine's free space out of it.
    app = createApp({ dataDir, port: 0, disk: () => ({ freeBytes: 500e9, totalBytes: 1000e9 }) });
    servers = await serve(app);
    for (const name of ["alice", "bob"]) {
      const made = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username: name,
        email: `${name}@forge.local`,
        password: PASSWORD,
        adminIfFirst: name === "alice",
      });
      if (!made.ok) throw new Error(made.error);
      if (name === "alice") alice = made.value;
      else bob = made.value;
    }
    cookie = await signIn("alice");
    bobCookie = await signIn("bob");
    await createAgent(app, alice, { username: "bot" });
    const made = await createRepo(app, alice, { name: "muted", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    await commitToBranch(app, alice, repo, {
      message: "seed",
      files: [{ path: "README.md", content: "# muted\n" }],
    });
    addToCrew(app, alice, repo, "bot");
    await commitToBranch(app, alice, repo, {
      branch: "bot/1",
      base: "main",
      message: "Muted work",
      files: [{ path: "F.md", content: "1\n" }],
    });
    const opened = await openPull(app, getUserByName(app.db, "bot")!, repo, {
      title: "Muted work",
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
  });

  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the home offers the chip, and a muted repository's pull leaves every list", async () => {
    expect(askLinesFor(app.db, alice)).toHaveLength(1);
    expect(await apiAsks()).toHaveLength(1);
    expect(await onYou()).toContain("Muted work");
    const page = await home();
    expect(page).toContain('action="/asks/mute"');
    expect(page).toContain(`value="${repo.id}"`);

    const res = await post(cookie, "/asks/mute", [["repo", repo.id]]);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/asks?muted=${repo.id}`);
    expect(mutedRepos(app.db, alice.id).has(repo.id)).toBe(true);
    // Idempotent: twice is the same as once.
    await post(cookie, "/asks/mute", [["repo", repo.id]]);
    expect(
      app.db.query("SELECT COUNT(*) AS n FROM interaction WHERE viewer_id = ?1 AND kind = 'muted'").get(alice.id),
    ).toEqual({ n: 1 });

    expect(await onYou()).not.toContain("Muted work");
    expect(await apiAsks()).toHaveLength(0);
    expect(askLinesFor(app.db, alice)).toHaveLength(0);
    // The count also carries the forge's own needs, which an admin has and muting does not touch.
    const ctx = { app, auth: { user: alice } } as never;
    expect(askCountFor(ctx, alice)).toBe(forgeNeedsFor(ctx, alice).length);
    // Said, never silent: the home names what it is holding back.
    const muted = await home();
    expect(muted).not.toContain('action="/asks/mute"');
    expect(muted).toContain("Listen again");
  });

  test("the ask still exists and still counts on the repository's own page", async () => {
    expect(repoAsks(app.db, alice, repo)).toEqual({ count: 1, muted: true });
    // The repository's page is the app's once it is one.
    expect(createAppRecord(app.db, { repoId: repo.id, slug: "muted", access: "public" }).ok).toBe(true);
    const page = await fetch(`${servers.url}/alice/muted`, { headers: headers(cookie) });
    expect(page.status).toBe(200);
    const text = await page.text();
    expect(text).toContain('id="repo-asks"');
    expect(text).toContain("(muted from your home)");
  });

  test("another person's mute is theirs alone, and a repository they cannot read is refused", async () => {
    expect(mutedRepos(app.db, bob.id).has(repo.id)).toBe(false);
    const bad = await post(bobCookie, "/asks/mute", [["repo", "nope"]]);
    expect(bad.status).toBe(404);
    const secret = await createRepo(app, alice, { name: "secret", visibility: "private" });
    if (!secret.ok) throw new Error(String(secret.error));
    const hidden = await post(bobCookie, "/asks/mute", [["repo", secret.value.id]]);
    expect(hidden.status).toBe(404);
    expect(mutedRepos(app.db, bob.id).size).toBe(0);
    const odd = await post(cookie, "/asks/mute", [["repo", "../x"]]);
    expect(odd.status).toBe(404);
    // A mutation from another origin is refused.
    const cross = await fetch(`${servers.url}/asks/mute`, {
      method: "POST",
      headers: { cookie, origin: "https://evil.example" },
      body: new URLSearchParams({ repo: repo.id }),
      redirect: "manual",
    });
    expect(cross.status).toBeGreaterThanOrEqual(400);
  });

  test("listening again brings the asks back", async () => {
    const res = await post(cookie, "/asks/listen", [["repo", repo.id]]);
    expect(res.status).toBe(303);
    expect(mutedRepos(app.db, alice.id).has(repo.id)).toBe(false);
    expect(await apiAsks()).toHaveLength(1);
    expect(await onYou()).toContain("Muted work");
    expect(repoAsks(app.db, alice, repo)).toEqual({ count: 1, muted: false });
  });

  test("muting and listening keep the reader on the page they were on, with Undo in place", async () => {
    const page = (path: string) => fetch(`${servers.url}${path}`, { headers: headers(cookie) }).then((r) => r.text());
    const res = await post(cookie, "/asks/mute", [["repo", repo.id], ["back", "/asks?kind=pulls"]]);
    expect(res.status).toBe(303);
    const to = res.headers.get("location")!;
    expect(to).toBe(`/asks?kind=pulls&muted=${repo.id}`);
    const flash = await page(to);
    expect(flash).toContain("Muted alice/muted");
    expect(flash).toContain('action="/asks/listen"');
    const back = await post(cookie, "/asks/listen", [["repo", repo.id], ["back", "/asks?kind=pulls"]]);
    expect(back.headers.get("location")).toBe(`/asks?kind=pulls&listened=${repo.id}`);
    expect(await page(back.headers.get("location")!)).toContain("Listening to alice/muted again");
    for (const evil of ["https://evil.example/", "/settings", "//evil.example/asks", "/asksfoo?x=1"]) {
      const r = await post(cookie, "/asks/mute", [["repo", repo.id], ["back", evil]]);
      expect(r.headers.get("location")).toBe(`/asks?muted=${repo.id}`);
    }
    await post(cookie, "/asks/listen", [["repo", repo.id]]);
  });

  test("the flash and its back are guarded: unreadable, malformed and fragment cases render or follow nothing", async () => {
    const page = (c: string, path: string) =>
      fetch(`${servers.url}${path}`, { headers: headers(c) }).then((r) => r.text());
    const secret = await createRepo(app, alice, { name: "hush", visibility: "private" });
    if (!secret.ok) throw new Error(String(secret.error));
    // Bob cannot read it: no flash, even with the id in the address.
    expect(await page(bobCookie, `/asks?muted=${secret.value.id}`)).not.toContain("Muted alice/hush");
    expect(await page(cookie, `/asks?muted=${secret.value.id}`)).toContain("Muted alice/hush");
    // A malformed id renders nothing.
    for (const bad of ["../x", "a b", "x".repeat(65), ""])
      expect(await page(cookie, `/asks?muted=${encodeURIComponent(bad)}`)).not.toContain('class="toast"');
    // A back with a fragment falls back.
    const r = await post(cookie, "/asks/mute", [["repo", repo.id], ["back", "/asks?kind=pulls#x"]]);
    expect(r.headers.get("location")).toBe(`/asks?muted=${repo.id}`);
    await post(cookie, "/asks/listen", [["repo", repo.id]]);
  });

  test("a chip leaves the inbox: the change's chip or its author's, and no other", async () => {
    const bot = getUserByName(app.db, "bot")!;
    const lines = () => askLinesFor(app.db, alice).length;
    expect(lines()).toBe(1);
    // A chip for something else leaves it be.
    setChip(app.db, alice.id, { kind: "kind", value: "decisions" }, true);
    setChip(app.db, alice.id, { kind: "kind", value: "crew" }, true);
    expect(lines()).toBe(1);
    setChip(app.db, alice.id, { kind: "kind", value: "reviews" }, true);
    expect(lines()).toBe(0);
    expect(await apiAsks()).toHaveLength(0);
    setChip(app.db, alice.id, { kind: "kind", value: "reviews" }, false);
    expect(lines()).toBe(1);
    // The author's chip takes it; another person's does not.
    setChip(app.db, alice.id, { kind: "person", value: bob.id }, true);
    expect(lines()).toBe(1);
    setChip(app.db, alice.id, { kind: "person", value: bot.id }, true);
    expect(lines()).toBe(0);
    setChip(app.db, alice.id, { kind: "person", value: bot.id }, false);
    expect(lines()).toBe(1);
  });

  test("MCP asks applies the saved filter, and takes the same filter as arguments", async () => {
    const token = createToken(app.db, alice.id, "ro", "ro").token;
    // Its own preconditions, not the earlier tests' leftovers: listening, and no chip saved.
    app.db.query("DELETE FROM interaction WHERE viewer_id = ?1 AND kind = 'muted'").run(alice.id);
    for (const c of [{ kind: "kind", value: "reviews" }, { kind: "kind", value: "crew" }, { kind: "kind", value: "decisions" }, { kind: "person", value: getUserByName(app.db, "bot")!.id }, { kind: "person", value: bob.id }] as const)
      setChip(app.db, alice.id, c, false);

    const tool = (token: string, name: string, args: unknown = {}) =>
      mcpTool(servers.url, token, name, args);
    const bot = getUserByName(app.db, "bot")!;
    const rows = async (args: unknown = {}) => ((await tool(token, "asks", args)) as any).value.rows.length;
    expect(await rows()).toBe(1);
    // Given, the filter replaces the saved one for that call only.
    expect(await rows({ hide_kinds: ["reviews"] })).toBe(0);
    expect(await rows({ hide_people: ["bot"] })).toBe(0);
    expect(await rows({ hide_people: ["bob"], hide_kinds: ["crew"] })).toBe(1);
    expect(await rows({ hide_kinds: [] })).toBe(1);
    // Saved, it applies with no arguments; an empty filter given lifts it.
    setChip(app.db, alice.id, { kind: "person", value: bot.id }, true);
    expect(await rows()).toBe(0);
    expect(await rows({ hide_kinds: [] })).toBe(1);
    setChip(app.db, alice.id, { kind: "person", value: bot.id }, false);
    // Bad filters are refused, not guessed at.
    expect(((await tool(token, "asks", { hide_kinds: ["nope"] })) as any).error).toContain("hide_kinds");
    expect(((await tool(token, "asks", { hide_people: ["nobody"] })) as any).error).toContain("hide_people");
    expect(((await tool(token, "asks", { hide_kinds: "reviews" })) as any).error).toContain("lists");
    // The manifest says so.
    const tools = (await listAt(servers.url, token)).result.tools as any[];
    for (const name of ["asks", "feed"]) {
      const t = tools.find((x) => x.name === name);
      expect(t.description).toContain("saved filter");
      expect(Object.keys(t.inputSchema.properties)).toEqual(expect.arrayContaining(["hide_kinds", "hide_people"]));
    }
  });
});
