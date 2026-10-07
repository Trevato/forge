/**
 * The client list (#776): `/forges` shows every forge the owner sent — for
 * whom, which apps, its address, whether it was claimed, and when anything
 * last happened there. Claimed and last activity come from the child's own
 * small public `GET /api/v1/forge`; an unreachable child reads "unknown".
 * The same rows answer the MCP `forges` tool. Only an admin of the parent
 * sees any of it.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { childDirOf } from "../src/actions/spawn.ts";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { commitFiles } from "../src/git/write.ts";
import { repoDir } from "../src/git/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { useChildFetch } from "../src/spawn/clients.ts";
import { firstBoot } from "../src/spawn/first-boot.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const PASSWORD = "a-long-client-list-passphrase";

describe("the client list", () => {
  let dir = "";
  let parent: App;
  let child: App;
  let parentServers: Servers;
  let childServers: Servers;
  let adminRw = "";
  let bobRw = "";
  let admin = "";
  let reader = "";
  let claimUrl = "";

  const signIn = async (username: string) => {
    const res = await fetch(`${parentServers.url}/signin`, {
      method: "POST",
      body: new URLSearchParams({ username, password: PASSWORD }),
      redirect: "manual",
    });
    return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  };
  const list = async (cookie: string) =>
    fetch(`${parentServers.url}/forges`, {
      headers: { cookie },
      redirect: "manual",
    });
  const spawn = (body: Record<string, unknown>) =>
    fetch(`${parentServers.url}/api/v1/forges`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${adminRw}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  const mcp = (token: string) =>
    fetch(`${parentServers.url}/mcp`, {
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
        params: { name: "forges", arguments: {} },
      }),
    });

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-client-list-"));
    parent = createApp({ dataDir: dir, url: "https://forge.test", port: 0 });
    const alice = await createUser(parent.db, {
      trusted: true,
      username: "alice",
      email: "a@x.test",
      password: PASSWORD,
      isAdmin: true,
    });
    const bob = await createUser(parent.db, {
      trusted: true,
      username: "bob",
      email: "b@x.test",
      password: PASSWORD,
    });
    if (!alice.ok || !bob.ok) throw new Error("users");
    adminRw = createToken(parent.db, alice.value.id, "rw", "rw").token;
    bobRw = createToken(parent.db, bob.value.id, "rw", "rw").token;
    const repo = await createRepo(parent, alice.value, { name: "bakery" });
    if (!repo.ok) throw new Error("repo");
    const c = await commitFiles(repoDir(parent.reposRoot, "alice", "bakery"), {
      branch: "main",
      message: "bakery",
      files: [{ path: "README.md", content: "# bakery\n" }],
      author: { name: "a", email: "a@x.invalid" },
    });
    if (!c.ok) throw new Error("commit");
    parentServers = await serve(parent);
    const made = await spawn({
      name: "maria",
      for: "Maria's bakery",
      apps: ["alice/bakery"],
      dryRun: false,
    });
    if (made.status !== 201)
      throw new Error(`spawn ${made.status} ${await made.text()}`);
    const body = (await made.json()) as { claimUrl: string; bodyId: string };
    claimUrl = body.claimUrl;
    child = createApp({ dataDir: childDirOf(parent, body.bodyId), port: 0 });
    await firstBoot(child);
    childServers = await serve(child);
    // A second child nobody can reach: its row says "unknown", never fails.
    const lost = await spawn({
      name: "lou",
      apps: ["alice/bakery"],
      dryRun: false,
    });
    if (lost.status !== 201) throw new Error(`spawn lou ${lost.status}`);
    // Children are reached at their address; here maria's is this server.
    useChildFetch(parent, (url, init) =>
      url.startsWith("https://maria--forge.test/")
        ? fetch(url.replace("https://maria--forge.test", childServers.url), init)
        : Promise.reject(new Error("unreachable")),
    );
    admin = await signIn("alice");
    reader = await signIn("bob");
  }, 60_000);

  afterAll(async () => {
    childServers.stop();
    child.close();
    parentServers.stop();
    parent.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("someone who is not an admin of the parent gets no list: page, API or MCP", async () => {
    expect((await list(reader)).status).toBe(404);
    const tool = (await (await mcp(bobRw)).json()) as any;
    expect(tool.result?.isError ?? tool.error !== undefined).toBe(true);
    expect(JSON.stringify(tool)).not.toContain("maria");
  });

  test("a forge that was not spawned has no GET /api/v1/forge", async () => {
    expect((await fetch(`${parentServers.url}/api/v1/forge`)).status).toBe(404);
  });

  test("a spawned child tells anyone whether it is claimed, and only its parent when anything last happened", async () => {
    const res = await fetch(`${childServers.url}/api/v1/forge`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["claimed", "lastActivityAt"]);
    expect(body["claimed"]).toBe(false);
    // The child has activity (its first boot opened the direction), but a
    // stranger, or a wrong secret, does not learn when.
    expect(body["lastActivityAt"]).toBeNull();
    const wrong = await fetch(`${childServers.url}/api/v1/forge`, {
      headers: { "x-forge-parent": "not-the-parents-secret" },
    });
    expect(((await wrong.json()) as Record<string, unknown>)["lastActivityAt"]).toBeNull();
    // The parent, asking with the secret it kept, does.
    const rows = (await (await mcp(adminRw)).json()) as any;
    const maria = JSON.parse(rows.result.content[0].text).forges.find((f: any) => f.name === "maria");
    expect(typeof maria.lastActivityAt).toBe("string");
    // The secret itself is never in an answer.
    expect(JSON.stringify(rows)).not.toMatch(/status|secret/i);
  });

  test("`for` is at most 200 characters", async () => {
    const res = await spawn({
      name: "long",
      for: "x".repeat(201),
      apps: ["alice/bakery"],
    });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("for");
  });

  test("the admin's list: one row per child, for whom, apps, address, and claimed or not", async () => {
    const res = await list(admin);
    expect(res.status).toBe(200);
    const html = (await res.text()).replace(/\s+/g, " ");
    const maria = html.slice(html.indexOf('data-forge="maria"'));
    expect(maria).toContain("Maria&#39;s bakery");
    expect(maria).toContain("alice/bakery");
    expect(maria).toContain('href="https://maria--forge.test"');
    expect(maria).toMatch(/data-claimed="no"/);
    const lou = html.slice(html.indexOf('data-forge="lou"'));
    expect(lou).toMatch(/data-claimed="unknown"/);
    // The claim link itself is never kept, so never shown here.
    expect(html).not.toContain(claimUrl.split("#")[1]!);
  });

  test("an unclaimed row offers a fresh link: it replaces the old one, shown once; only an admin may ask", async () => {
    const html = (await (await list(admin)).text()).replace(/\s+/g, " ");
    const maria = html.slice(html.indexOf('data-forge="maria"'), html.indexOf("</li>", html.indexOf('data-forge="maria"')));
    expect(maria).toContain('action="/forges/maria/claim-link"');
    const lou = html.slice(html.indexOf('data-forge="lou"'), html.indexOf("</li>", html.indexOf('data-forge="lou"')));
    // Whether lou was claimed is unknown, so it offers nothing to send.
    expect(lou).not.toContain("claim-link");
    const fresh = (cookie: string) =>
      fetch(`${parentServers.url}/forges/maria/claim-link`, {
        method: "POST",
        headers: { cookie, origin: "https://forge.test" },
        redirect: "manual",
      });
    expect((await fresh(reader)).status).toBe(404);
    const res = await fresh(admin);
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const link = /https:\/\/maria--forge.test\/claim#[A-Za-z0-9_-]{43}/.exec(await res.text())?.[0];
    expect(link).toBeDefined();
    expect(link).not.toBe(claimUrl);
    claimUrl = link!;
  });

  test("once claimed, the row says so, and the MCP tool answers the same rows", async () => {
    const claimed = await fetch(`${childServers.url}/claim`, {
      method: "POST",
      headers: { origin: childServers.url },
      body: new URLSearchParams({
        token: claimUrl.split("#")[1]!,
        username: "mara",
        email: "m@bakery.test",
        password: PASSWORD,
      }),
      redirect: "manual",
    });
    expect(claimed.status).toBe(303);
    // The list answers at once from what it last heard and asks again in
    // the background: the claim shows within a moment, not necessarily now.
    let row = "";
    for (let i = 0; i < 40 && !row.includes('data-claimed="yes"'); i++) {
      const html = (await (await list(admin)).text()).replace(/\s+/g, " ");
      row = html.slice(html.indexOf('data-forge="maria"'), html.indexOf("</li>", html.indexOf('data-forge="maria"')));
      if (!row.includes('data-claimed="yes"')) await Bun.sleep(100);
    }
    expect(row).toMatch(/data-claimed="yes"/);
    expect(row).not.toContain("claim-link");
    const tool = (await (await mcp(adminRw)).json()) as any;
    const value = JSON.parse(tool.result.content[0].text);
    const rows = Object.fromEntries(value.forges.map((f: any) => [f.name, f]));
    expect(rows.maria.for).toBe("Maria's bakery");
    expect(rows.maria.apps).toEqual(["alice/bakery"]);
    expect(rows.maria.claimed).toBe(true);
    expect(typeof rows.maria.lastActivityAt).toBe("string");
    expect(rows.lou.claimed).toBeNull();
  });
});
