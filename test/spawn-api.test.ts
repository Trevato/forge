/**
 * The callers of spawnForge: POST/GET /api/v1/forges and the MCP `spawn`
 * tool. Dry-run is the default, an ro token plans and never makes, and a
 * fake placement stands in for where the child lives.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createAgent } from "../src/actions/crew.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { spawnWords, usePlacement, useProbe } from "../src/spawn/door.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { ok } from "../src/kernel/result.ts";
import type { SpawnError } from "../src/actions/spawn.ts";

describe("spawn over the API and MCP", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let rw: string;
  let ro: string;
  let bobRw: string;
  let placed = 0;

  const post = (token: string | null, payload: unknown, extra: Record<string, string> = {}) =>
    fetch(`${base}/api/v1/forges`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra },
      body: JSON.stringify(payload),
    });
  const get = (token: string) =>
    fetch(`${base}/api/v1/forges`, { headers: { authorization: `Bearer ${token}` } });
  const mcp = async (token: string, args: unknown) => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "spawn", arguments: args } }),
    });
    const r = ((await res.json()) as any).result;
    return { error: r.isError === true, text: r.content[0].text as string };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-spawn-api-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const a = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "a@forge.local", password: "a-good-passphrase", adminIfFirst: true });
    const b = await createUser(app.db, { origin: "seed", trusted: true, username: "bob", email: "b@forge.local", password: "a-good-passphrase" });
    if (!a.ok || !b.ok) throw new Error("users");
    rw = createToken(app.db, a.value.id, "rw", "rw").token;
    ro = createToken(app.db, a.value.id, "ro", "ro").token;
    bobRw = createToken(app.db, b.value.id, "rw", "rw").token;
    const repo = await createRepo(app, a.value, { name: "notes" });
    if (!repo.ok) throw new Error("repo");
    await commitToBranch(app, a.value, repo.value, { message: "seed", files: [{ path: "a.txt", content: "a" }] });
    const agent = await createAgent(app, a.value, { username: "scout", brief: "ship small" });
    if (!agent.ok) throw new Error(`agent ${JSON.stringify(agent.error)}`);
    useProbe(app, () => async () => true);
    usePlacement(app, {
      place: async (plan) => ok({ url: `https://${plan.name}.fake.test`, bodyId: `fake-${++placed}` }),
      retire: async () => ok(),
    });
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("size passes through the door into the plan; a bad size is a 422 on size", async () => {
    const good = await post(rw, { name: "kid", apps: ["alice/notes"], size: "medium" });
    expect(good.status).toBe(200);
    expect(((await good.json()) as any).plan.size).toBe("medium");
    const none = await post(rw, { name: "kid", apps: ["alice/notes"] });
    expect("size" in ((await none.json()) as any).plan).toBe(false);
    const bad = await post(rw, { name: "kid", apps: ["alice/notes"], size: "huge" });
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as any).message).toContain("size:");
    const viaMcp = await mcp(rw, { name: "kid", apps: ["alice/notes"], size: "huge" });
    expect(viaMcp.error).toBe(true);
    expect(viaMcp.text).toContain("size:");
  });

  test("dry-run is the default: the plan comes back and nothing is made", async () => {
    const res = await post(rw, { name: "kid", apps: ["alice/notes"], crew: ["scout"] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.dryRun).toBe(true);
    expect(body.plan.apps.map((a: any) => a.ref)).toEqual(["alice/notes"]);
    expect(body.plan.briefs).toEqual([{ agent: "scout", text: "ship small" }]);
    expect(body.leftBehind).toContain("secrets");
    expect(placed).toBe(0);
    expect(await readdir(join(dataDir, "children")).catch(() => [])).toEqual([]);
    expect(await (await get(rw)).json()).toEqual({ items: [], next_cursor: null });
  });

  test("the boundary refuses a bad name, an unknown app, an unknown crew member", async () => {
    for (const bad of [
      { name: "Bad Name", apps: [] },
      { name: "kid", apps: ["alice/nope"] },
      { name: "kid", apps: ["alice/notes"], crew: ["ghost"] },
      { name: "kid", apps: "alice/notes" },
      { name: "kid", dryRun: "no" },
    ]) {
      const res = await post(rw, bad);
      expect(res.status).toBe(422);
      expect(((await res.json()) as any).error).toBe("invalid");
    }
    expect((await post(rw, [1])).status).toBe(422);
  });

  test("a non-admin person may plan and spawn; a stranger may plan; ro may not make", async () => {
    // Bob is not a site admin — self-serve spawn is allowed for any person.
    // Empty apps: bob cannot read alice's private notes.
    expect((await post(bobRw, { name: "bobs-kid", apps: [] })).status).toBe(200);
    expect((await post(ro, { name: "kid" })).status).toBe(403);
    // A stranger may plan (dry-run); making is rate-limited in the door.
    expect((await post(null, { name: "kid" })).status).toBe(200);
    // Listing forges sent stays an admin's.
    expect((await get(bobRw)).status).toBe(403);
    expect(placed).toBe(0);
  });

  test("a cross-origin spawn is refused", async () => {
    const res = await post(rw, { name: "kid", apps: ["alice/notes"], dryRun: false }, { origin: "https://evil.test" });
    expect(res.status).toBe(403);
    expect(placed).toBe(0);
  });

  test("a fresh app is planned through the API and the MCP spawn; a bad sentence is refused", async () => {
    const api = (await (await post(rw, { name: "fresh1", apps: ["alice/notes"], fresh: "A booking page" })).json()) as any;
    expect(api.plan.fresh).toEqual({ name: "a-booking-page", description: "A booking page" });
    expect(api.copied.join("\n")).toContain("a fresh app a-booking-page");
    const m = await mcp(rw, { name: "fresh1", fresh: "A booking page" });
    expect(m.error).toBe(false);
    expect(m.text).toContain("a-booking-page");
    const bad = await post(rw, { name: "fresh1", fresh: "one\ntwo" });
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as any).message).toContain("fresh: must be one line");
    expect((await post(rw, { name: "fresh1", fresh: "x".repeat(201) })).status).toBe(422);
  });

  test("dryRun: false makes the child through the placement, and the ledger lists it", async () => {
    const res = await post(rw, { name: "kid", apps: ["alice/notes"], crew: ["scout"], dryRun: false });
    expect(res.status).toBe(201);
    const made = (await res.json()) as any;
    expect(made).toMatchObject({ dryRun: false, name: "kid", existed: false });
    expect(String(made.url)).toContain("kid");
    expect(placed).toBe(1);
    const list = (await (await get(ro)).json()) as any;
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({
      name: "kid",
      url: expect.stringContaining("kid"),
      for: null,
      apps: ["alice/notes"],
      size: "small",
      made: true,
      attention: "silent",
      // what the list carried before the client rows, kept beside them
      bodyId: "fake-1",
      done: true,
      createdAt: expect.any(String),
      placement: "hosted",
      placementNote: null,
    });
    for (const key of ["claimed", "running", "reach", "spendTodayUsd", "ceilingUsd", "use", "nextStep", "sentAt"]) expect(list.items[0]).toHaveProperty(key);

    // The same request again is answered, not made twice.
    const again = await post(rw, { name: "kid", apps: ["alice/notes"], crew: ["scout"], dryRun: false });
    expect(again.status).toBe(200);
    expect(((await again.json()) as any).existed).toBe(true);
    expect(placed).toBe(1);
  });

  test("every SpawnError kind has one status and one sentence", () => {
    const kinds: SpawnError[] = [
      { kind: "unauthorized" },
      { kind: "forbidden" },
      { kind: "cross_origin" },
      { kind: "invalid", field: "name", reason: "x" },
      { kind: "refused", reason: "children", message: "a forge holds at most 5 hosted children" },
      { kind: "exists", message: "that child is being made" },
      { kind: "failed", message: "git failed" },
    ];
    expect(kinds.map((k) => spawnWords(k).status)).toEqual([401, 403, 403, 422, 409, 409, 500]);
    for (const k of kinds) expect(String(spawnWords(k).body["message"]).length).toBeGreaterThan(5);
  });

  test("MCP: it lists as a tool, plans by default for ro, and only rw makes", async () => {
    const plan = await mcp(ro, { name: "kid2", apps: ["alice/notes"] });
    expect(plan.error).toBe(false);
    expect(JSON.parse(plan.text)).toMatchObject({ dryRun: true, says: expect.stringContaining("nothing was made") });
    const denied = await mcp(ro, { name: "kid2", apps: ["alice/notes"], dryRun: false });
    expect(denied).toEqual({ error: true, text: "forbidden: this token may read, not act" });
    // A non-admin person's rw token may plan via MCP (empty apps — no private reads).
    const asBob = await mcp(bobRw, { name: "bobs-kid2", apps: [] });
    expect(asBob.error).toBe(false);
    expect(JSON.parse(asBob.text)).toMatchObject({ dryRun: true });
    const made = await mcp(rw, { name: "kid2", apps: ["alice/notes"], dryRun: false });
    expect(made.error).toBe(false);
    expect(JSON.parse(made.text)).toMatchObject({ dryRun: false, name: "kid2" });
    expect(placed).toBe(2);
    // The claim link, a live secret, stays out of the conversation (#839)...
    expect(made.text).not.toContain("claimUrl");
    expect(made.text).not.toContain("/claim#");
    expect(JSON.parse(made.text).says).toContain("/forges");
    // ...unless asked for on purpose, and then said to be one.
    const shown = await mcp(rw, { name: "kid3", apps: ["alice/notes"], dryRun: false, reveal: true });
    expect(shown.error).toBe(false);
    const body = JSON.parse(shown.text) as { claimUrl: string; says: string };
    expect(body.claimUrl).toContain("/claim#");
    expect(body.says).toContain("live secret");
  });

  const ledgerOf = async (name: string) => JSON.parse(await Bun.file(join(dataDir, "spawn", `${name}.json`)).text());
  const parentOf = async (bodyId: string) => JSON.parse(await Bun.file(join(dataDir, "children", bodyId, "parent.json")).text());
  const sizeListed = async (name: string) => ((await (await get(ro)).json()) as any).items.find((i: any) => i.name === name)?.size;

  test("size travels through POST /api/v1/forges into the ledger, parent.json and the list; huge is refused", async () => {
    const bad = await post(rw, { name: "sized-api", apps: [], size: "huge" });
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as any).message).toStartWith("size:");
    const res = await post(rw, { name: "sized-api", apps: [], size: "medium", dryRun: false });
    expect(res.status).toBe(201);
    const ledger = await ledgerOf("sized-api");
    expect(ledger.size).toBe("medium");
    expect((await parentOf(ledger.bodyId)).size).toBe("medium");
    expect(await sizeListed("sized-api")).toBe("medium");
  });

  test("size travels through MCP spawn into the ledger, parent.json and the list", async () => {
    const m = await mcp(rw, { name: "sized-mcp", apps: [], size: "large", dryRun: false });
    expect(m.error).toBe(false);
    const ledger = await ledgerOf("sized-mcp");
    expect(ledger.size).toBe("large");
    expect((await parentOf(ledger.bodyId)).size).toBe("large");
    expect(await sizeListed("sized-mcp")).toBe("large");
  });

  test("a ledger without a size, or with a bad one, lists as small", async () => {
    const dir = join(dataDir, "spawn");
    await mkdir(dir, { recursive: true });
    await Bun.write(join(dir, "legacy-a.json"), JSON.stringify({ name: "legacy-a", bodyId: "old-a", done: true }));
    await Bun.write(join(dir, "legacy-b.json"), JSON.stringify({ name: "legacy-b", bodyId: "old-b", done: true, size: "__proto__" }));
    expect(await sizeListed("legacy-a")).toBe("small");
    expect(await sizeListed("legacy-b")).toBe("small");
  });
});
