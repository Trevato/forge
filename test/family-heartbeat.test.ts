/**
 * The family across forges (#425): signed heartbeats carry counts and
 * version only, unknown children and bad signatures are ignored alike, a
 * silent child reads quiet, and only the parent's admins see children.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { beatKeyOf, childDirOf } from "../src/actions/spawn.ts";
import { createApp, type App } from "../src/app.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { commitFiles } from "../src/git/write.ts";
import { repoDir } from "../src/git/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { serve, type Servers } from "../src/http/server.ts";
import {
  childStandings,
  parseBeat,
  QUIET_MS,
  sendBeat,
  sign,
  SIGNATURE_HEADER,
} from "../src/spawn/heartbeat.ts";
import { appsLine, familyLines, familyView } from "../src/spawn/family.ts";
import { firstBoot } from "../src/spawn/first-boot.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { familyScreen } from "../src/tui/screens/family.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import type { Ctx } from "../src/http/context.ts";
import { familyPage } from "../src/web/pages/family.ts";
import { row } from "../src/web/ui.ts";
import { settleApp } from "./helpers/tui.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const PASSWORD = "a-long-family-passphrase";

describe("family heartbeats", () => {
  let dir = "";
  let parent: App;
  let child: App;
  let servers: Servers;
  let key = "";
  let adminCookie = "";
  let bobCookie = "";

  const post = (body: string, sig: string | null) =>
    fetch(`${servers.url}/api/v1/heartbeat`, {
      method: "POST",
      headers: sig === null ? {} : { [SIGNATURE_HEADER]: sig },
      body,
    });
  const beat = (o: Record<string, unknown> = {}) =>
    JSON.stringify({
      name: "maria",
      at: Date.now(),
      version: "0.7.114",
      openProposals: 3,
      children: 0,
      ...o,
    });
  const signIn = async (username: string) => {
    const res = await fetch(`${servers.url}/signin`, {
      method: "POST",
      body: new URLSearchParams({ username, password: PASSWORD }),
      redirect: "manual",
    });
    return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  };
  const family = async (cookie?: string) =>
    (
      await fetch(`${servers.url}/family`, {
        headers: cookie === undefined ? {} : { cookie },
      })
    ).text();

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-family-"));
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
    const token = createToken(parent.db, alice.value.id, "rw", "rw").token;
    const repo = await createRepo(parent, alice.value, { name: "bakery" });
    if (!repo.ok) throw new Error("repo");
    const c = await commitFiles(repoDir(parent.reposRoot, "alice", "bakery"), {
      branch: "main",
      message: "bakery",
      files: [{ path: "README.md", content: "# bakery\n" }],
      author: { name: "a", email: "a@x.invalid" },
    });
    if (!c.ok) throw new Error("commit");
    servers = await serve(parent);
    const made = await fetch(`${servers.url}/api/v1/forges`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "maria", apps: ["alice/bakery"], dryRun: false }),
    });
    if (made.status !== 201) throw new Error(`spawn ${made.status}`);
    const { bodyId } = (await made.json()) as { bodyId: string };
    child = createApp({ dataDir: childDirOf(parent, bodyId), port: 0 });
    await firstBoot(child);
    key = (await beatKeyOf(parent, "maria")) ?? "";
    adminCookie = await signIn("alice");
    bobCookie = await signIn("bob");
  }, 60_000);

  afterAll(async () => {
    servers.stop();
    child.close();
    parent.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("before any report a child reads as not heard from, not as an error", async () => {
    const html = await family(adminCookie);
    expect(html).toContain("maria");
    expect(html).toContain("has not reported yet");
    expect(html).not.toContain("quiet");
  });

  test("a heartbeat holds only name, time, version and two counts", () => {
    expect(parseBeat(beat())).toBeDefined();
    expect(parseBeat(beat({ title: "secret plans" }))).toBeUndefined();
    expect(parseBeat(beat({ openProposals: -1 }))).toBeUndefined();
    expect(parseBeat(beat({ version: "<b>" }))).toBeUndefined();
    expect(parseBeat(beat({ name: "../x" }))).toBeUndefined();
    expect(parseBeat("x".repeat(5000))).toBeUndefined();
  });

  test("unknown children, bad signatures and stale times are ignored alike", async () => {
    const stranger = beat({ name: "nobody" });
    const a = await post(stranger, sign(key, stranger));
    const own = beat();
    const b = await post(own, sign("not-the-key", own));
    const c = await post(own, null);
    const old = beat({ at: Date.now() - 3_600_000 });
    const d = await post(old, sign(key, old));
    for (const r of [a, b, c, d]) expect(r.status).toBe(404);
    const state = await childStandings(parent);
    expect(state.items[0]?.state).toBe("unheard");
  });

  test("a signed heartbeat is kept, shown with its standing, and not replayable", async () => {
    const at = Date.now();
    const body = beat({ at });
    expect((await post(body, sign(key, body))).status).toBe(200);
    expect((await post(body, sign(key, body))).status).toBe(404);
    const html = await family(adminCookie);
    expect(html).toContain("reporting");
    expect(html).toContain("version 0.7.114");
    expect(html).toContain("3 open proposals");
    expect(html).toMatch(/\d+ releases? behind/);
    const stored = await readFile(join(dir, "beats", "maria.json"), "utf8");
    expect(Object.keys(JSON.parse(stored).beat).sort()).toEqual([
      "at",
      "children",
      "name",
      "openProposals",
      "version",
    ]);
  });

  test("a child that stops reporting reads quiet", async () => {
    const state = await childStandings(parent, Date.now() + QUIET_MS + 60_000);
    expect(state.items[0]?.state).toBe("quiet");
    expect(state.items[0]?.lastSeen).not.toBeNull();
  });

  test("only an admin of the parent sees children", async () => {
    expect(await family(bobCookie)).not.toContain("maria");
    expect(await family()).not.toContain("maria");
    expect(await family(adminCookie)).toContain("maria");
  });

  test("a chunked body over 1 KiB is refused unread and keeps nothing", async () => {
    const before = (await childStandings(parent)).items[0]?.lastSeen;
    const big = beat({ version: "1".repeat(4000) });
    const res = await fetch(`${servers.url}/api/v1/heartbeat`, {
      method: "POST",
      headers: { [SIGNATURE_HEADER]: sign(key, big) },
      body: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(big));
          c.close();
        },
      }),
      duplex: "half",
    } as RequestInit);
    expect(res.status).toBe(404);
    expect((await childStandings(parent)).items[0]?.lastSeen).toBe(before);
  });

  test("two identical beats at once keep only one", async () => {
    const body = beat({ at: Date.now() + 1000 });
    const rs = await Promise.all([post(body, sign(key, body)), post(body, sign(key, body))]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 404]);
  });

  test("the family has a JSON door and a terminal view with the same gate", async () => {
    const read = async (cookie?: string) =>
      (await (
        await fetch(`${servers.url}/api/v1/family`, {
          headers: cookie === undefined ? {} : { cookie },
        })
      ).json()) as { children: { name: string }[]; here: unknown };
    expect((await read()).children).toEqual([]);
    expect((await read(bobCookie)).children).toEqual([]);
    expect((await read(adminCookie)).children.map((c) => c.name)).toEqual(["maria"]);
    const guest = familyLines(await familyView(parent, false));
    const admin = familyLines(await familyView(parent, true));
    expect(guest.some(([k]) => k === "child maria")).toBe(false);
    expect(admin.some(([k]) => k === "child maria")).toBe(true);
  });

  const two = () => ({
    total: 2,
    running: 1,
    notRunning: [{ slug: "bakery", why: "asleep" }],
  });
  const line = "1 of 2 apps running — bakery asleep";

  test("the family view carries the apps line for an admin and none for a guest", async () => {
    const view = await familyView(parent, true, two);
    expect(view.children[0]?.apps).toBe(line);
    expect(familyLines(view).some(([, v]) => v === line)).toBe(true);
    expect((await familyView(parent, false, two)).children).toEqual([]);
    expect((await familyView(parent, true, () => ({ total: 0, running: 0, notRunning: [] }))).children[0]?.apps).toBeNull();
  });

  test("the terminal's family lines say where each child runs, as /forges does", async () => {
    const view = await familyView(parent, true);
    const lineOf = (v: typeof view) => familyLines(v).find(([k]) => k === "child maria")?.[1] ?? "";
    expect(view.children[0]?.placement).toBe("hosted");
    expect(lineOf(view)).toEndWith(" · hosted");
    const placed = (placement: string) => ({ ...view, children: view.children.map((c) => ({ ...c, placement })) });
    expect(lineOf(placed("own cell"))).toEndWith(" · own cell");
    expect(lineOf(placed("hosted: its cell did not come up"))).toEndWith(" · hosted: its cell did not come up");
    expect(lineOf({ ...view, children: view.children.map((c) => ({ ...c, placement: null })) })).not.toContain("hosted");
  });

  test("the terminal's Family card shows the apps line", async () => {
    const view = await familyView(parent, true, two);
    const { app } = createForgeApp(
      parent,
      { sshUsername: "alice", remoteAddress: "127.0.0.1", user: undefined },
      { terminal: headlessTerminal(120, 30), exitHooks: false },
    );
    app.start();
    await settleApp(app);
    app.push(familyScreen(app.ctx, familyLines(view)));
    await settleApp(app);
    expect(app.screen.toText()).toContain(line);
    app.stop();
  });

  test("the family page shows the apps line to an admin, escaped, and to no guest", async () => {
    const ctxOf = (isAdmin: boolean): Ctx => ({
      app: parent,
      request: new Request("http://localhost/family"),
      url: new URL("http://localhost/family"),
      params: {},
      auth: isAdmin
        ? { user: { id: 1, username: "alice", isAdmin: true } as never, scope: undefined, via: "session" }
        : { user: undefined, scope: undefined, via: "none" },
      theme: undefined,
    });
    const text = async (c: Ctx, f: Parameters<typeof familyPage>[1]) => (await familyPage(c, f)).text();
    expect(await text(ctxOf(true), two)).toContain(`<span data-apps>${line}</span>`);
    const hostileHtml = await text(ctxOf(true), () => ({
      total: 1,
      running: 0,
      notRunning: [{ slug: "<b>x</b>", why: "asleep" }],
    }));
    expect(hostileHtml).toContain("&lt;b&gt;x&lt;/b&gt; asleep");
    expect(hostileHtml).not.toContain("<b>x</b>");
    expect(await text(ctxOf(false), two)).not.toContain("data-apps");
    expect(await text(ctxOf(true), () => ({ total: 0, running: 0, notRunning: [] }))).not.toContain("data-apps");
  });

  test("the family page draws §5's row: the old lineage names are gone, the words and links stay", async () => {
    const ctx: Ctx = {
      app: parent,
      request: new Request("http://localhost/family"),
      url: new URL("http://localhost/family"),
      params: {},
      auth: { user: { id: 1, username: "alice", isAdmin: true } as never, scope: undefined, via: "session" },
      theme: undefined,
    };
    const page = await (await familyPage(ctx, two)).text();
    expect(page).not.toMatch(/lineage(-children|-here)?\b/);
    expect(page).toContain("you are here");
    expect(page).toContain('aria-label="Forges, by who sent whom"');
    expect(page).toContain('class="row"');
    expect(page).toContain("version ");
    // The tree stays a tree: what this forge sent is a list inside this forge's row.
    expect(page).toContain('<ul class="row-children">');
    expect(page.indexOf('aria-current="true"')).toBeLessThan(page.indexOf("row-children"));
  });

  test("row() nests children's rows inside its own li, after the row", () => {
    const grand = row({ title: "grand" });
    const child = row({ title: "child", children: [grand] });
    const top = row({ title: "top", children: [child] }).text;
    expect(top.indexOf("top")).toBeLessThan(top.indexOf("child"));
    expect(top.indexOf("child")).toBeLessThan(top.indexOf("grand"));
    expect(top.match(/<ul class="row-children">/g)?.length).toBe(2);
    expect(row({ title: "x" }).text).not.toContain("row-children");
    expect(row({ title: "x", children: [] }).text).not.toContain("row-children");
  });

  test("appsLine counts what runs and says why the rest does not", () => {
    expect(appsLine({ total: 2, running: 0, notRunning: [{ slug: "a", why: "not started" }, { slug: "b", why: "boom: x" }] }))
      .toBe("0 of 2 apps running — a not deployed; b failing");
  });

  test("a child sends its own beat, signed with the key spawn gave it", async () => {
    const sent: { url: string; body: string; sig: string }[] = [];
    const ok = await sendBeat(child, async (url, init) => {
      sent.push({
        url,
        body: String(init?.body),
        sig: String((init?.headers as Record<string, string>)[SIGNATURE_HEADER]),
      });
      return new Response("{}");
    });
    expect(ok).toBe(true);
    expect(sent[0]?.url).toBe("https://forge.test/api/v1/heartbeat");
    expect(sent[0]?.sig).toBe(sign(key, sent[0]!.body));
    expect(Object.keys(JSON.parse(sent[0]!.body)).sort()).toEqual([
      "at",
      "ceilingUsd",
      "children",
      "claimed",
      "everyday",
      "lastTellAt",
      "name",
      "openProposals",
      "spendTodayUsd",
      "version",
    ]);
    // A forge that was not spawned has no one to tell.
    expect(await sendBeat(parent, async () => new Response("{}"))).toBe(false);
  });

  test("the parent's /family says where a child's code is, and when it stopped following", async () => {
    const tip = "0123456789abcdef0123456789abcdef01234567";
    const send = async (o: Record<string, unknown>) => {
      const body = beat({ at: Date.now() + 1000, ...o });
      expect((await post(body, sign(key, body))).status).toBeLessThan(300);
    };
    await send({ forgeTip: tip });
    const before = (await family(adminCookie)).replace(/\s+/g, " ");
    expect(before).toContain("code at");
    expect(before).toContain("0123456");
    expect(before).not.toContain("follows nothing since");
    await send({ forgeTip: tip, severedAt: "2030-02-03T04:05:06.000Z", at: Date.now() + 2000 });
    const after = (await family(adminCookie)).replace(/\s+/g, " ");
    expect(after).toContain("follows nothing since 2030-02-03");
    expect(after).not.toContain("code at");
  });

  test("a beat may say how the child follows: mode, commits behind, conflict", async () => {
    const good = (o: Record<string, unknown>) => parseBeat(beat(o));
    expect(good({})?.mode).toBeUndefined();
    expect(good({ mode: "take-updates", upstreamBehind: 3, conflict: true })).toMatchObject({
      mode: "take-updates",
      upstreamBehind: 3,
      conflict: true,
    });
    expect(good({ mode: "tell-me", upstreamBehind: null, conflict: false })?.upstreamBehind).toBeNull();
    for (const bad of [
      { upstreamBehind: -1 },
      { upstreamBehind: 1.5 },
      { upstreamBehind: "3" },
      { mode: "yolo" },
      { mode: 1 },
      { conflict: "yes" },
    ])
      expect(good(bad)).toBeUndefined();

    const send = async (o: Record<string, unknown>) => {
      const body = beat({ at: Date.now() + 5000, ...o });
      expect((await post(body, sign(key, body))).status).toBeLessThan(300);
    };
    await send({ mode: "take-updates", upstreamBehind: 3, conflict: true });
    const text = (await family(adminCookie)).replace(/\s+/g, " ");
    expect(text).toContain("takes updates · 3 commits behind · conflict open");
    const api = (await (await fetch(`${servers.url}/api/v1/family`, { headers: { cookie: adminCookie } })).json()) as {
      children: { mode: string; upstreamBehind: number; conflict: boolean }[];
    };
    expect(api.children[0]).toMatchObject({ mode: "take-updates", upstreamBehind: 3, conflict: true });

    // The terminal's copy: the same line for an admin, nothing for a guest.
    const word = "takes updates · 3 commits behind · conflict open";
    expect(familyLines(await familyView(parent, true)).some(([k, v]) => k === "" && v === word)).toBe(true);
    expect(JSON.stringify(familyLines(await familyView(parent, false)))).not.toContain("commits behind");
  });
  test("a fork child puts its mode, commits behind and conflict on the wire; an ordinary child sends none", async () => {
    const dataDir = child.config.dataDir;
    const parentJson = join(dataDir, "parent.json");
    const original = await readFile(parentJson, "utf8");
    const bodyOf = async () => {
      let body = "";
      await sendBeat(child, async (_url, init) => {
        body = String(init?.body);
        return new Response("{}");
      });
      return JSON.parse(body) as Record<string, unknown>;
    };
    const upstream = (behind: number, taken: unknown) =>
      writeFile(join(dataDir, "upstream.json"), JSON.stringify({ behind, checkedAt: Date.now(), taken }));
    await mkdir(repoDir(child.reposRoot, "kid", "forge"), { recursive: true });
    const keys = ["mode", "upstreamBehind", "conflict"];
    try {
      const ordinary = await bodyOf();
      for (const k of keys) expect(k in ordinary).toBe(false);

      const doc = JSON.parse(original) as Record<string, unknown>;
      const fork = (mode: string) =>
        writeFile(
          parentJson,
          JSON.stringify({ ...doc, forgeCode: { repo: "kid/forge", upstream: "alice/lib", mode, tip: "", chain: [] } }),
        );
      await fork("take-updates");
      await upstream(3, { kind: "conflict", files: ["a.ts"], issue: 7 });
      expect(await bodyOf()).toMatchObject({ mode: "take-updates", upstreamBehind: 3, conflict: true });

      await upstream(2_000_000, { kind: "conflict", files: ["a.ts"], issue: null });
      expect(await bodyOf()).toMatchObject({ upstreamBehind: 1_000_000, conflict: false });

      await fork("tell-me");
      await rm(join(dataDir, "upstream.json"));
      expect(await bodyOf()).toMatchObject({ mode: "tell-me", upstreamBehind: null, conflict: false });
    } finally {
      await writeFile(parentJson, original);
      await rm(join(dataDir, "upstream.json"), { force: true });
    }
  });

  test("a stored beat with spend shows on /forges and in the MCP forges tool", async () => {
    const body = beat({ at: Date.now() + 60_000, spendTodayUsd: 8.5, ceilingUsd: 10 });
    expect((await post(body, sign(key, body))).status).toBe(200);
    const page = await (await fetch(`${servers.url}/forges`, { headers: { cookie: adminCookie } })).text();
    expect(page).toContain('data-spend="warn"');
    expect(page).toContain("$8.50 of $10 today");
    const alice = getUserByName(parent.db, "alice")!;
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${createToken(parent.db, alice.id, "mcp", "rw").token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "forges", arguments: {} } }),
    });
    const out = JSON.parse(((await res.json()) as any).result.content[0].text);
    expect(out.forges.find((f: any) => f.name === "maria")).toMatchObject({ spendTodayUsd: 8.5, ceilingUsd: 10 });
  });
});
