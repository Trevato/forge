/**
 * A parent lends a child its model credential by the dollar (#10484): an
 * admin sets a cap, the child's crew reaches the model through the parent's
 * door with a bearer that is good for nothing else, every call is counted at
 * list price, and a call past the cap is refused in one sentence. The
 * parent's key never reaches the child's environment or data directory.
 * (A real cell is not booted here: the sandbox runs no cells. The door is
 * the one a cell relays in, `openBeatDoor`, reached on its loopback port.)
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { childDirOf } from "../src/actions/spawn.ts";
import { createApp, type App } from "../src/app.ts";
import { credentialEnv } from "../src/crew/runner.ts";
import { eventAudience } from "../src/core/event_audience.ts";
import { readCapped } from "../src/spawn/bounded_read.ts";
import { crewReadiness } from "../src/web/pages/crew.ts";
import { startCrew } from "../src/crew/dispatch.ts";
import { createSession } from "../src/core/sessions.ts";
import { clientRows } from "../src/spawn/clients.ts";
import { forgeLines } from "../src/tui/screens/forges.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { getUserByName } from "../src/core/users.ts";
import { settleApp } from "./helpers/tui.ts";
import type { Ctx } from "../src/http/context.ts";
import { chmod, rename, writeFile } from "node:fs/promises";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { commitFiles } from "../src/git/write.ts";
import { repoDir } from "../src/git/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { firstBoot } from "../src/spawn/first-boot.ts";
import { MAX_IN_FLIGHT } from "../src/spawn/door_guard.ts";
import { MODEL_BODY_MAX } from "../src/spawn/model_door.ts";
import { openBeatDoor, parentLocal, type BeatDoor } from "../src/spawn/beat-door.ts";
import { readCredit } from "../src/spawn/credit.ts";
import { fundedEnv, fundingOf, fundingWords, refreshFunding } from "../src/spawn/funding.ts";
import { listPriceUsd } from "../src/spawn/list_price.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const PARENT_KEY = "sk-ant-api03-PARENTS-OWN-KEY-never-lent";

describe("list price", () => {
  test("matches a hand calculation: 200k in + 40k out on Sonnet is $0.60 + $0.60", () => {
    // 200_000 / 1e6 * $3 = 0.6 ; 40_000 / 1e6 * $15 = 0.6
    expect(listPriceUsd("claude-sonnet-4-5", { inputTokens: 200_000, outputTokens: 40_000, cacheWriteTokens: 0, cacheReadTokens: 0 })).toBeCloseTo(1.2, 10);
    // Opus: 1M in $15; cache write 1M = $18.75; cache read 1M = $1.50
    expect(listPriceUsd("claude-opus-4", { inputTokens: 1e6, outputTokens: 0, cacheWriteTokens: 1e6, cacheReadTokens: 1e6 })).toBeCloseTo(35.25, 10);
    // A model nobody knows is priced as the dearest.
    expect(listPriceUsd("mystery", { inputTokens: 1e6, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 })).toBe(15);
  });
});

describe("a parent funds a child's crew", () => {
  let dir = "";
  let parent: App;
  let child: App;
  let childDir = "";
  let servers: Servers;
  let childServers: Servers;
  let door: BeatDoor;
  let adminRw = "";
  let bobRw = "";
  let childReader = "";
  const upstreamSeen: Request[] = [];
  const saved = process.env["FORGE_PARENT_LOCAL"];
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const call = (token: string, extra: Record<string, unknown> = {}) =>
    fetch(`${parentLocal(door.port)}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": token, "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 8, messages: [], ...extra }),
    });
  const spent = () => readCredit(parent, "maria")!.spentUsd;

  const put = (token: string, name: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${servers.url}/api/v1/forges/${name}/credit`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const listed = async () => {
    const res = await fetch(`${servers.url}/api/v1/forges`, { headers: { authorization: `Bearer ${adminRw}` } });
    return ((await res.json()) as { items: { name: string; creditCapUsd: number | null; creditSpentUsd: number | null }[] }).items;
  };
  /** One crew run's model call, as Claude Code makes it from the environment the child gave it. */
  const run = (env: Record<string, string>, stream = false) =>
    fetch(`${env["ANTHROPIC_BASE_URL"]}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": env["ANTHROPIC_API_KEY"] ?? "", "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 8, stream, messages: [{ role: "user", content: "hi" }] }),
    });

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-child-credit-"));
    parent = createApp({ dataDir: dir, url: "https://forge.test", port: 0 });
    const alice = await createUser(parent.db, { origin: "seed", trusted: true, username: "alice", email: "a@x.test", password: "a-long-credit-passphrase", isAdmin: true });
    const bob = await createUser(parent.db, { origin: "seed", trusted: true, username: "bob", email: "b@x.test", password: "a-long-credit-passphrase" });
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
    servers = await serve(parent);
    const made = await fetch(`${servers.url}/api/v1/forges`, {
      method: "POST",
      headers: { authorization: `Bearer ${adminRw}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "maria", apps: ["alice/bakery"], dryRun: false }),
    });
    if (made.status !== 201) throw new Error(`spawn ${made.status}`);
    const { bodyId } = (await made.json()) as { bodyId: string };
    childDir = childDirOf(parent, bodyId);
    child = createApp({ dataDir: childDir, port: 0 });
    await firstBoot(child);
    childServers = await serve(child);
    const reader = await createUser(child.db, { origin: "seed", trusted: true, username: "reader", email: "r@x.test", password: "a-long-credit-passphrase" });
    if (!reader.ok) throw new Error("child user");
    childReader = createToken(child.db, reader.value.id, "ro", "ro").token;
    // The parent's own provider, faked: it answers with usage, and keeps what it was sent.
    door = openBeatDoor(parent, {
      model: {
        upstream: () => ({ base: "https://provider.test", headers: { "x-api-key": PARENT_KEY } }),
        fetch: async (url, init) => {
          upstreamSeen.push(new Request(url, { method: init?.method ?? "POST", headers: init?.headers as Record<string, string> }));
          const usage = { input_tokens: 200_000, output_tokens: 40_000 };
          const sent = JSON.parse(new TextDecoder().decode(init?.body as ArrayBuffer)) as { stream?: boolean; fail?: boolean; hold?: boolean };
          if (sent.fail) return Response.json({ type: "error", error: { type: "overloaded_error", message: "busy" }, usage }, { status: 529 });
          if (sent.hold) await gate;
          const stream = sent.stream === true;
          if (!stream) return Response.json({ id: "m", type: "message", model: "claude-sonnet-4-5", content: [], usage });
          const sse =
            `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { model: "claude-sonnet-4-5", usage: { input_tokens: 200_000, output_tokens: 1 } } })}\n\n` +
            `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 40_000 } })}\n\n`;
          return new Response(sse, { headers: { "content-type": "text/event-stream" } });
        },
      },
    });
    process.env["FORGE_PARENT_LOCAL"] = parentLocal(door.port);
  }, 60_000);

  afterAll(async () => {
    if (saved === undefined) delete process.env["FORGE_PARENT_LOCAL"];
    else process.env["FORGE_PARENT_LOCAL"] = saved;
    door.close();
    childServers.stop();
    child.close();
    servers.stop();
    parent.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("only a site admin sets a cap, from the forge's own origin, in dollars", async () => {
    expect((await put(bobRw, "maria", { usd: 1 })).status).toBe(403);
    expect((await put(adminRw, "maria", { usd: 1 }, { origin: "https://evil.test" })).status).toBe(403);
    expect((await put(adminRw, "maria", { usd: -5 })).status).toBe(422);
    expect((await put(adminRw, "maria", { usd: "1" })).status).toBe(422);
    expect((await put(adminRw, "nobody", { usd: 1 })).status).toBe(404);
    expect(fundingOf(childDir)).toBeUndefined();
  });

  test("with no credit lent, the child's crew has no way to the parent's model", () => {
    expect(fundedEnv(childDir)).toBeUndefined();
    expect(credentialEnv({ kind: "env" }, childDir)).not.toHaveProperty("ANTHROPIC_BASE_URL", parentLocal(door.port));
  });

  test("a $1 cap: the first run reaches the model through the parent, the second is refused in one sentence", async () => {
    const set = await put(adminRw, "maria", { usd: 1 });
    expect(set.status).toBe(200);
    expect(((await set.json()) as { capUsd: number }).capUsd).toBe(1);

    // The child holds a bearer for the parent's door, and no provider credential anywhere.
    const f = fundingOf(childDir)!;
    expect(f.token.startsWith("maria.")).toBe(true);
    for (const file of await readdir(childDir, { recursive: true })) {
      const path = join(childDir, file);
      const text = await readFile(path, "latin1").catch(() => "");
      expect(text.includes(PARENT_KEY)).toBe(false);
    }
    const env = credentialEnv({ kind: "env" }, childDir);
    expect(env).toEqual({ ANTHROPIC_BASE_URL: parentLocal(door.port), ANTHROPIC_API_KEY: f.token });
    expect(JSON.stringify(env)).not.toContain(PARENT_KEY);

    // An org's grant (picked "none") reaches the same lent door (#10991).
    expect(credentialEnv({ kind: "none" }, childDir)).toEqual(env);

    const first = await run(env);
    expect(first.status).toBe(200);
    expect(((await first.json()) as { model: string }).model).toBe("claude-sonnet-4-5");
    // The provider saw the parent's key, never the child's bearer.
    expect(upstreamSeen[0]!.headers.get("x-api-key")).toBe(PARENT_KEY);
    expect(upstreamSeen[0]!.url).toBe("https://provider.test/v1/messages");

    const second = await run(env);
    expect(second.status).toBe(402);
    const refused = (await second.json()) as { error: { message: string } };
    expect(refused.error.message).toBe("maria's $1 from its parent is spent; the parent's admin can raise it.");
    expect(upstreamSeen.length).toBe(1);
  });

  test("the cap and the spend read back on both forges' APIs", async () => {
    // 200k in at $3/M + 40k out at $15/M = $1.20
    expect((await listed()).find((i) => i.name === "maria")).toMatchObject({ creditCapUsd: 1, creditSpentUsd: 1.2 });
    const mine = await fetch(`${childServers.url}/api/v1/credit`, { headers: { authorization: `Bearer ${childReader}` } });
    expect(mine.status).toBe(200);
    const said = (await mine.json()) as { capUsd: number; spentUsd: number; says: string };
    expect(said).toMatchObject({ capUsd: 1, spentUsd: 1.2 });
    expect(said.says).toBe("funded by its parent: $0 of $1 left");
    expect(fundingWords({ token: "x", capUsd: 200, spentUsd: 0.5 })).toBe("funded by its parent: $199.50 of $200 left");
  });

  test("raising the cap lends more, keeps the bearer and the spend; a stream is counted as it passes", async () => {
    const token = fundingOf(childDir)!.token;
    expect((await put(adminRw, "maria", { usd: 5 })).status).toBe(200);
    await refreshFunding(child);
    expect(fundingOf(childDir)).toMatchObject({ token, capUsd: 5, spentUsd: 1.2 });
    const env = credentialEnv({ kind: "env" }, childDir);
    const res = await run(env, true);
    expect(res.status).toBe(200);
    await res.text();
    expect((await listed()).find((i) => i.name === "maria")!.creditSpentUsd).toBe(2.4);
  });

  test("the door lends to no one without the bearer", async () => {
    const base = parentLocal(door.port);
    expect((await run({ ANTHROPIC_BASE_URL: base, ANTHROPIC_API_KEY: "maria.not-the-bearer-at-all" })).status).toBe(401);
    expect((await run({ ANTHROPIC_BASE_URL: base, ANTHROPIC_API_KEY: "" })).status).toBe(401);
    expect((await fetch(`${base}/api/v1/credit`)).status).toBe(401);
  });
  test("a body is capped by the bytes that arrive, not by what it says it is; the bearer is checked first", async () => {
    const before = upstreamSeen.length;
    const token = fundingOf(childDir)!.token;
    const big = new Uint8Array(MODEL_BODY_MAX + 1024);
    const refused = await fetch(`${parentLocal(door.port)}/v1/messages`, { method: "POST", headers: { "x-api-key": token }, body: big }).catch(() => undefined);
    // Either the runtime's own 413 or ours: never an answer from the provider.
    expect(refused === undefined || refused.status === 413).toBe(true);
    expect(upstreamSeen.length).toBe(before);
    // A chunked body declares no length at all; the count still stops it.
    const chunks = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(new Uint8Array(400));
      },
    });
    const req = new Request("http://x/", { method: "POST", body: chunks, duplex: "half" } as RequestInit);
    expect(await readCapped(req, 1000)).toBeUndefined();
    expect((await readCapped(new Request("http://x/", { method: "POST", body: "12345" }), 5))?.length).toBe(5);
    expect(await readCapped(new Request("http://x/", { method: "POST", body: "123456" }), 5)).toBeUndefined();
  });

  test("the heartbeat is still refused past 1 KB, and unsigned", async () => {
    const base = parentLocal(door.port);
    const post = (body: string, headers: Record<string, string>) =>
      fetch(`${base}/api/v1/heartbeat`, { method: "POST", headers, body });
    expect((await post("x".repeat(2048), { "x-forge-signature": "a".repeat(64) })).status).toBe(404);
    expect((await post("{}", {})).status).toBe(404);
  });

  test("a forge nobody funds answers 404 on /api/v1/credit", async () => {
    const res = await fetch(`${servers.url}/api/v1/credit`, { headers: { authorization: `Bearer ${adminRw}` } });
    expect(res.status).toBe(404);
  });

  test("a stream the client leaves is still counted; an upstream error is not charged", async () => {
    expect((await put(adminRw, "maria", { usd: 500 })).status).toBe(200);
    const token = fundingOf(childDir)!.token;
    const before = spent();
    const res = await call(token, { stream: true });
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    await Bun.sleep(20);
    expect(spent()).toBeCloseTo(before + 1.2, 6);
    const failed = await call(token, { fail: true });
    expect(failed.status).toBe(529);
    expect(spent()).toBeCloseTo(before + 1.2, 6);
  });

  test("calls in parallel pass the cap by at most the in-flight limit, and a place is given back", async () => {
    const token = fundingOf(childDir)!.token;
    const before = upstreamSeen.length;
    const held = Array.from({ length: MAX_IN_FLIGHT + 2 }, () => call(token, { hold: true }));
    const answers = await Promise.all(held.slice(MAX_IN_FLIGHT).map((p) => p));
    // Calls past the limit were refused at once, without reaching the provider.
    for (const a of answers) expect(a.status).toBe(429);
    for (let i = 0; i < 50 && upstreamSeen.length < before + MAX_IN_FLIGHT; i++) await Bun.sleep(10);
    expect(upstreamSeen.length - before).toBe(MAX_IN_FLIGHT);
    const was = spent();
    open();
    for (const p of held.slice(0, MAX_IN_FLIGHT)) {
      const r = await p;
      expect(r.status).toBe(200);
      await r.text();
    }
    expect(spent()).toBeCloseTo(was + MAX_IN_FLIGHT * 1.2, 6);
    expect((await call(token)).status).toBe(200);
  });

  test("the crew page, the /forges row and the terminal say it; a reader is not told the dollars", async () => {
    const bin = join(dir, "fake-claude");
    await writeFile(bin, "#!/bin/sh\necho 2.1.0\n");
    await chmod(bin, 0o755);
    const crew = await startCrew(child, { forgeUrl: childServers.url, localUrl: childServers.url, binary: bin, concurrency: 0, budgetUsd: 1, runTimeoutMs: 5_000 });
    try {
      const said = String(crewReadiness({ app: child } as unknown as Ctx));
      expect(said).toContain("data-funded");
      expect(said).toContain("funded by its parent: $");
      expect(said.match(/<p[\s>]/g)?.length).toBe(1);
    } finally {
      await crew.stop();
    }
    const alice = getUserByName(parent.db, "alice")!;
    const cookie = `forge_session=${createSession(parent.db, alice.id).token}`;
    const page = await (await fetch(`${servers.url}/forges`, { headers: { cookie } })).text();
    expect(page).toMatch(/data-credit[^>]*>\$[\d.]+ of \$500 lent/);
    expect(forgeLines(await clientRows(parent)).map((l) => l[1]).join("\n")).toMatch(/\$[\d.]+ of \$500 lent/);
    expect(eventAudience("forge.credit_set")).toBe("admins");
  });

  test("the terminal sets a cap as an admin, and offers it to no one else", async () => {
    const drive = (username: string) => {
      const terminal = headlessTerminal(140, 32);
      const { app: tui } = createForgeApp(parent, { sshUsername: "t", remoteAddress: "127.0.0.1", user: getUserByName(parent.db, username)! }, { terminal, exitHooks: false });
      tui.start();
      const key = (k: string, ctrl = false) => tui.dispatch({ type: "key", key: k, ctrl, alt: false, shift: false });
      return {
        text: () => tui.screen.toText(),
        async type(t: string) {
          for (const ch of t) key(ch);
          await settleApp(tui);
        },
        async press(...ks: string[]) {
          ks.forEach((k) => key(k));
          await settleApp(tui);
        },
        async palette(q: string) {
          key("k", true);
          await settleApp(tui);
          await this.type(q);
        },
        stop: () => tui.stop(),
      };
    };
    const bobTui = drive("bob");
    await bobTui.palette("Lend a child");
    expect(bobTui.text()).not.toContain("Lend a child credit");
    bobTui.stop();
    const t = drive("alice");
    await t.palette("Lend a child");
    expect(t.text()).toContain("Lend a child credit");
    await t.press("enter");
    expect(t.text()).toContain("maria");
    await t.press("enter");
    await t.type("7.5");
    await t.press("enter");
    for (let i = 0; i < 50 && readCredit(parent, "maria")!.capUsd !== 7.5; i++) await Bun.sleep(10);
    expect(readCredit(parent, "maria")!.capUsd).toBe(7.5);
    // The same checks as the API: a sum that is not dollars sets nothing.
    await t.palette("Lend a child");
    await t.press("enter", "enter");
    await t.type("-3");
    await t.press("enter");
    await Bun.sleep(50);
    expect(readCredit(parent, "maria")!.capUsd).toBe(7.5);
    t.stop();
  });

  test("a child's agents screen in the terminal carries the funded line", async () => {
    const admin = await createUser(child.db, { origin: "seed", trusted: true, username: "kidadmin", email: "k@x.test", password: "a-long-credit-passphrase", isAdmin: true });
    if (!admin.ok) throw new Error("child admin");
    const terminal = headlessTerminal(160, 32);
    const { app: tui } = createForgeApp(child, { sshUsername: "t", remoteAddress: "127.0.0.1", user: admin.value }, { terminal, exitHooks: false });
    tui.start();
    const key = (k: string, ctrl = false) => tui.dispatch({ type: "key", key: k, ctrl, alt: false, shift: false });
    key("k", true);
    await settleApp(tui);
    for (const ch of "Crew agents") key(ch);
    await settleApp(tui);
    key("enter");
    await settleApp(tui);
    expect(tui.screen.toText()).toContain("funded by its parent");
    tui.stop();
  });

  test("a failed hand-off saves nothing, so a retry still mints the bearer; a child that lost it gets a new one", async () => {
    const credit = join(parent.config.dataDir, "credit", "maria.json");
    const heldBack = join(childDir, "parent.json.away");
    const doc = JSON.parse(await readFile(join(childDir, "parent.json"), "utf8")) as Record<string, unknown>;
    const spentBefore = spent();
    await rm(credit);
    await rename(join(childDir, "parent.json"), heldBack);
    // The child's directory cannot be written: 502, and no credit on the parent either.
    expect((await put(adminRw, "maria", { usd: 9 })).status).toBe(502);
    expect(readCredit(parent, "maria")).toBeUndefined();
    await rename(heldBack, join(childDir, "parent.json"));
    delete doc["credit"];
    await writeFile(join(childDir, "parent.json"), JSON.stringify(doc));
    expect(fundingOf(childDir)).toBeUndefined();
    expect((await put(adminRw, "maria", { usd: 9 })).status).toBe(200);
    expect(fundingOf(childDir)!.token.startsWith("maria.")).toBe(true);
    expect(readCredit(parent, "maria")!.capUsd).toBe(9);
    // The credit exists but the child holds nothing: the call mints again and keeps the spend.
    const keptSpend = spent();
    const old = fundingOf(childDir)!.token;
    await writeFile(join(childDir, "parent.json"), JSON.stringify(doc));
    expect((await put(adminRw, "maria", { usd: 9 })).status).toBe(200);
    expect(fundingOf(childDir)!.token).not.toBe(old);
    expect(spent()).toBe(keptSpend);
    expect(spentBefore).toBeGreaterThan(0);
    expect((await call(old)).status).toBe(401);
    expect((await call(fundingOf(childDir)!.token)).status).toBe(200);
  });

  test("bad bearers are slowed past a rate, and a good one is never turned away by them", async () => {
    const base = parentLocal(door.port);
    const codes: number[] = [];
    for (let i = 0; i < 40; i++) codes.push((await fetch(`${base}/api/v1/credit`, { headers: { authorization: `Bearer maria.guess-number-${i}-xxxx` } })).status);
    expect(codes.slice(0, 5).every((c) => c === 401)).toBe(true);
    expect(codes.at(-1)).toBe(429);
    const good = await fetch(`${base}/api/v1/credit`, { headers: { authorization: `Bearer ${fundingOf(childDir)!.token}` } });
    expect(good.status).toBe(200);
  });
});
