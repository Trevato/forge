/**
 * /flow (#8698): the week's budget as pipes with a valve per repository.
 * A valve is a stored value only a person changes; the same valves and the
 * same queue always decide the same way; where a person looks is a
 * suggestion beside a valve and never moves it.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { acceptSuggestion, turnValveFor } from "../src/actions/valves.ts";
import { createRun, listQueued } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import { throughValves, parseLevel, suggestedLevel } from "../src/flow/valve.ts";
import { gateQueue } from "../src/flow/valve_gate.ts";
import { readPipes } from "../src/flow/pipes.ts";
import { readLevels, recordLook } from "../src/flow/valve_store.ts";
import { serve, type Servers } from "../src/http/server.ts";

type Item = { id: string; repoId: string; resumed: boolean };
const item = (id: string, repoId: string, resumed = false): Item => ({ id, repoId, resumed });
const waiting = (t: Item) => t;
const ids = (xs: readonly Item[]) => xs.map((x) => x.id);

describe("the valve rule", () => {
  test("with no valve the queue goes as it came", () => {
    const q = [item("1", "a"), item("2", "b"), item("3", "a")];
    const out = throughValves(q, waiting, new Map(), new Map());
    expect(ids(out.order)).toEqual(["1", "2", "3"]);
    expect(out.held).toEqual([]);
  });

  test("a shut valve holds its runs, and a resumed run is never held", () => {
    const q = [item("1", "a"), item("2", "b"), item("3", "a", true)];
    const out = throughValves(q, waiting, new Map([["a", 0]]), new Map());
    expect(ids(out.order)).toEqual(["2", "3"]);
    expect(ids(out.held)).toEqual(["1"]);
  });

  test("a share lets a repository start in turn up to it, then it yields but is not dropped", () => {
    const q = [item("1", "a"), item("2", "a"), item("3", "b"), item("4", "a")];
    // a may hold 10% of the week; b has started 3 already.
    const out = throughValves(q, waiting, new Map([["a", 10]]), new Map([["b", 3]]));
    expect(ids(out.order)).toEqual(["1", "3", "2", "4"]);
    expect(ids(out.yielding)).toEqual(["2", "4"]);
    expect(out.held).toEqual([]);
  });

  test("the same valves and the same queue decide the same way, every time", () => {
    const q = Array.from({ length: 12 }, (_, i) => item(String(i), ["a", "b", "c"][i % 3]!));
    const levels = new Map([["a", 30], ["b", 0], ["c", 60]]);
    const starts = new Map([["a", 4], ["c", 1]]);
    const first = JSON.stringify(throughValves(q, waiting, levels, starts));
    for (let n = 0; n < 5; n++) expect(JSON.stringify(throughValves(q, waiting, levels, starts))).toBe(first);
  });

  test("a level is a whole number 0 to 100", () => {
    expect(parseLevel("40")).toBe(40);
    expect(parseLevel(0)).toBe(0);
    for (const bad of ["101", "-1", "4.5", "x", "", null, undefined, 1.5, "1e2"]) expect(parseLevel(bad)).toBeUndefined();
  });

  test("looks suggest a share, only with enough of them and only when it differs", () => {
    const looks = [{ repoId: "a", n: 8 }, { repoId: "b", n: 2 }];
    expect(suggestedLevel(looks, "a", 100)).toBe(80);
    expect(suggestedLevel(looks, "a", 75)).toBeUndefined();
    expect(suggestedLevel(looks, "c", 100)).toBeUndefined();
    expect(suggestedLevel([{ repoId: "a", n: 3 }], "a", 100)).toBeUndefined();
  });
});

describe("/flow", () => {
  let dir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let bob: User;
  let shop = "";
  let blog = "";
  let shopId = "";
  let blogId = "";

  const login = async (username: string): Promise<string> => {
    const res = await fetch(`${servers.url}/signin`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: servers.url },
      body: new URLSearchParams({ username, password: "a-good-passphrase" }),
    });
    return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  };
  const get = (path: string, cookie: string) => fetch(`${servers.url}${path}`, { headers: { cookie }, redirect: "manual" });
  const post = (path: string, cookie: string, body: Record<string, string>, origin = servers.url) =>
    fetch(`${servers.url}${path}`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, origin, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body),
    });
  const level = (repoId: string) => readLevels(app.db).get(repoId);

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-valves-"));
    app = createApp({ dataDir: dir, port: 0 });
    servers = await serve(app);
    const make = async (username: string, adminIfFirst: boolean) => {
      const u = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst,
      });
      if (!u.ok) throw new Error(u.error);
      return u.value;
    };
    alice = await make("alice", true);
    bob = await make("bob", false);
    for (const name of ["shop", "blog"]) {
      const made = await createRepo(app, alice, { name });
      if (!made.ok) throw new Error(String(made.error));
      if (name === "shop") shopId = made.value.id;
      else blogId = made.value.id;
    }
    shop = "alice/shop";
    blog = "alice/blog";
  });
  afterAll(async () => {
    servers.stop();
    await rm(dir, { recursive: true, force: true });
  });

  test("an admin sees the pipes and a valve for each repository; anyone else does not see the page", async () => {
    createRun(app.db, { repoId: shopId, kind: "agent", reason: "assigned" });
    const cookie = await login("alice");
    const res = await get("/flow", cookie);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('class="pipes');
    expect(text).toContain(`value="${shop}"`);
    expect(text).toContain('type="range"');
    expect(text).toContain("Next tick, of 1 queued");
    expect((await get("/flow", await login("bob"))).status).toBe(404);
    expect((await get("/flow", "")).status).toBe(303);
    // The old pipeline drill links still go to the boards.
    expect((await get("/flow?out=approved", cookie)).headers.get("location")).toBe("/boards?out=approved");
  });

  test("turning a valve is one POST, stored, and the next tick's queue obeys it", async () => {
    const cookie = await login("alice");
    const q1 = createRun(app.db, { repoId: blogId, kind: "agent", reason: "assigned" });
    const before = gateQueue(app.db, listQueued(app.db, "agent", 50));
    expect(ids2(before.order)).toContain(q1.id);
    const res = await post("/flow/valve", cookie, { repo: blog, level: "0" });
    expect(res.status).toBe(303);
    expect(level(blogId)).toBe(0);
    const after = gateQueue(app.db, listQueued(app.db, "agent", 50));
    expect(ids2(after.held)).toEqual([q1.id]);
    expect(ids2(after.order)).not.toContain(q1.id);
    // The page says what it did: the turn, and what is held.
    const text = await (await get("/flow", cookie)).text();
    expect(text).toContain("1 stays queued, held by the valve");
    expect(text).toContain("alice turned it 100 → 0");
    // Open again.
    await post("/flow/valve", cookie, { repo: blog, level: "100" });
    expect(ids2(gateQueue(app.db, listQueued(app.db, "agent", 50)).held)).toEqual([]);
  });

  test("a bad level, a stranger, a cross-origin post and an agent change nothing", async () => {
    const cookie = await login("alice");
    await post("/flow/valve", cookie, { repo: shop, level: "70" });
    expect(level(shopId)).toBe(70);
    await post("/flow/valve", cookie, { repo: shop, level: "250" });
    await post("/flow/valve", cookie, { repo: shop, level: "abc" });
    expect((await post("/flow/valve", cookie, { repo: shop, level: "0" }, "https://evil.example")).status).toBe(403);
    expect((await post("/flow/valve", await login("bob"), { repo: shop, level: "0" })).status).toBe(404);
    expect(level(shopId)).toBe(70);
    const agent = { ...alice, kind: "agent" as const };
    expect(turnValveFor(app, agent, shop, 0)).toEqual({ ok: false, error: "not_found" });
    expect(turnValveFor(app, bob, shop, 0)).toEqual({ ok: false, error: "not_found" });
    expect(turnValveFor(app, alice, "alice/missing", 0)).toEqual({ ok: false, error: "not_found" });
    expect(turnValveFor(app, alice, shop, 101)).toEqual({ ok: false, error: "invalid_level" });
    expect(level(shopId)).toBe(70);
  });

  test("where a person looks is a suggestion beside a valve, taken with one tap and never by itself", async () => {
    const cookie = await login("alice");
    await post("/flow/valve", cookie, { repo: shop, level: "100" });
    // Twelve looks at the shop and one at the blog, recorded by visiting the repository page.
    for (let n = 0; n < 12; n++) recordLook(app.db, alice.id, shopId);
    await get(`/${blog}`, cookie);
    expect(level(shopId)).toBe(100);
    const page = await (await get("/flow", cookie)).text();
    expect(page).toContain("would match");
    expect(page).toContain("Take 90%");
    expect(level(shopId)).toBe(100);
    // Bob, not an admin, takes nothing.
    expect(acceptSuggestion(app, bob, shop)).toEqual({ ok: false, error: "not_found" });
    const res = await post("/flow/suggestion", cookie, { repo: shop, level: "5" });
    expect(res.status).toBe(303);
    expect(level(shopId)).toBe(90);
    // Nothing suggested now: the valve is where the looks are.
    expect(acceptSuggestion(app, alice, shop)).toEqual({ ok: false, error: "invalid_level" });
  });

  test("the pipes carry this week's real numbers", () => {
    const run = createRun(app.db, { repoId: shopId, kind: "agent", reason: "assigned" });
    app.db.query("UPDATE run SET state = 'ok', started_at = ?1, cost_usd = 2.5 WHERE id = ?2").run(new Date().toISOString(), run.id);
    const pipes = readPipes(app.db, alice.id);
    const row = pipes.valves.find((v) => v.slug === shop)!;
    expect(row.usd).toBeCloseTo(2.5);
    expect(row.runs).toBe(1);
    expect(pipes.sources.find((s) => s.source === "builders")!.usd).toBeCloseTo(2.5);
    expect(pipes.usd).toBeCloseTo(2.5);
  });
});

const ids2 = (runs: readonly { id: string }[]) => runs.map((r) => r.id);

describe("the week's reads walk an index", () => {
  test("starts, notes and shipped are never a scan of a growing table", async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-valves-plan-"));
    const app = createApp({ dataDir: dir, port: 0 });
    try {
      const sqls = [
        "SELECT repo_id, COUNT(*) AS n FROM run WHERE kind = 'agent' AND started_at >= ?1 GROUP BY repo_id",
        `SELECT i.repo_id, COUNT(*) AS n FROM issue i JOIN user u ON u.id = i.author_id
          WHERE i.created_at >= ?1 AND i.kind = 'issue' AND u.kind = 'user' AND u.is_agent = 0 GROUP BY i.repo_id`,
        `SELECT i.repo_id, COUNT(*) AS n FROM pull p JOIN issue i ON i.id = p.issue_id
          WHERE p.merged_at >= ?1 GROUP BY i.repo_id`,
      ];
      for (const sql of sqls) {
        const plan = app.db.query(`EXPLAIN QUERY PLAN ${sql}`).all("x").map((r) => (r as { detail: string }).detail);
        for (const line of plan) expect(line).not.toMatch(/^SCAN (run|issue|pull)\b(?! USING)/);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
