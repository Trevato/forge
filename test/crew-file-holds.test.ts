/**
 * An admin's hold on one file (#6522): the picker starts no build whose issue
 * names it, the hold says who set it, and it is reachable from the settings
 * page, the MCP and the terminal — each refusing a non-admin.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { holdFileAs, listFileHolds, releaseFileAs } from "../src/actions/file_holds.ts";
import { openIssue } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import type { Repo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { heldFiles, holdFile, releaseFile } from "../src/crew/file_holds.ts";
import { heldNow } from "../src/crew/held.ts";
import { holdHot, hotSays, standingHot } from "../src/crew/hot_files.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { fileHoldLine } from "../src/tui/screens/fileholds.ts";
import { mcpTool } from "./helpers/mcp.ts";

describe("hold new work on a file", () => {
  let dir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let bob: User;
  let repo: Repo;
  let named: number;
  let other: number;

  const person = async (username: string, first = false): Promise<User> => {
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
      adminIfFirst: first,
    });
    if (!made.ok) throw new Error(made.error);
    return made.value;
  };
  const cookieOf = async (username: string): Promise<string> =>
    (
      (
        await fetch(`${servers.url}/signin`, {
          method: "POST",
          body: new URLSearchParams({ username, password: "a-good-passphrase" }),
          redirect: "manual",
        })
      ).headers.get("set-cookie") ?? ""
    ).split(";")[0]!;
  const post = (cookie: string, body: Record<string, string>, origin = servers.url) =>
    fetch(`${servers.url}/alice/held-file/settings/holds`, {
      method: "POST",
      headers: { cookie, origin },
      body: new URLSearchParams(body),
      redirect: "manual",
    });
  const waiting = () => heldNow(app, repo).by.hot_file.map((i) => i.number);

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "file-holds-"));
    app = createApp({ dataDir: dir, port: 0 });
    alice = await person("alice", true);
    bob = await person("bob");
    servers = await serve(app);
    const made = await createRepo(app, alice, { name: "held-file", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const a = await openIssue(app, alice, repo, { title: "Change src/http/mcp.ts", body: "" });
    const b = await openIssue(app, alice, repo, { title: "Change src/other/thing.ts", body: "" });
    if (!a.ok || !b.ok) throw new Error("issues");
    named = a.value.number;
    other = b.value.number;
  });
  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("a held path holds an issue naming it, and releasing frees it", () => {
    expect(waiting()).toEqual([]);
    const held = holdFile(app.db, repo.id, "src/http/mcp.ts", alice.id);
    expect(held.ok && held.value.by).toBe(alice.id);
    expect(heldFiles(app.db, repo.id).map((h) => h.path)).toEqual(["src/http/mcp.ts"]);
    expect(waiting()).toEqual([named]);
    expect(heldNow(app, repo).startable.map((r) => r.issue.number)).toContain(other);
    expect(releaseFile(app.db, repo.id, "src/http/mcp.ts")).toBe(true);
    expect(waiting()).toEqual([]);
    expect(releaseFile(app.db, repo.id, "src/http/mcp.ts")).toBe(false);
  });

  test("an invalid path is refused", () => {
    for (const bad of ["", "/etc/passwd", "../x.ts", "a/../b.ts", "a//b.ts", "x".repeat(301), 5, "a\\b"])
      expect(holdFile(app.db, "nope", bad, "u").ok).toBe(false);
    expect(holdFileAs(app, alice, repo, "../x.ts")).toEqual({ ok: false, error: "invalid_path" });
  });

  test("the action refuses a non-admin and names the admin who holds", () => {
    expect(holdFileAs(app, bob, repo, "src/http/mcp.ts")).toEqual({ ok: false, error: "not_found" });
    expect(holdFileAs(app, undefined, repo, "src/http/mcp.ts")).toEqual({ ok: false, error: "unauthorized" });
    expect(releaseFileAs(app, bob, repo, "src/http/mcp.ts").ok).toBe(false);
    expect(listFileHolds(app, bob, repo).ok).toBe(false);
    expect(heldFiles(app.db, repo.id)).toEqual([]);

    const dry = holdFileAs(app, alice, repo, "src/http/mcp.ts", true);
    expect(dry.ok).toBe(true);
    expect(heldFiles(app.db, repo.id)).toEqual([]);

    const held = holdFileAs(app, alice, repo, "src/http/mcp.ts");
    expect(held.ok && held.value.byName).toBe("alice");
    expect(waiting()).toEqual([named]);
    const pin = heldNow(app, repo).pinned.get(named);
    expect(pin?.path).toBe("src/http/mcp.ts");
    expect(pin?.by).toBe(alice.id);
    // The feed's sentence says who.
    holdHot(repo.id, heldNow(app, repo).by.hot_file, new Date(), new Map([[named, { path: pin!.path, byName: "alice" }]]));
    expect(hotSays(standingHot(repo.id)!.holds[0]!)).toBe(`#${named} waits: alice holds new work on src/http/mcp.ts.`);
    holdHot(repo.id, []);
    expect(releaseFileAs(app, alice, repo, "src/http/mcp.ts")).toEqual({ ok: true, value: true });
    expect(waiting()).toEqual([]);
  });

  test("the settings page: only an admin sees the card and posts; the hold reaches the picker", async () => {
    const adminCookie = await cookieOf("alice");
    const bobCookie = await cookieOf("bob");
    const seen = await (await fetch(`${servers.url}/alice/held-file/settings`, { headers: { cookie: adminCookie } })).text();
    expect(seen).toContain('id="file-holds"');
    const bobSees = await (await fetch(`${servers.url}/alice/held-file/settings`, { headers: { cookie: bobCookie } })).text();
    expect(bobSees).not.toContain('id="file-holds"');

    expect((await post(bobCookie, { verb: "hold", path: "src/http/mcp.ts" })).status).toBe(404);
    expect((await post(adminCookie, { verb: "hold", path: "src/http/mcp.ts" }, "https://evil.example")).status).toBeGreaterThanOrEqual(400);
    expect(heldFiles(app.db, repo.id)).toEqual([]);

    const done = await post(adminCookie, { verb: "hold", path: "src/http/mcp.ts" });
    expect(done.status).toBe(303);
    expect(heldFiles(app.db, repo.id)[0]?.by).toBe(alice.id);
    expect(waiting()).toEqual([named]);
    const after = await (await fetch(`${servers.url}/alice/held-file/settings`, { headers: { cookie: adminCookie } })).text();
    expect(after).toContain('data-file-hold="src/http/mcp.ts"');
    expect(after).toContain("alice");

    await post(bobCookie, { verb: "release", path: "src/http/mcp.ts" });
    expect(heldFiles(app.db, repo.id).length).toBe(1);
    await post(adminCookie, { verb: "release", path: "src/http/mcp.ts" });
    expect(waiting()).toEqual([]);
  });

  test("the MCP tool: dry by default, admin only", async () => {
    const admin = createToken(app.db, alice.id, "t", "admin").token;
    const reader = createToken(app.db, bob.id, "t", "admin").token;
    const args = { app: "alice/held-file", path: "src/http/mcp.ts" };
    expect((await mcpTool(servers.url, admin, "hold", args)).value.dryRun).toBe(true);
    expect(heldFiles(app.db, repo.id)).toEqual([]);
    expect((await mcpTool(servers.url, reader, "hold", { ...args, dryRun: false })).error).toBeDefined();
    expect(heldFiles(app.db, repo.id)).toEqual([]);
    const rw = createToken(app.db, alice.id, "t", "rw").token;
    expect((await mcpTool(servers.url, rw, "hold", { ...args, dryRun: false })).error).toBeDefined();
    expect(heldFiles(app.db, repo.id)).toEqual([]);
    const held = await mcpTool(servers.url, admin, "hold", { ...args, dryRun: false });
    expect(held.value.hold.by).toBe("alice");
    expect(waiting()).toEqual([named]);
    const listed = await mcpTool(servers.url, admin, "hold", { app: "alice/held-file" });
    expect(listed.value.holds.map((h: { path: string }) => h.path)).toEqual(["src/http/mcp.ts"]);
    expect((await mcpTool(servers.url, admin, "hold", { ...args, release: true, dryRun: false })).value.says).toContain("Released");
    expect(waiting()).toEqual([]);
    const forgot = await mcpTool(servers.url, admin, "hold", { app: "alice/held-file", release: true, dryRun: false });
    expect(forgot.value?.holds).toBeUndefined();
    expect(forgot.error).toBeDefined();
  });

  test("the terminal line holds, lists and releases, and refuses a non-admin", () => {
    const as = (user: User) => ({ app, db: app.db, user }) as never;
    expect(fileHoldLine(as(bob), "alice/held-file src/http/mcp.ts").ok).toBe(false);
    expect(fileHoldLine(as(alice), "alice/held-file ../x").ok).toBe(false);
    expect(fileHoldLine(as(alice), "alice/held-file src/http/mcp.ts").ok).toBe(true);
    expect(waiting()).toEqual([named]);
    expect(fileHoldLine(as(alice), "alice/held-file").says).toContain("src/http/mcp.ts (alice");
    expect(fileHoldLine(as(alice), "release alice/held-file src/http/mcp.ts").ok).toBe(true);
    expect(waiting()).toEqual([]);
  });
});
