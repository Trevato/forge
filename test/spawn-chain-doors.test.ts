/**
 * The chain's other doors (#1085): MCP `sever` and the chain in `following`,
 * and the terminal's Chain card, which shows it only to someone who can read
 * the forge repository and offers Sever to its owner alone.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { childDirOf, spawnForge } from "../src/actions/spawn.ts";
import { createApp, type App } from "../src/app.ts";
import { listEvents } from "../src/core/events.ts";
import { getRepo, updateRepoSettings } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { repoDir } from "../src/git/repos.ts";
import { commitFiles } from "../src/git/write.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { forgeLinkOf } from "../src/spawn/chain.ts";
import { hostedPlacement } from "../src/spawn/placement.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import type { TuiIdentity } from "../src/tui/session.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp, settleUntil } from "./helpers/tui.ts";

quietLogs();

describe("the chain at the MCP and terminal doors", () => {
  let dir = "";
  let root: App;
  let child: App;
  let servers: Servers;
  let alice: User;
  let reader: User;
  let rw = "";
  let ro = "";
  let readerRw = "";
  let id = 1;

  const tool = async (token: string, name: string, args: unknown) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name, arguments: args } }),
    });
    const body = (await res.json()) as any;
    if (body.error !== undefined) return { error: String(body.error.message) };
    const text: string = body.result.content[0].text;
    return body.result.isError === true ? { error: text } : { value: JSON.parse(text) };
  };

  const boot = (user: User | undefined) => {
    const identity: TuiIdentity = { sshUsername: user?.username ?? "guest", remoteAddress: "127.0.0.1", user };
    const { app } = createForgeApp(child, identity, { terminal: headlessTerminal(120, 30), exitHooks: false });
    app.start();
    const press = async (...keys: string[]) => {
      for (const key of keys) app.dispatch({ type: "key", key, ctrl: false, alt: false, shift: false });
      await settleApp(app);
    };
    const openChain = async () => {
      await settleApp(app);
      await press(":");
      for (const ch of "Chain") await press(ch);
      await press("enter");
      await settleApp(app);
    };
    return { app, press, openChain, text: () => app.screen.toText() };
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-chain-doors-"));
    root = createApp({ dataDir: dir, url: "https://root.test", port: 0, forgeRepo: "alice/forge-code" });
    const a = await createUser(root.db, { origin: "seed", trusted: true, username: "alice", email: "a@x.test", isAdmin: true });
    if (!a.ok) throw new Error("user");
    const made = await createRepo(root, a.value, { name: "forge-code", visibility: "public" });
    if (!made.ok) throw new Error("repo");
    const c = await commitFiles(repoDir(root.reposRoot, "alice", "forge-code"), {
      branch: "main",
      message: "forge v1",
      files: [{ path: "README.md", content: "# forge\n" }],
      author: { name: "a", email: "a@x.invalid" },
    });
    if (!c.ok) throw new Error("commit");
    const spawned = await spawnForge(
      root,
      a.value,
      { name: "kid", org: "kid", apps: [], carryBriefs: false, carrySubscriptions: false },
      { catalog: [], briefs: [], subscriptions: [] },
      {
        placement: hostedPlacement({ host: "root.test" }),
        request: new Request("https://root.test/x", { method: "POST", headers: { origin: "https://root.test" } }),
        url: new URL("https://root.test/x"),
      },
    );
    if (!spawned.ok) throw new Error(JSON.stringify(spawned.error));
    child = createApp({ dataDir: childDirOf(root, spawned.value.bodyId), url: "https://kid.test", port: 0 });
    servers = await serve(child);
    alice = getUserByName(child.db, "alice")!;
    const r = await createUser(child.db, { origin: "seed", trusted: true, username: "reader", email: "r@x.test" });
    if (!r.ok) throw new Error("reader");
    reader = r.value;
    rw = createToken(child.db, alice.id, "rw", "rw").token;
    ro = createToken(child.db, alice.id, "ro", "ro").token;
    readerRw = createToken(child.db, reader.id, "rr", "rw").token;
  }, 240_000);

  // Every test starts from a followed forge with a public forge repository.
  beforeEach(async () => {
    const file = join(child.config.dataDir, "parent.json");
    const doc = JSON.parse(await Bun.file(file).text());
    delete doc.forgeCode.severedAt;
    await Bun.write(file, JSON.stringify(doc));
    updateRepoSettings(child.db, getRepo(child.db, "kid", "forge")!, { visibility: "public" });
  });

  afterAll(async () => {
    servers?.stop();
    child?.close();
    root?.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  test("MCP following carries the chain, root first", async () => {
    const got = await tool(rw, "following", { repo: "kid/forge" });
    expect(got.value.chain.map((l: any) => l.repo)).toEqual(["alice/forge-code", "kid/forge"]);
    expect(got.value.severedAt).toBeNull();
  });

  test("the terminal shows the chain to a reader, and Sever only to the owner", async () => {
    const guest = boot(undefined);
    await guest.openChain();
    expect(guest.text()).toContain("root.test");
    expect(guest.text()).not.toContain("sever");
    guest.app.stop();

    const other = boot(reader);
    await other.openChain();
    expect(other.text()).toContain("kid.test");
    await other.press("s");
    expect(other.text()).not.toContain("type sever");
    other.app.stop();
    expect((await forgeLinkOf(child))?.severedAt).toBeUndefined();
  });

  test("a guest on the terminal sees nothing of a private forge repository", async () => {
    const repo = getRepo(child.db, "kid", "forge")!;
    updateRepoSettings(child.db, repo, { visibility: "private" });
    const guest = boot(undefined);
    await guest.openChain();
    expect(guest.text()).not.toContain("root.test");
    expect(guest.text()).not.toContain("kid.test");
    guest.app.stop();
    const owner = boot(alice);
    await owner.openChain();
    expect(owner.text()).toContain("root.test");
    owner.app.stop();
  });

  test("MCP sever refuses a reader and a read-only token, and changes nothing", async () => {
    expect((await tool(readerRw, "sever", { repo: "kid/forge" })).error).toBeDefined();
    expect((await tool(ro, "sever", { repo: "kid/forge" })).error).toBeDefined();
    expect((await forgeLinkOf(child))?.severedAt).toBeUndefined();
  });

  test("the terminal's owner flips the follow mode with m; a reader has no such key", async () => {
    const was = (await forgeLinkOf(child))!.mode;
    const next = was === "tell-me" ? "take-updates" : "tell-me";
    const events = () => listEvents(child.db, { kind: "forge.follow_mode" }).length;
    const before = events();
    const guest = boot(reader);
    await guest.openChain();
    expect(guest.text()).not.toContain("follow mode");
    await guest.press("m");
    expect((await forgeLinkOf(child))?.mode).toBe(was);
    expect(events()).toBe(before);
    guest.app.stop();
    const owner = boot(alice);
    await owner.openChain();
    expect(owner.text()).toContain("follow mode");
    await owner.press("m");
    await settleUntil(owner.app, next === "tell-me" ? "Proposes updates from its parent." : "Follows its parent automatically.");
    expect((await forgeLinkOf(child))?.mode).toBe(next);
    expect(events()).toBe(before + 1);
    owner.app.stop();
  });

  test("the terminal's owner types the word to sever; a wrong word does nothing", async () => {
    const owner = boot(alice);
    await owner.openChain();
    await owner.press("s");
    for (const ch of "nope") await owner.press(ch);
    await owner.press("enter");
    expect(owner.text()).toContain("Type sever to confirm");
    expect((await forgeLinkOf(child))?.severedAt).toBeUndefined();
    for (const _ of "nope") await owner.press("backspace");
    for (const ch of "sever") await owner.press(ch);
    await owner.press("enter");
    await settleUntil(owner.app, "Severed");
    expect((await forgeLinkOf(child))?.severedAt).toBeDefined();
    owner.app.stop();
  });

  test("MCP sever by the owner is idempotent and says when", async () => {
    const first = await tool(rw, "sever", { repo: "kid/forge" });
    const before = first.value.severedAt;
    const got = await tool(rw, "sever", { repo: "kid/forge" });
    expect(got.value.severedAt).toBe(before);
    expect((await tool(rw, "following", { repo: "kid/forge" })).value.severedAt).toBe(before);
  });
});
