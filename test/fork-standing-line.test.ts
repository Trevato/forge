/**
 * A fork's page and the MCP say in one plain line how it follows and when it
 * last took (#11297): each mode's words, the last take, a root saying
 * nothing, and a private upstream not named to a reader who cannot read it.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { followStanding } from "../src/actions/follow.ts";
import { agoWords, followStandingLine } from "../src/actions/follow_words.ts";
import { commitToBranch, createRepo, forkRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { setForkFollowMode } from "../src/core/fork_follow.ts";
import { getRepo } from "../src/core/repos.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { promote } from "./helpers/members.ts";

let dataDir: string;
let app: App;
let servers: Servers;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-standing-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const mk = async (username: string, first = false) => {
    const u = await createUser(app.db, {
      origin: "seed", trusted: true, username, email: `${username}@forge.local`,
      password: "a-good-passphrase", adminIfFirst: first,
    });
    if (!u.ok) throw new Error(u.error);
    promote(app.db, u.value);
    return u.value;
  };
  const alice = await mk("alice", true);
  const bob = await mk("bob");
  const lib = await createRepo(app, alice, { name: "lib", visibility: "public" });
  if (!lib.ok) throw new Error(String(lib.error));
  const seeded = await commitToBranch(app, alice, lib.value, {
    message: "Start", files: [{ path: "README.md", content: "# lib\n" }],
  });
  if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
  const forked = await forkRepo(app, bob, lib.value);
  if (!forked.ok) throw new Error(String(forked.error));
}, 60_000);

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const lineOf = async (path: string): Promise<string | null> => {
  const page = await (await fetch(`${servers.url}${path}`)).text();
  return page.match(/<div class="small muted" data-follow-standing>[^<]*<svg.*?<\/svg> <a href="([^"]*)">([^<]*)<\/a><\/div>/)?.[2] ?? null;
};

test("the words: each mode, with and without a last take", () => {
  const now = Date.parse("2026-11-11T00:00:00Z");
  const two = "2026-11-09T00:00:00Z";
  expect(followStandingLine("take-updates", "a/b", two, now)).toBe("Takes updates from a/b · last took 2 days ago");
  expect(followStandingLine("tell-me", "a/b", null, now)).toBe("Sends offers to a/b");
  expect(followStandingLine("dont-follow", "a/b", two, now)).toBe("Not following a/b · last took 2 days ago");
  expect(followStandingLine("tell-me", undefined, null, now)).toBe("Sends offers to its upstream");
  expect(agoWords("2026-11-10T23:59:30Z", now)).toBe("just now");
  expect(agoWords("2026-11-10T23:00:00Z", now)).toBe("1 hour ago");
});

test("a fork's page says its mode, links to the following card, and a root says nothing", async () => {
  const bob = getRepo(app.db, "bob", "lib")!;
  expect(await lineOf("/bob/lib")).toBe("Sends offers to alice/lib");
  const page = await (await fetch(`${servers.url}/bob/lib`)).text();
  expect(page).toContain('href="/bob/lib/forks#following"');
  setForkFollowMode(app.db, bob.id, "take-updates");
  expect(await lineOf("/bob/lib")).toBe("Takes updates from alice/lib");
  setForkFollowMode(app.db, bob.id, "dont-follow");
  expect(await lineOf("/bob/lib")).toBe("Not following alice/lib");
  expect(await lineOf("/alice/lib")).toBeNull();
});

test("the last take is told, and the MCP's words are the page's", async () => {
  const bob = getRepo(app.db, "bob", "lib")!;
  app.bus.append({
    kind: "push", repoId: bob.id, actorId: bob.ownerId,
    payload: { updates: [], followed: "alice/lib" },
  });
  expect(await lineOf("/bob/lib")).toBe("Not following alice/lib · last took just now");
  expect(await followStanding(app, bob, undefined)).toBe("Not following alice/lib · last took just now");
  expect(await followStanding(app, getRepo(app.db, "alice", "lib")!, undefined)).toBeUndefined();
});

test("a private upstream is not named to a reader who cannot read it", async () => {
  const bob = getRepo(app.db, "bob", "lib")!;
  app.db.query("UPDATE repo SET visibility = 'private' WHERE owner_id = (SELECT id FROM user WHERE username = 'alice') AND name = 'lib'").run();
  const seen = await lineOf("/bob/lib");
  expect(seen).toContain("Not following its upstream");
  expect(seen).not.toContain("alice");
  expect(await followStanding(app, bob, undefined)).not.toContain("alice");
});

test("real takes set 'last took': an automatic fast-forward, a merge by take_updates, and the MCP line", async () => {
  const alice = (await import("../src/core/users.ts")).getUserByName(app.db, "alice")!;
  const bobUser = (await import("../src/core/users.ts")).getUserByName(app.db, "bob")!;
  app.db.query("UPDATE repo SET visibility = 'public' WHERE name = 'lib'").run();
  const lib = getRepo(app.db, "alice", "lib")!;
  const bob = getRepo(app.db, "bob", "lib")!;
  app.db.query("DELETE FROM event WHERE repo_id = ?1 AND kind = 'push'").run(bob.id);
  const { lastTookAt } = await import("../src/core/fork_follow.ts");
  expect(lastTookAt(app.db, bob.id)).toBeNull();
  setForkFollowMode(app.db, bob.id, "tell-me");

  // Nothing of bob's own: the parent's push fast-forwards him by itself.
  const one = await commitToBranch(app, alice, lib, { message: "One", files: [{ path: "one.txt", content: "1\n" }] });
  expect(one.ok).toBe(true);
  for (let i = 0; i < 50 && lastTookAt(app.db, bob.id) === null; i++) await Bun.sleep(100);
  expect(lastTookAt(app.db, bob.id)).not.toBeNull();

  // Work on both sides: a merge, taken through the real MCP tool.
  app.db.query("DELETE FROM event WHERE repo_id = ?1 AND kind = 'push'").run(bob.id);
  expect(lastTookAt(app.db, bob.id)).toBeNull();
  const mine = await commitToBranch(app, bobUser, bob, { message: "Mine", files: [{ path: "mine.txt", content: "m\n" }] });
  expect(mine.ok).toBe(true);
  app.db.query("DELETE FROM event WHERE repo_id = ?1 AND kind = 'push'").run(bob.id);
  const two = await commitToBranch(app, alice, lib, { message: "Two", files: [{ path: "two.txt", content: "2\n" }] });
  expect(two.ok).toBe(true);
  await Bun.sleep(500);
  app.db.query("DELETE FROM event WHERE repo_id = ?1 AND kind = 'push'").run(bob.id);
  const { createToken } = await import("../src/core/tokens.ts");
  const { mcpTool } = await import("./helpers/mcp.ts");
  const token = createToken(app.db, bobUser.id, "bob", "admin").token;
  const took = await mcpTool(servers.url, token, "take_updates", { repo: "bob/lib" });
  expect(took.error).toBeUndefined();
  expect(lastTookAt(app.db, bob.id)).not.toBeNull();

  const following = await mcpTool(servers.url, token, "following", { repo: "bob/lib" });
  expect(following.value.line).toBe("Sends offers to alice/lib · last took just now");
  const set = await mcpTool(servers.url, token, "follow_mode", { repo: "bob/lib", mode: "take-updates" });
  expect(set.value.line).toBe("Takes updates from alice/lib · last took just now");
});

test("a logged-in reader who can read a private upstream sees it named; a stranger does not", async () => {
  const { createToken } = await import("../src/core/tokens.ts");
  const { mcpTool } = await import("./helpers/mcp.ts");
  const { getUserByName } = await import("../src/core/users.ts");
  app.db.query("UPDATE repo SET visibility = 'private' WHERE owner_id = (SELECT id FROM user WHERE username = 'alice') AND name = 'lib'").run();
  const bobToken = createToken(app.db, getUserByName(app.db, "bob")!.id, "bob", "admin").token;
  // Bob forked it and is no member of the private upstream: not named.
  const stranger = await mcpTool(servers.url, bobToken, "following", { repo: "bob/lib" });
  const said = stranger.value?.line ?? "";
  expect(said).not.toContain("alice");
  // Alice, who owns it, reads the fork's line with the upstream named.
  const aliceToken = createToken(app.db, getUserByName(app.db, "alice")!.id, "alice", "admin").token;
  const owner = await mcpTool(servers.url, aliceToken, "following", { repo: "bob/lib" });
  expect(owner.value?.line ?? owner.error).toContain("alice/lib");
});

test("the terminal's forks screen says the line", async () => {
  const { createForgeApp } = await import("../src/tui/forge.ts");
  const { forksScreen } = await import("../src/tui/screens/forks.ts");
  const { headlessTerminal } = await import("../src/tui/term/terminal.ts");
  const { settleApp } = await import("./helpers/tui.ts");
  const { getUserByName } = await import("../src/core/users.ts");
  app.db.query("UPDATE repo SET visibility = 'public' WHERE name = 'lib'").run();
  const terminal = headlessTerminal(120, 30);
  const { app: tui, session } = createForgeApp(
    app,
    { sshUsername: "bob", remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user: getUserByName(app.db, "bob")! },
    { terminal, exitHooks: false },
  );
  tui.start();
  tui.ctx.push(forksScreen(session, tui.ctx, getRepo(app.db, "bob", "lib")!));
  await settleApp(tui);
  const text = tui.screen.toText();
  tui.stop?.();
  expect(text).toContain("Takes updates from alice/lib");
});
