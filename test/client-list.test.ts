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
import { keepAdmin } from "../src/core/everyday.ts";
import { getUserById } from "../src/core/users.ts";
import { nextStepOf, useChildFetch } from "../src/spawn/clients.ts";
import { parseBeat, sendBeat } from "../src/spawn/heartbeat.ts";
import { firstBoot } from "../src/spawn/first-boot.ts";
import { quietLogs } from "./helpers/globals.ts";
import { passkeyFields } from "./helpers/passkey.ts";

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
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "a@x.test",
      password: PASSWORD,
      isAdmin: true,
    });
    const bob = await createUser(parent.db, {
      origin: "seed",
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
    // One plain line first: for whom, then the apps; the state facts follow.
    const line = maria.slice(0, maria.indexOf("</li>"));
    expect(line.indexOf("Maria&#39;s bakery")).toBeLessThan(line.indexOf("alice/bakery"));
    expect(line.indexOf("alice/bakery")).toBeLessThan(line.indexOf("has not reported yet"));
    expect(line).not.toContain('class="card');
    expect(maria).toContain('href="https://maria--forge.test"');
    expect(maria).toMatch(/data-claimed="no"/);
    expect(html).not.toContain("forges-sent");
    const lou = html.slice(html.indexOf('data-forge="lou"'));
    expect(lou).toMatch(/data-claimed="unknown"/);
    expect(html).not.toContain("claim-link-box");
    expect(maria).toContain('class="row"');
    expect(maria).toContain("Send a fresh link");
    expect(lou).toContain("it did not answer just now");
    // It did not answer, so it carries the one attention badge and leads the list.
    expect(lou).toContain('data-attention="silent"');
    expect(lou).toContain("Not reporting");
    expect(html.indexOf('data-forge="lou"')).toBeLessThan(html.indexOf('data-forge="maria"'));
    expect(maria).not.toContain("data-attention");
    // Neither has reported yet.
    expect(maria).toContain("has not reported yet");
    expect(lou).toContain("has not reported yet");
    // The claim link itself is never kept, so never shown here.
    expect(html).not.toContain(claimUrl.split("#")[1]!);
  });

  test("the admin's page carries the forges side by side: columns, shared use, no heartbeat yet", async () => {
    const res = await list(admin);
    expect(res.status).toBe(200);
    const html = (await res.text()).replace(/\s+/g, " ");
    for (const col of ["Forge", "Address", "Size", "Memory", "CPU", "Disk", "Apps", "Last heartbeat"])
      expect(html).toContain(`<th scope="col">${col}</th>`);
    const maria = html.slice(html.indexOf('data-compare="maria"'), html.indexOf("</tr>", html.indexOf('data-compare="maria"')));
    expect(maria).toContain('data-use="shared"');
    expect(maria).toContain("<td>small · 2 GiB, 1 core, 2 GiB</td>");
    expect(maria).toContain("<td>shared</td>");
    expect(maria).toContain("<td>none yet</td>");
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
    const who = { token: claimUrl.split("#")[1]!, username: "mara", email: "m@bakery.test" };
    const claimed = await fetch(`${childServers.url}/claim`, {
      method: "POST",
      headers: { origin: childServers.url },
      body: new URLSearchParams({
        ...who,
        ...(await passkeyFields(childServers.url, "/claim/options", who)),
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
    expect(rows.maria.nextStep.key).toBe("unreported");
  });

  test("a row ends with the first step its person has not taken, read from the child's beat", async () => {
    const beatTo = () =>
      sendBeat(child, (url, init) => fetch(url.replace("https://forge.test", parentServers.url), init));
    const words = async () => {
      const html = (await (await list(admin)).text()).replace(/\s+/g, " ");
      const at = html.indexOf('data-forge="maria"');
      const row = html.slice(at, html.indexOf("</li>", at));
      return /not claimed yet|no everyday account yet|no tell yet|going: last tell|has not reported yet/.exec(row)?.[0];
    };
    const mariaStep = async () => {
      const tool = (await (await mcp(adminRw)).json()) as any;
      return JSON.parse(tool.result.content[0].text).forges.find((f: any) => f.name === "maria").nextStep;
    };
    // The claim made the child's person an admin; nothing else yet.
    expect(await beatTo()).toBe(true);
    expect(await words()).toBe("no everyday account yet");
    expect((await mariaStep()).words).toBe("no everyday account yet");
    const person = child.db.query<{ id: string }, []>("SELECT id FROM user WHERE is_admin = 1 AND kind = 'user' AND is_agent = 0").get()!;
    keepAdmin(child.db, getUserById(child.db, person.id)!);
    expect(await beatTo()).toBe(true);
    expect(await words()).toBe("no tell yet");
    expect((await mariaStep()).words).toBe("no tell yet");
    const repo = child.db.query<{ id: string }, []>("SELECT id FROM repo LIMIT 1").get()!;
    child.db
      .query("INSERT INTO issue (id, repo_id, number, title, author_id, created_at) VALUES ('t1', ?1, 9999, 'hello', ?2, '2030-02-03T04:05:06.000Z')")
      .run(repo.id, person.id);
    expect(await beatTo()).toBe(true);
    expect(await words()).toBe("going: last tell");
    const step = await mariaStep();
    expect(step).toMatchObject({ key: "going", lastTellAt: "2030-02-03T04:05:06.000Z" });
    expect(step.words).toBe("going: last tell 2030-02-03T04:05:06.000Z");
  });

  test("GET /api/v1/forges answers the MCP tool's rows, and an old unclaimed child is flagged", async () => {
    const made = await spawn({ name: "dusty", apps: ["alice/bakery"], dryRun: false });
    expect(made.status).toBe(201);
    // A calm second child, named to sort before dusty: attention first must put dusty ahead of it.
    expect((await spawn({ name: "calm", apps: ["alice/bakery"], dryRun: false })).status).toBe(201);
    const file = join(dir, "spawn", "dusty.json");
    const ledger = JSON.parse(await Bun.file(file).text());
    ledger.createdAt = new Date(Date.now() - 5 * 86_400_000).toISOString();
    await Bun.write(file, JSON.stringify(ledger));
    const before = parent;
    useChildFetch(before, (url) =>
      url.startsWith("https://dusty--forge.test/")
        ? Promise.resolve(Response.json({ claimed: false, lastActivityAt: new Date().toISOString() }))
        : url.startsWith("https://calm--forge.test/")
          ? Promise.resolve(Response.json({ claimed: true, lastActivityAt: new Date().toISOString() }))
          : Promise.reject(new Error("unreachable")),
    );
    const api = await fetch(`${parentServers.url}/api/v1/forges`, { headers: { authorization: `Bearer ${adminRw}` } });
    expect(api.status).toBe(200);
    const body = (await api.json()) as { items: any[]; next_cursor: null };
    expect(body.next_cursor).toBeNull();
    const tool = (await (await mcp(adminRw)).json()) as any;
    const forges = JSON.parse(tool.result.content[0].text).forges as any[];
    expect(body.items.map((r) => r.name)).toEqual(forges.map((r) => r.name));
    const names = body.items.map((r) => r.name);
    expect(names.indexOf("dusty")).toBeLessThan(names.indexOf("calm"));
    expect(body.items.find((r) => r.name === "calm").attention).toBeNull();
    const dustyApi = body.items.find((r) => r.name === "dusty");
    expect(dustyApi.attention).toBe("unclaimed");
    expect(dustyApi.claimed).toBe(false);
    expect(dustyApi).toMatchObject(forges.find((r) => r.name === "dusty"));
    expect(dustyApi.nextStep.key).toBe("unreported");
    // Admin only: a non-admin is 403, a signed-out caller 401.
    const bob = await fetch(`${parentServers.url}/api/v1/forges`, { headers: { authorization: `Bearer ${bobRw}` } });
    expect(bob.status).toBe(403);
    expect((await fetch(`${parentServers.url}/api/v1/forges`)).status).toBe(401);
  });

  test("each step in words, and a beat with a bad value loses the field, not the beat", () => {
    const beat = (o: Record<string, unknown>) =>
      parseBeat(JSON.stringify({ name: "maria", at: 1, version: "1.0.0", openProposals: 0, children: 0, ...o }));
    const full = { claimed: true, everyday: true, lastTellAt: null };
    expect(nextStepOf(null, undefined).words).toBe("has not reported yet");
    expect(nextStepOf(false, beat({ ...full, claimed: false })).words).toBe("not claimed yet");
    expect(nextStepOf(true, beat({ ...full, everyday: false })).words).toBe("no everyday account yet");
    expect(nextStepOf(true, beat(full)).words).toBe("no tell yet");
    expect(nextStepOf(true, beat({ ...full, lastTellAt: "2030-01-01T00:00:00Z" })).key).toBe("going");
    // An older child says none of it.
    expect(nextStepOf(true, beat({}))?.key).toBe("unreported");
    for (const bad of [{ claimed: "yes" }, { everyday: 1 }, { lastTellAt: "soon" }, { lastTellAt: "2030-01-01T00:00:00Z (\u001b[31m)" }, { lastTellAt: "Jan 1 2030 (\u001b[31mx)" }, { lastTellAt: 5 }]) {
      const kept = beat({ ...full, ...bad });
      expect(kept).toBeDefined();
      expect(kept?.name).toBe("maria");
      expect(Object.keys(bad).every((k) => !(k in kept!))).toBe(true);
    }
  });
});

describe("the claim link's markup", () => {
  test("is drawn from the design system and stays one tap to copy", async () => {
    const { claimLinkBody } = await import("../src/web/pages/new-forge.ts");
    const out = claimLinkBody("https://x.test/claim#abc", true).text;
    expect(out).not.toContain("claim-link-box");
    expect(out).toContain('id="claim-link"');
    expect(out).toContain('class="row"');
    // The long link wraps rather than ellipsizes: only .setting-list lifts nowrap.
    expect(out).toContain("list setting-list");
    expect(out).toContain("Copy the link");
  });

  test("offers the forges sent only to an admin: /forges is a 404 to anyone else", async () => {
    const { claimLinkBody } = await import("../src/web/pages/new-forge.ts");
    expect(claimLinkBody("https://x.test/claim#abc", true).text).toContain('href="/forges"');
    expect(claimLinkBody("https://x.test/claim#abc", false).text).not.toContain('href="/forges"');
    expect(claimLinkBody("https://x.test/claim#abc", false).text).not.toContain("Forges you sent");
  });
});
