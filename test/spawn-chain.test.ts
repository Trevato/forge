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
import { chainScreen } from "../src/tui/screens/chain.ts";
import { pullForBranch } from "../src/core/pulls.ts";
import { TAKE_BRANCH } from "../src/spawn/take.ts";
import { checkUpstream, upstreamState } from "../src/spawn/upstream.ts";
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
    const alice = await createUser(root.db, { origin: "seed", trusted: true, username: "alice", email: "a@x.test", isAdmin: true });
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

    const a = await spawn(root, alice.value, "kid", "root.test");
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
    const b = await spawn(child, founder, "tot", "kid.test", "tell-me");
    if (!b.ok) throw new Error(JSON.stringify(b.error));
    grand = createApp({ dataDir: childDirOf(child, b.value.bodyId), port: 0 });
    servers = await serve(grand);
    const owner = getUserByName(grand.db, "alice")!;
    cookie = `forge_session=${createSession(grand.db, owner.id).token}`;
  }, 240_000);

  afterAll(async () => {
    servers?.stop();
    grand?.close();
    child?.close();
    root?.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  test("followMode is validated and defaults to take-updates", () => {
    const base = { name: "x", org: "x", apps: [], carryBriefs: false, carrySubscriptions: false };
    expect(planSpawn(base, source).ok).toBe(true);
    const bad = planSpawn({ ...base, followMode: "yolo" }, source);
    expect(bad.ok).toBe(false);
    const taking = planSpawn({ ...base, followMode: "take-updates" }, source);
    expect(taking.ok && taking.value.followMode).toBeUndefined();
    const telling = planSpawn({ ...base, followMode: "tell-me" }, source);
    expect(telling.ok && telling.value.followMode).toBe("tell-me");
  });

  test("the child carries a fork of the parent's forge code in the chosen mode", async () => {
    const link = await forgeLinkOf(child);
    expect(link?.repo).toBe("kid/forge");
    expect(link?.upstream).toBe("alice/forge-code");
    expect(link?.mode).toBe("take-updates");
    expect(link?.chain.map((h) => h.repo)).toEqual(["alice/forge-code"]);
    expect(getRepo(child.db, "kid", "forge")).toBeDefined();
  });

  test("the grandchild's fork names the child's forge, mode as chosen", async () => {
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
    expect(page).toContain("take updates (as a pull you merge)");
    expect(page).toContain("tell me · ");
    expect(page).toContain("not checked yet");
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
    const reader = await createUser(grand.db, { origin: "seed", trusted: true, username: "apireader", email: "ar@x.test" });
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

  test("check-now needs a writer and a same-origin post; nothing is fetched without them", async () => {
    const url = `${servers.url}/tot/forge/following/check`;
    const post = (headers: Record<string, string>) => fetch(url, { method: "POST", headers, body: new URLSearchParams({}), redirect: "manual" });
    const guest = await post({ origin: servers.url });
    expect(guest.status).toBeGreaterThanOrEqual(300);
    expect(guest.headers.get("location") ?? "").toContain("/signin");
    const cross = await post({ cookie, origin: "https://evil.test" });
    expect(cross.status).toBeGreaterThanOrEqual(400);
    const reader = await createUser(grand.db, { origin: "seed", trusted: true, username: "checkreader", email: "cr@x.test" });
    if (!reader.ok) throw new Error("reader");
    const theirs = `forge_session=${createSession(grand.db, reader.value.id).token}`;
    const denied = await post({ cookie: theirs, origin: servers.url });
    expect(denied.status).toBeGreaterThanOrEqual(300);
    expect(denied.status).toBeLessThan(400);
    expect(denied.headers.get("location") ?? "").toContain("/tot/forge/following");
    expect(decodeURIComponent(denied.headers.get("set-cookie") ?? "")).toContain("write access");
    // Each of the three would have fetched, and so left a state behind.
    expect(await upstreamState(grand)).toBeUndefined();
  });

  test("the API carries the upstream state, null before the first check", async () => {
    const owner = getUserByName(grand.db, "alice")!;
    const got = (await (await fetch(`${servers.url}/api/v1/repos/tot/forge/following`, { headers: { authorization: `Bearer ${createToken(grand.db, owner.id, "t2", "rw").token}` } })).json()) as any;
    expect(got.upstream).toBeNull();
  });

  test("take: an admin's press opens one pull and never moves main; a reader is refused; nothing behind is up to date", async () => {
    const owner = getUserByName(grand.db, "alice")!;
    const bearer = (id: string) => ({ authorization: `Bearer ${createToken(grand.db, id, "take", "rw").token}` });
    const take = (headers: Record<string, string>) =>
      fetch(`${servers.url}/api/v1/repos/tot/forge/following/take`, { method: "POST", headers });
    const dir = repoDir(grand.reposRoot, "tot", "forge");
    const tip = async () => {
      const r = await runGit(["rev-parse", "refs/heads/main"], { cwd: dir });
      return r.ok ? r.value.trim() : "";
    };
    const before = await tip();

    const none = await take(bearer(owner.id));
    expect(none.status).toBe(200);
    const nothing = (await none.json()) as any;
    expect(nothing.kind).toBe("current");
    expect(nothing.message).toBe("Already up to date.");
    expect(pullForBranch(grand.db, getRepo(grand.db, "tot", "forge")!.id, TAKE_BRANCH)).toBeUndefined();

    const reader = await createUser(grand.db, { origin: "seed", trusted: true, username: "takereader", email: "tr@x.test" });
    if (!reader.ok) throw new Error("reader");
    expect([401, 403]).toContain((await take(bearer(reader.value.id))).status);
    expect((await take({})).status).toBe(401);

    // The parent moves; the grandchild looks (its remote is the child's repository on disk).
    const moved = await commitFiles(repoDir(child.reposRoot, "kid", "forge"), {
      branch: "main",
      message: "kid moves",
      files: [{ path: "NEWS.md", content: "news\n" }],
      author,
    });
    if (!moved.ok) throw new Error("kid commit");
    const state = await checkUpstream(grand, { remote: repoDir(child.reposRoot, "kid", "forge") });
    expect(state?.behind).toBe(1);
    const page = (await (await fetch(`${servers.url}/tot/forge/following`, { headers: { cookie } })).text()).replace(/\s+/g, " ");
    expect(page).toContain("Take the 1 new commit");
    expect(page).toContain('action="/tot/forge/following/take"');

    expect([401, 403]).toContain((await take(bearer(reader.value.id))).status);
    expect(pullForBranch(grand.db, getRepo(grand.db, "tot", "forge")!.id, TAKE_BRANCH)).toBeUndefined();
    const cross = await fetch(`${servers.url}/tot/forge/following/take`, {
      method: "POST",
      headers: { cookie, origin: "https://evil.test" },
      body: new URLSearchParams({}),
      redirect: "manual",
    });
    expect(cross.status).toBeGreaterThanOrEqual(400);
    expect(pullForBranch(grand.db, getRepo(grand.db, "tot", "forge")!.id, TAKE_BRANCH)).toBeUndefined();

    const first = await fetch(`${servers.url}/tot/forge/following/take`, {
      method: "POST",
      headers: { cookie, origin: servers.url },
      body: new URLSearchParams({}),
      redirect: "manual",
    });
    expect(first.status).toBe(303);
    const pull = pullForBranch(grand.db, getRepo(grand.db, "tot", "forge")!.id, TAKE_BRANCH);
    expect(pull?.state).toBe("open");
    expect(decodeURIComponent(first.headers.get("set-cookie") ?? "")).toContain(`in pull #${pull!.number}`);
    expect(await tip()).toBe(before);

    // Again, by the API, finds the same pull.
    const again = (await (await take(bearer(owner.id))).json()) as any;
    expect(again.kind).toBe("pull");
    expect(again.number).toBe(pull!.number);
    expect(again.message).toBe(`1 commit from your parent is in pull #${pull!.number}.`);
    expect(await tip()).toBe(before);
  });

  test("MCP: following carries upstream, and take_updates opens the take pull for the admin alone", async () => {
    const owner = getUserByName(grand.db, "alice")!;
    const rpc = async (id: string, name: string) => {
      const res = await fetch(`${servers.url}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${createToken(grand.db, id, "mcp", "rw").token}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { repo: "tot/forge" } } }),
      });
      const r = ((await res.json()) as any).result;
      return { isError: r.isError === true, value: r.isError === true ? r.content[0].text : JSON.parse(r.content[0].text) };
    };
    const dir = repoDir(grand.reposRoot, "tot", "forge");
    const tip = async () => {
      const r = await runGit(["rev-parse", "refs/heads/main"], { cwd: dir });
      return r.ok ? r.value.trim() : "";
    };
    const before = await tip();
    const stands = await rpc(owner.id, "following");
    expect(stands.value.upstream?.behind).toBe(1);

    const reader = await createUser(grand.db, { origin: "seed", trusted: true, username: "mcpreader", email: "mr@x.test" });
    if (!reader.ok) throw new Error("reader");
    expect((await rpc(reader.value.id, "take_updates")).isError).toBe(true);

    const took = await rpc(owner.id, "take_updates");
    expect(took.isError).toBe(false);
    const pull = pullForBranch(grand.db, getRepo(grand.db, "tot", "forge")!.id, TAKE_BRANCH);
    expect(took.value.kind).toBe("pull");
    expect(took.value.message).toBe(`1 commit from your parent is in pull #${pull!.number}.`);
    expect(await tip()).toBe(before);
  });

  test("take: the terminal's t key is the owner's alone, shown when behind, and toasts the pull", async () => {
    const owner = getUserByName(grand.db, "alice")!;
    const reader = await createUser(grand.db, { origin: "seed", trusted: true, username: "ttyreader", email: "tty@x.test" });
    if (!reader.ok) throw new Error("reader");
    const toasts: string[] = [];
    const ctx = { toast: (m: string) => toasts.push(m), pop() {}, push() {}, theme: {} } as any;
    const keysOf = (screen: any) => screen.keys.map((k: any) => k.keys?.[0] ?? k[0]);
    expect(keysOf(await chainScreen(grand, owner, ctx))).toContain("t");
    expect(keysOf(await chainScreen(grand, reader.value, ctx))).not.toContain("t");
    const screen = await chainScreen(grand, owner, ctx);
    screen.key({ key: "t" } as any);
    await Bun.sleep(500);
    const pull = pullForBranch(grand.db, getRepo(grand.db, "tot", "forge")!.id, TAKE_BRANCH);
    expect(toasts).toEqual([`1 commit from your parent is in pull #${pull!.number}.`]);
  });

  test("sever needs the owner, a same-origin post and the word; it deletes nothing", async () => {
    const url = `${servers.url}/tot/forge/following/sever`;
    const body = (confirm: string) => new URLSearchParams({ confirm });
    const anon = await fetch(url, { method: "POST", headers: { origin: servers.url }, body: body("sever"), redirect: "manual" });
    expect(anon.status).toBeGreaterThanOrEqual(300);
    expect((await forgeLinkOf(grand))?.severedAt).toBeUndefined();
    const cross = await fetch(url, { method: "POST", headers: { cookie, origin: "https://evil.test" }, body: body("sever"), redirect: "manual" });
    expect(cross.status).toBeGreaterThanOrEqual(400);
    const reader = await createUser(grand.db, { origin: "seed", trusted: true, username: "reader", email: "r@x.test" });
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
