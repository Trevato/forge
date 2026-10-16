/**
 * The chain of forges (#1085): a child carries a fork of its parent's forge
 * code with the follow mode its spawner chose; a grandchild's fork names the
 * child's; the chain reads the same from both ends; severing cuts the link
 * and nothing else; the heartbeat tells the parent.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { childDirOf, spawnForge } from "../src/actions/spawn.ts";
import { createApp, type App } from "../src/app.ts";
import { getRepo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { runGit } from "../src/git/env.ts";
import { repoDir } from "../src/git/repos.ts";
import { commitFiles } from "../src/git/write.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { chainLines, chainView, forgeLinkOf, severChain } from "../src/spawn/chain.ts";
import { parseBeat, sendBeat, standing } from "../src/spawn/heartbeat.ts";
import { planSpawn } from "../src/spawn/plan.ts";
import { hostedPlacement } from "../src/spawn/placement.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const author = { name: "a", email: "a@x.invalid" };
const source = { catalog: [], briefs: [], subscriptions: [] };

const spawn = (app: App, owner: any, name: string, host: string, followMode?: string) =>
  spawnForge(
    app,
    owner,
    { name, org: name, apps: [], carryBriefs: false, carrySubscriptions: false, ...(followMode ? { followMode } : {}) },
    source,
    {
      placement: hostedPlacement({ host }),
      request: new Request(`https://${host}/x`, { method: "POST", headers: { origin: `https://${host}` } }),
      url: new URL(`https://${host}/x`),
    },
  );

describe("the chain of forges", () => {
  let dir = "";
  let root: App;
  let child: App;
  let grand: App;
  let servers: Servers;
  let cookie = "";

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-chain-"));
    root = createApp({ dataDir: dir, url: "https://root.test", port: 0, forgeRepo: "alice/forge-code" });
    const alice = await createUser(root.db, { trusted: true, username: "alice", email: "a@x.test", isAdmin: true });
    if (!alice.ok) throw new Error("user");
    const made = await createRepo(root, alice.value, { name: "forge-code", visibility: "public" });
    if (!made.ok) throw new Error("repo");
    const c = await commitFiles(repoDir(root.reposRoot, "alice", "forge-code"), {
      branch: "main",
      message: "forge v1",
      files: [{ path: "README.md", content: "# forge\n" }],
      author,
    });
    if (!c.ok) throw new Error("commit");

    const a = await spawn(root, alice.value, "kid", "root.test", "take-updates");
    if (!a.ok) throw new Error(JSON.stringify(a.error));
    child = createApp({ dataDir: childDirOf(root, a.value.bodyId), url: "https://kid.test", port: 0 });
    // The child's owner changes their forge all they want.
    const own = await commitFiles(repoDir(child.reposRoot, "kid", "forge"), {
      branch: "main",
      message: "mine",
      files: [{ path: "NOTES.md", content: "mine\n" }],
      author,
    });
    if (!own.ok) throw new Error("own commit");

    const founder = getUserByName(child.db, "alice")!;
    const b = await spawn(child, founder, "tot", "kid.test");
    if (!b.ok) throw new Error(JSON.stringify(b.error));
    grand = createApp({ dataDir: childDirOf(child, b.value.bodyId), port: 0 });
    servers = await serve(grand);
    const owner = getUserByName(grand.db, "alice")!;
    cookie = `forge_session=${createSession(grand.db, owner.id).token}`;
  }, 60_000);

  afterAll(async () => {
    servers.stop();
    grand.close();
    child.close();
    root.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("followMode is validated and defaults to tell-me", () => {
    const base = { name: "x", org: "x", apps: [], carryBriefs: false, carrySubscriptions: false };
    expect(planSpawn(base, source).ok).toBe(true);
    const bad = planSpawn({ ...base, followMode: "yolo" }, source);
    expect(bad.ok).toBe(false);
    const grandLink = planSpawn({ ...base, followMode: "tell-me" }, source);
    expect(grandLink.ok && grandLink.value.followMode).toBeUndefined();
  });

  test("the child carries a fork of the parent's forge code in the chosen mode", async () => {
    const link = await forgeLinkOf(child);
    expect(link?.repo).toBe("kid/forge");
    expect(link?.upstream).toBe("alice/forge-code");
    expect(link?.mode).toBe("take-updates");
    expect(link?.chain.map((h) => h.repo)).toEqual(["alice/forge-code"]);
    expect(getRepo(child.db, "kid", "forge")).toBeDefined();
  });

  test("the grandchild's fork names the child's forge, mode tell-me by default", async () => {
    const link = await forgeLinkOf(grand);
    expect(link?.upstream).toBe("kid/forge");
    expect(link?.mode).toBe("tell-me");
    const log = await runGit(["log", "--oneline"], { cwd: repoDir(grand.reposRoot, "tot", "forge") });
    expect(log.ok && log.value).toContain("mine");
  });

  test("the chain reads to the root from the grandchild, and from the child", async () => {
    const g = await chainView(grand);
    expect(g?.lines.map((l) => l.repo)).toEqual(["alice/forge-code", "kid/forge", "tot/forge"]);
    expect(g?.lines.map((l) => l.mode)).toEqual([null, "take-updates", "tell-me"]);
    expect(g?.lines[1]!.ahead).toBe(1);
    expect(g?.lines[2]!.here).toBe(true);
    const c = await chainView(child);
    expect(c?.lines.map((l) => l.repo)).toEqual(["alice/forge-code", "kid/forge"]);
    expect(await chainView(root)).toBeUndefined();

    const page = (await (await fetch(`${servers.url}/tot/forge/following`, { headers: { cookie } })).text()).replace(/\s+/g, " ");
    expect(page).toContain("alice/forge-code");
    expect(page).toContain("kid/forge");
    expect(page).toContain("takes updates");
    expect(page).toContain("tells when the parent moves");
    expect(page).toContain("1 of its own");
  });

  test("the heartbeat carries the forge's tip", async () => {
    const beat = JSON.parse(JSON.stringify(standing(grand, "tot")));
    expect(beat.forgeTip ?? null).toBeNull(); // standing() is counts; the sent body adds the tip
    let sent = "";
    await sendBeat(grand, (async (_u: string, init?: RequestInit) => {
      sent = String(init?.body);
      return new Response("{}");
    }) as any);
    const parsed = parseBeat(sent);
    expect(parsed?.forgeTip).toMatch(/^[0-9a-f]{40,64}$/);
    expect(parsed?.severedAt).toBeNull();
    expect(parseBeat(sent.replace(/"forgeTip":"[^"]*"/, '"forgeTip":"<x>"'))).toBeUndefined();
  });

  test("the API reads the chain, and only the owner severs it there", async () => {
    const owner = getUserByName(grand.db, "alice")!;
    const bearer = (id: string) => ({ authorization: `Bearer ${createToken(grand.db, id, "t", "rw").token}` });
    const got = (await (await fetch(`${servers.url}/api/v1/repos/tot/forge/following`, { headers: bearer(owner.id) })).json()) as any;
    expect(got.chain.map((l: any) => l.repo)).toEqual(["alice/forge-code", "kid/forge", "tot/forge"]);
    expect(got.severedAt).toBeNull();
    const reader = await createUser(grand.db, { trusted: true, username: "apireader", email: "ar@x.test" });
    if (!reader.ok) throw new Error("reader");
    const denied = await fetch(`${servers.url}/api/v1/repos/tot/forge/following/sever`, { method: "POST", headers: bearer(reader.value.id) });
    expect(denied.status).toBeGreaterThanOrEqual(401);
    expect((await forgeLinkOf(grand))?.severedAt).toBeUndefined();
    const other = await fetch(`${servers.url}/api/v1/repos/tot/forge/following/sever`, { method: "POST" });
    expect(other.status).toBeGreaterThanOrEqual(401);
    expect(chainLines((await chainView(grand))!).map(([k]) => k)).toEqual(["alice/forge-code", "kid/forge", "tot/forge (here)"]);
  });

  test("a hop with an address URL rejects does not break the page", async () => {
    const file = join(grand.config.dataDir, "parent.json");
    const doc = JSON.parse(await Bun.file(file).text());
    doc.forgeCode.chain[0].forge = "http://[";
    await Bun.write(file, JSON.stringify(doc));
    const res = await fetch(`${servers.url}/tot/forge/following`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("alice/forge-code");
  });

  test("sever needs the owner, a same-origin post and the word; it deletes nothing", async () => {
    const url = `${servers.url}/tot/forge/following/sever`;
    const body = (confirm: string) => new URLSearchParams({ confirm });
    const anon = await fetch(url, { method: "POST", headers: { origin: servers.url }, body: body("sever"), redirect: "manual" });
    expect(anon.status).toBeGreaterThanOrEqual(300);
    expect((await forgeLinkOf(grand))?.severedAt).toBeUndefined();
    const cross = await fetch(url, { method: "POST", headers: { cookie, origin: "https://evil.test" }, body: body("sever"), redirect: "manual" });
    expect(cross.status).toBeGreaterThanOrEqual(400);
    const reader = await createUser(grand.db, { trusted: true, username: "reader", email: "r@x.test" });
    if (!reader.ok) throw new Error("reader");
    const theirs = `forge_session=${createSession(grand.db, reader.value.id).token}`;
    await fetch(url, { method: "POST", headers: { cookie: theirs, origin: servers.url }, body: body("sever"), redirect: "manual" });
    expect((await forgeLinkOf(grand))?.severedAt).toBeUndefined();
    await fetch(url, { method: "POST", headers: { cookie, origin: servers.url }, body: body("nope"), redirect: "manual" });
    expect((await forgeLinkOf(grand))?.severedAt).toBeUndefined();

    const ok = await fetch(url, { method: "POST", headers: { cookie, origin: servers.url }, body: body("sever"), redirect: "manual" });
    expect(ok.status).toBe(303);
    const link = await forgeLinkOf(grand);
    expect(link?.severedAt).toBeDefined();
    expect(link?.upstream).toBe("kid/forge");
    // Nothing deleted: the fork and its history are there.
    expect(getRepo(grand.db, "tot", "forge")).toBeDefined();
    const log = await runGit(["log", "--oneline"], { cwd: repoDir(grand.reposRoot, "tot", "forge") });
    expect(log.ok && log.value).toContain("forge v1");
    const page = (await (await fetch(`${servers.url}/tot/forge/following`, { headers: { cookie } })).text()).replace(/\s+/g, " ");
    expect(page).toContain("follows nothing since");
    // Again changes nothing and keeps the first date.
    const again = await severChain(grand, new Date("2030-01-01"));
    expect(again.ok && again.value).toBe(link!.severedAt!);
  });

  test("the API severs for the owner, again changing nothing", async () => {
    const owner = getUserByName(grand.db, "alice")!;
    const before = (await forgeLinkOf(grand))!.severedAt!;
    const res = await fetch(`${servers.url}/api/v1/repos/tot/forge/following/sever`, {
      method: "POST",
      headers: { authorization: `Bearer ${createToken(grand.db, owner.id, "t2", "rw").token}` },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).severedAt).toBe(before);
    const got = (await (await fetch(`${servers.url}/api/v1/repos/tot/forge/following`, { headers: { cookie } })).json()) as any;
    expect(got.severedAt).toBe(before);
  });

  test("a severed forge says so in its beat", async () => {
    let sent = "";
    await sendBeat(grand, (async (_u: string, init?: RequestInit) => {
      sent = String(init?.body);
      return new Response("{}");
    }) as any);
    expect(parseBeat(sent)?.severedAt).toBe((await forgeLinkOf(grand))!.severedAt!);
  });
});
