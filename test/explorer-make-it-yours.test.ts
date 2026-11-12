/**
 * Every app row in the explorer says "Make it yours", counted; one tap forks
 * it, with a receipt in plain words and an undo; the MCP says the same.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { newApp } from "../src/actions/apps.ts";
import { createSession } from "../src/core/sessions.ts";
import { createToken } from "../src/core/tokens.ts";
import { commitToBranch } from "../src/actions/repos.ts";
import { mergePull, openPull } from "../src/actions/pulls.ts";
import { getAppByRepo } from "../src/core/apps.ts";
import { getRepo } from "../src/core/repos.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";
import { promote } from "./helpers/members.ts";

quietLogs();

describe("explorer: make it yours", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let bobCookie: string;
  let bobToken: string;

  const mk = async (username: string, first = false): Promise<User> => {
    const r = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
      adminIfFirst: first,
    });
    if (!r.ok) throw new Error(r.error);
    promote(app.db, r.value);
    return r.value;
  };
  const post = (path: string, body = "") =>
    fetch(`${servers.url}${path}`, {
      method: "POST",
      headers: { cookie: bobCookie, origin: servers.url, "content-type": "application/x-www-form-urlencoded" },
      body,
      redirect: "manual",
    });
  const explore = (cookie?: string) =>
    fetch(`${servers.url}/explore?q=${encodeURIComponent("kind:app")}`, {
      headers: cookie === undefined ? {} : { cookie },
    }).then((r) => r.text());

  /** One MCP `make_it_yours` call as bob; its answer's text (a refusal reads `kind: message`). */
  const said = async (args: object): Promise<string> => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${bobToken}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "make_it_yours", arguments: args } }),
    });
    const j = (await res.json()) as any;
    return j.result.content[0].text;
  };
  /** The same call, its answer parsed. */
  const call = async (args: object) => JSON.parse(await said(args));

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-explorer-yours-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const alice = await mk("alice", true);
    const bob = await mk("bob");
    for (const name of ["garden", "kiln"]) {
      const made = await newApp(app, alice, { name, description: name, visibility: "public" });
      if (!made.ok) throw new Error(String(made.error));
    }
    bobCookie = `forge_session=${createSession(app.db, bob.id).token}`;
    bobToken = createToken(app.db, bob.id, "rw", "rw").token;
  }, 60_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("one action per app row, signed in or out", async () => {
    for (const cookie of [undefined, bobCookie]) {
      const page = await explore(cookie);
      const rows = ["garden", "kiln"].filter((n) => page.includes(`href="/alice/${n}"`)).length;
      expect(rows).toBe(2);
      expect(page.match(/Make it yours/g)?.length).toBe(rows);
    }
    // Signed in, the action is a form that posts: one tap.
    expect((await explore(bobCookie)).match(/data-make-it-yours/g)?.length).toBe(2);
  });

  test("one tap forks, the receipt says so, undo takes it back", async () => {
    const tapped = await post("/alice/garden/make-it-yours", "receipt=1");
    expect(tapped.status).toBe(303);
    expect(tapped.headers.get("location")).toBe("/alice/garden/make-it-yours/receipt?made=1");
    const copy = getRepo(app.db, "bob", "garden")!;
    expect(copy.forkParentId).not.toBeNull();
    const receipt = await (
      await fetch(`${servers.url}/alice/garden/make-it-yours/receipt?made=1`, { headers: { cookie: bobCookie } })
    ).text();
    expect(receipt).toContain("bob/garden is yours");
    expect(receipt).toContain("Undo");
    const undone = await post("/alice/garden/make-it-yours/undo");
    expect(undone.status).toBe(303);
    expect(getRepo(app.db, "bob", "garden")).toBeUndefined();
    expect(getRepo(app.db, "alice", "garden")).toBeDefined();
  });

  test("a cross-origin tap is refused", async () => {
    const res = await fetch(`${servers.url}/alice/kiln/make-it-yours`, {
      method: "POST",
      headers: { cookie: bobCookie, origin: "https://evil.example" },
      redirect: "manual",
    });
    expect(res.status).toBe(403);
    expect(getRepo(app.db, "bob", "kiln")).toBeUndefined();
  });

  test("the MCP says the same words and undoes", async () => {
    const made = await call({ repo: "alice/kiln", dryRun: false });
    expect(made.says).toContain("bob/kiln is yours");
    expect(getRepo(app.db, "bob", "kiln")).toBeDefined();
    const undone = await call({ repo: "alice/kiln", undo: true });
    expect(undone.says).toBe("bob/kiln is removed. The original was not touched.");
    expect(getRepo(app.db, "bob", "kiln")).toBeUndefined();
    // Nothing is left to undo.
    expect(await said({ repo: "alice/kiln", undo: true })).toBe(
      "not_found: nothing of yours was made from that app",
    );
  });

  test("signed-out visitors cannot undo, and the receipt of an older copy offers no Undo", async () => {
    await post("/alice/garden/make-it-yours", "receipt=1");
    const out = await fetch(`${servers.url}/alice/garden/make-it-yours/undo`, {
      method: "POST",
      headers: { origin: servers.url },
      redirect: "manual",
    });
    expect(out.status).toBe(303);
    expect(out.headers.get("location")).toContain("/signin");
    expect(getRepo(app.db, "bob", "garden")).toBeDefined();
    const again = await fetch(`${servers.url}/alice/garden/make-it-yours/receipt`, { headers: { cookie: bobCookie } });
    const text = await again.text();
    expect(text).toContain("already yours");
    expect(text).not.toContain("Undo");
    const fresh = await fetch(`${servers.url}/alice/garden/make-it-yours/receipt?made=1`, { headers: { cookie: bobCookie } });
    expect(await fresh.text()).toContain("Undo");
  });

  test("undo is refused when the copy has its own commits, and the app stays on", async () => {
    const copy = getRepo(app.db, "bob", "garden")!;
    const b = getUserByName(app.db, "bob")!;
    const made = await commitToBranch(app, b, copy, { message: "mine", files: [{ path: "mine.txt", content: "x\n" }] });
    expect(made.ok).toBe(true);
    const res = await post("/alice/garden/make-it-yours/undo");
    expect(res.status).toBe(303);
    expect(getRepo(app.db, "bob", "garden")).toBeDefined();
    expect(getAppByRepo(app.db, copy.id)).toBeDefined();
  });

  test("undo is refused, with the app still on, when a pull was sent from the copy", async () => {
    const bobUser = getUserByName(app.db, "bob")!;
    const orig = getRepo(app.db, "alice", "kiln")!;
    await post("/alice/kiln/make-it-yours", "receipt=1");
    const copy = getRepo(app.db, "bob", "kiln")!;
    const c = await commitToBranch(app, bobUser, copy, { message: "mine", files: [{ path: "m.txt", content: "x\n" }] });
    expect(c.ok).toBe(true);
    const pull = await openPull(app, bobUser, orig, { title: "mine", baseBranch: "main", headBranch: "main", headRepo: copy });
    if (!pull.ok) throw new Error(String(pull.error));
    // Taken into the original, the copy has nothing ahead: only the pull keeps it.
    const merged = await mergePull(app, getUserByName(app.db, "alice")!, orig, pull.value, "merge");
    if (!merged.ok) throw new Error(String(merged.error));
    const res = await post("/alice/kiln/make-it-yours/undo");
    expect(res.status).toBe(303);
    expect(getRepo(app.db, "bob", "kiln")).toBeDefined();
    expect(getAppByRepo(app.db, copy.id)).toBeDefined();
  });

  test("the MCP undo answers `changed` for a copy with commits of its own, and keeps it", async () => {
    // bob/garden has bob's own commit from the test above.
    expect(await said({ repo: "alice/garden", undo: true })).toBe(
      "changed: bob/garden has changes of your own, so it is kept. Delete it in its settings if you mean to.",
    );
    expect(getRepo(app.db, "bob", "garden")).toBeDefined();
  });
});

describe("explorer: page and MCP words match", () => {
  test("the explore row's action is the page's label and the tool that forks", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-explorer-words-"));
    const app = createApp({ dataDir, port: 0 });
    const servers = await serve(app);
    try {
      const mk = async (username: string, first: boolean) => {
        const r = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst: first });
        if (!r.ok) throw new Error(r.error);
        promote(app.db, r.value);
        return r.value;
      };
      const alice = await mk("alice", true);
      const bob = await mk("bob", false);
      const made = await newApp(app, alice, { name: "garden", description: "garden", visibility: "public" });
      if (!made.ok) throw new Error(String(made.error));
      const token = createToken(app.db, bob.id, "rw", "rw").token;
      const gardenRow = async (as: string) => {
        const res = await fetch(`${servers.url}/mcp`, {
          method: "POST",
          headers: { authorization: `Bearer ${as}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "explore", arguments: { q: "kind:app" } } }),
        });
        return JSON.parse(((await res.json()) as any).result.content[0].text).items.find((i: any) => i.name === "alice/garden");
      };
      const row = await gardenRow(token);
      expect(row.copyable).toBe(true);
      expect(row.action).toEqual({ do: "make_it_yours", label: "Make it yours" });
      // Not copyable, no action: alice's own app is not hers to make hers.
      const own = await gardenRow(createToken(app.db, alice.id, "rw", "rw").token);
      expect(own.copyable).toBe(false);
      expect("action" in own).toBe(false);
      // The page's own button for this row, as bob sees it, says the same words.
      const bobCookie = `forge_session=${createSession(app.db, bob.id).token}`;
      const page = await (await fetch(`${servers.url}/explore?q=kind%3Aapp`, { headers: { cookie: bobCookie } })).text();
      const form = page.match(/<form method="post" action="\/alice\/garden\/make-it-yours" data-make-it-yours>[\s\S]*?<\/form>/)?.[0];
      expect(form).toBeDefined();
      expect(form!.match(/<button[\s\S]*?<\/button>/)?.[0]).toContain(row.action.label);
      // The named action is a tool that answers, and previews first.
      const prev = await fetch(`${servers.url}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: row.action.do, arguments: { repo: "alice/garden" } } }),
      });
      const plan = JSON.parse(((await prev.json()) as any).result.content[0].text);
      expect(plan.dryRun).toBe(true);
      expect(plan.from).toBe("alice/garden");
      expect(plan.says).toBeUndefined();
      expect(getRepo(app.db, "bob", "garden")).toBeUndefined();
    } finally {
      servers.stop();
      app.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 60_000);
});
