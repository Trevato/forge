/**
 * The owner changes how their forge follows its parent (#2632): one action,
 * three doors (page, API, MCP) wording the same answer. A refusal leaves
 * parent.json byte for byte as it was.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { childDirOf, spawnForge } from "../src/actions/spawn.ts";
import { createApp, type App } from "../src/app.ts";
import { listEvents } from "../src/core/events.ts";
import { createSession } from "../src/core/sessions.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { repoDir } from "../src/git/repos.ts";
import { commitFiles } from "../src/git/write.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { forgeLinkOf, severChain } from "../src/spawn/chain.ts";
import { hostedPlacement } from "../src/spawn/placement.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("choosing how a forge follows its parent", () => {
  let dir = "";
  let root: App;
  let child: App;
  let servers: Servers;
  let cookie = "";
  let ownerTok = "";
  let readerTok = "";
  let readerCookie = "";
  let id = 1;
  const file = () => join(child.config.dataDir, "parent.json");
  const raw = () => Bun.file(file()).text();
  const patch = (tok: string, body: unknown) =>
    fetch(`${servers.url}/api/v1/forge/following`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const tool = async (tok: string, args: unknown) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${tok}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name: "follow_mode", arguments: args } }),
    });
    const j = (await res.json()) as any;
    return { error: j.result.isError === true, text: String(j.result.content[0].text) };
  };
  const form = (ck: string, mode: string) =>
    fetch(`${servers.url}/kid/forge/following/mode`, {
      method: "POST",
      headers: { cookie: ck, origin: servers.url },
      body: new URLSearchParams({ mode }),
      redirect: "manual",
    });

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-chain-mode-"));
    root = createApp({ dataDir: dir, url: "https://root.test", port: 0, forgeRepo: "alice/forge-code" });
    const alice = await createUser(root.db, { origin: "seed", trusted: true, username: "alice", email: "a@x.test", isAdmin: true });
    if (!alice.ok) throw new Error("user");
    const made = await createRepo(root, alice.value, { name: "forge-code", visibility: "public" });
    if (!made.ok) throw new Error("repo");
    const c = await commitFiles(repoDir(root.reposRoot, "alice", "forge-code"), {
      branch: "main",
      message: "forge v1",
      files: [{ path: "README.md", content: "# forge\n" }],
      author: { name: "a", email: "a@x.invalid" },
    });
    if (!c.ok) throw new Error("commit");
    const a = await spawnForge(
      root,
      alice.value,
      { name: "kid", org: "kid", apps: [], carryBriefs: false, carrySubscriptions: false },
      { catalog: [], briefs: [], subscriptions: [] },
      {
        placement: hostedPlacement({ host: "root.test" }),
        request: new Request("https://root.test/x", { method: "POST", headers: { origin: "https://root.test" } }),
        url: new URL("https://root.test/x"),
      },
    );
    if (!a.ok) throw new Error(JSON.stringify(a.error));
    child = createApp({ dataDir: childDirOf(root, a.value.bodyId), port: 0 });
    servers = await serve(child);
    const owner = getUserByName(child.db, "alice")!;
    cookie = `forge_session=${createSession(child.db, owner.id).token}`;
    ownerTok = createToken(child.db, owner.id, "t", "rw").token;
    const reader = await createUser(child.db, { origin: "seed", trusted: true, username: "reader", email: "r@x.test" });
    if (!reader.ok) throw new Error("reader");
    readerTok = createToken(child.db, reader.value.id, "t", "rw").token;
    readerCookie = `forge_session=${createSession(child.db, reader.value.id).token}`;
  }, 240_000);

  afterAll(async () => {
    servers?.stop();
    child?.close();
    root?.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  test("refusals change nothing and say why", async () => {
    const before = await raw();
    expect((await patch(readerTok, { mode: "take-updates" })).status).toBe(403);
    expect((await patch(ownerTok, { mode: "yolo" })).status).toBe(422);
    expect((await patch(ownerTok, {})).status).toBe(422);
    expect((await form(readerCookie, "take-updates")).status).toBe(303);
    expect((await form(cookie, "yolo")).status).toBe(303);
    expect((await tool(readerTok, { repo: "kid/forge", mode: "take-updates" })).error).toBe(true);
    expect((await tool(ownerTok, { repo: "kid/forge", mode: "yolo" })).error).toBe(true);
    const cross = await fetch(`${servers.url}/kid/forge/following/mode`, {
      method: "POST",
      headers: { cookie, origin: "https://evil.test" },
      body: new URLSearchParams({ mode: "take-updates" }),
    });
    expect(cross.status).toBe(403);
    expect(await raw()).toBe(before);
    expect(listEvents(child.db, { kind: "forge.follow_mode" })).toHaveLength(0);
  });

  test("the owner changes it from the page, the API and MCP; the page shows it", async () => {
    expect((await forgeLinkOf(child))?.mode).toBe("tell-me");
    const page = async () => (await (await fetch(`${servers.url}/kid/forge/following`, { headers: { cookie } })).text()).replace(/\s+/g, " ");
    const html = await page();
    expect(html).toContain('action="/kid/forge/following/mode"');
    expect(html).toMatch(/value="tell-me" checked/);
    expect(html).not.toContain("<script>");
    // Rows and headings, not boxes.
    expect(html).not.toContain('class="card');
    expect(html).toContain('<ul class="list" aria-label="Forges, root first">');
    expect(html).toContain("<h2");

    expect((await form(cookie, "take-updates")).status).toBe(303);
    expect((await forgeLinkOf(child))?.mode).toBe("take-updates");
    expect(await page()).toMatch(/value="take-updates" checked/);

    const res = await patch(ownerTok, { mode: "tell-me" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).mode).toBe("tell-me");
    const viaTool = await tool(ownerTok, { repo: "kid/forge", mode: "take-updates" });
    expect(viaTool.error).toBe(false);
    expect((await forgeLinkOf(child))?.mode).toBe("take-updates");
    expect(listEvents(child.db, { kind: "forge.follow_mode" })).toHaveLength(3);
  });

  test("a severed forge refuses with 409 and keeps its record", async () => {
    expect((await severChain(child)).ok).toBe(true);
    const before = await raw();
    expect((await patch(ownerTok, { mode: "tell-me" })).status).toBe(409);
    expect((await tool(ownerTok, { repo: "kid/forge", mode: "tell-me" })).error).toBe(true);
    await form(cookie, "tell-me");
    expect(await raw()).toBe(before);
    const html = await (await fetch(`${servers.url}/kid/forge/following`, { headers: { cookie } })).text();
    expect(html).not.toContain("/following/mode");
  });
});
