/**
 * Invariant (#439): an Atlas business plan is one validated value. A
 * malformed or oversized description and a plan with a loop are refused;
 * without `confirm` nothing opens; confirming opens an issue per app and
 * adapter with its links, unassigned; confirming again opens nothing more;
 * the same value seeds a spawn plan.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { DESCRIPTION_MAX, parseBusinessPlan, spawnSeed } from "../src/actions/business_plan.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { blockerNumbersFor } from "../src/core/dependencies.ts";
import { listIssues } from "../src/core/issues.ts";
import type { Repo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { createIssue } from "../src/core/issues.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { planSpawn } from "../src/spawn/plan.ts";

const bakery = {
  description: "A bakery that takes orders online, bakes to a schedule and is paid by card.",
  apps: [
    { slug: "orders", purpose: "Customers place and track orders" },
    { slug: "schedule", purpose: "The bakers see what to bake when" },
  ],
  adapters: [{ system: "Stripe", data: "Card payments and refunds" }],
  edges: [
    { from: "orders", waitsFor: "Stripe" },
    { from: "schedule", waitsFor: "orders" },
  ],
};

describe("parseBusinessPlan", () => {
  const code = (raw: unknown) => {
    const r = parseBusinessPlan(raw);
    return r.ok ? "ok" : r.error.error;
  };

  test("a good plan passes, and its edges are kept", () => {
    const r = parseBusinessPlan(bakery);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.edges.length).toBe(2);
  });

  test("a malformed or oversized description is refused", () => {
    expect(code({ ...bakery, description: 5 })).toBe("invalid");
    expect(code({ ...bakery, description: "   " })).toBe("invalid");
    expect(code({ ...bakery, description: "a\u0000b" })).toBe("invalid");
    expect(code({ ...bakery, description: "x".repeat(DESCRIPTION_MAX + 1) })).toBe("too_long");
    expect(code("a bakery")).toBe("invalid");
    expect(code(null)).toBe("invalid");
  });

  test("a plan with a dependency cycle is refused", () => {
    expect(code({ ...bakery, edges: [...bakery.edges, { from: "Stripe", waitsFor: "schedule" }] })).toBe("cycle");
    expect(code({ ...bakery, edges: [{ from: "orders", waitsFor: "orders" }] })).toBe("cycle");
  });

  test("bad parts are refused: unknown names, twice-named parts, too many, bad slugs", () => {
    expect(code({ ...bakery, edges: [{ from: "orders", waitsFor: "PayPal" }] })).toBe("unknown");
    expect(code({ ...bakery, apps: [...bakery.apps, { slug: "orders", purpose: "again" }] })).toBe("duplicate");
    expect(code({ ...bakery, apps: [{ slug: "Not A Slug", purpose: "x" }] })).toBe("invalid");
    const many = Array.from({ length: 13 }, (_, i) => ({ slug: `app-${i}`, purpose: "x" }));
    expect(code({ ...bakery, apps: many, edges: [] })).toBe("too_many");
    expect(code({ description: "x", apps: [], adapters: [] })).toBe("invalid");
  });

  test("the plan seeds a spawn plan the spawn checks accept", () => {
    const r = parseBusinessPlan(bakery);
    if (!r.ok) throw new Error(r.error.message);
    const seed = spawnSeed(r.value);
    const spawn = planSpawn(
      { name: "bakery", org: "bakery", apps: [], carryBriefs: false, carrySubscriptions: false, ...seed },
      { catalog: [], briefs: [], subscriptions: [] },
    );
    expect(spawn.ok).toBe(true);
    if (spawn.ok) {
      expect(spawn.value.direction).toBe(bakery.description);
      expect(spawn.value.fresh?.description).toContain("orders");
    }
  });
});

describe("POST …/atlas", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let repo: Repo;
  let rw = "";
  let bobRw = "";
  let alice: User;
  const post = (payload: unknown, name = "bakery", token = rw) =>
    fetch(`${servers.url}/api/v1/repos/alice/${name}/atlas`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  const issues = (r = repo) => listIssues(app.db, r.id, {});
  const another = async (name: string, visibility: "public" | "private" = "private"): Promise<Repo> => {
    const made = await createRepo(app, alice, { name, visibility });
    if (!made.ok) throw new Error(String(made.error));
    return made.value;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-atlas-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const a = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    rw = createToken(app.db, a.value.id, "rw", "rw").token;
    const b = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "bob",
      email: "bob@forge.local",
      password: "b-good-passphrase",
    });
    if (!b.ok) throw new Error(b.error);
    bobRw = createToken(app.db, b.value.id, "rw", "rw").token;
    const created = await createRepo(app, a.value, { name: "bakery", visibility: "private" });
    if (!created.ok) throw new Error(String(created.error));
    repo = created.value;
    const seeded = await commitToBranch(app, a.value, repo, {
      message: "Start",
      files: [{ path: "README.md", content: "# bakery\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("without confirm it is a dry run: the issues are shown and none opens", async () => {
    const res = await post({ plan: bakery });
    expect(res.status).toBe(200);
    const out = (await res.json()) as { status: string; issues: { title: string; blockedBy: string[] }[]; spawn: { direction: string } };
    expect(out.status).toBe("dry-run");
    expect(out.issues.map((i) => i.title)).toEqual([
      "App orders — Customers place and track orders",
      "App schedule — The bakers see what to bake when",
      "Adapter for Stripe — Card payments and refunds",
    ]);
    expect(out.issues[0]!.blockedBy).toEqual(["adapter1"]);
    expect(out.spawn.direction).toBe(bakery.description);
    expect(issues().length).toBe(0);
  });

  test("a refused plan opens nothing", async () => {
    const res = await post({ plan: { ...bakery, edges: [...bakery.edges, { from: "Stripe", waitsFor: "schedule" }] }, confirm: true });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe("cycle");
    expect(issues().length).toBe(0);
  });

  test("confirming opens the issues and links, unassigned; confirming twice opens no duplicates", async () => {
    const res = await post({ plan: bakery, confirm: true });
    expect(res.status).toBe(201);
    const out = (await res.json()) as { status: string; opened: { key: string; number: number }[]; ready: number[] };
    expect(out.status).toBe("opened");
    expect(out.opened.length).toBe(3);
    const all = issues();
    expect(all.length).toBe(3);
    expect(all.every((i) => i.assigneeId === null)).toBe(true);
    const n = new Map(out.opened.map((o) => [o.key, o.number]));
    const byNumber = new Map(all.map((i) => [i.number, i]));
    const blockers = blockerNumbersFor(app.db, all.map((i) => i.id));
    expect(blockers.get(byNumber.get(n.get("app1")!)!.id)).toEqual([n.get("adapter1")!]);
    expect(blockers.get(byNumber.get(n.get("app2")!)!.id)).toEqual([n.get("app1")!]);
    expect(out.ready).toEqual([n.get("adapter1")!]);

    // Respaced and reordered, it is the same plan.
    const again = await post({
      plan: { ...bakery, description: `  ${bakery.description}  `, apps: [...bakery.apps].reverse() },
      confirm: true,
    });
    expect(again.status).toBe(200);
    const second = (await again.json()) as { status: string; numbers: number[] };
    expect(second.status).toBe("already");
    expect(second.numbers.sort()).toEqual([...n.values()].sort());
    expect(issues().length).toBe(3);
  });

  test("a body over the cap is refused by the bytes read, even chunked with no length", async () => {
    const big = JSON.stringify({ plan: { ...bakery, description: "x".repeat(80 * 1024) } });
    const res = await fetch(`${servers.url}/api/v1/repos/alice/bakery/atlas`, {
      method: "POST",
      headers: { authorization: `Bearer ${rw}`, "content-type": "application/json" },
      body: new ReadableStream({
        start(c) {
          const bytes = new TextEncoder().encode(big);
          for (let i = 0; i < bytes.length; i += 8192) c.enqueue(bytes.slice(i, i + 8192));
          c.close();
        },
      }),
    });
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: string }).error).toBe("too_large");
  });

  test("a pillar the repository does not have is refused at the door", async () => {
    const res = await post({ plan: bakery, pillar: "P9 Nothing" });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe("unknown_pillar");
    expect((await post({ plan: bakery, pillar: 7 })).status).toBe(422);
  });

  test("someone who may only read gets 403 on confirm, and nothing opens", async () => {
    const market = await another("market", "public");
    const res = await post({ plan: bakery, confirm: true }, "market", bobRw);
    expect(res.status).toBe(403);
    expect(issues(market).length).toBe(0);
  });

  test("two confirms at once open the plan once", async () => {
    const twin = await another("twin");
    const [a, b] = await Promise.all([
      post({ plan: bakery, confirm: true }, "twin"),
      post({ plan: bakery, confirm: true }, "twin"),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(issues(twin).length).toBe(3);
  });

  test("where plans need a nod, confirming proposes once and confirming twice proposes nothing more", async () => {
    const nod = await another("nod");
    app.db.query("UPDATE repo SET plans_need_nod = 1 WHERE id = ?1").run(nod.id);
    const first = await post({ plan: bakery, confirm: true }, "nod");
    expect(first.status).toBe(202);
    const proposed = (await first.json()) as { status: string; id: string };
    expect(proposed.status).toBe("proposed");
    const again = await post({ plan: bakery, confirm: true }, "nod");
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ status: "already-proposed", id: proposed.id });
    const count = app.db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM plan_proposal WHERE repo_id = ?1").get(nod.id);
    expect(count?.n).toBe(1);
    expect(issues(nod).length).toBe(0);
  });

  test("an issue that only quotes the stamp line is not taken for an earlier confirm", async () => {
    const quoted = await another("quoted");
    const dry = (await (await post({ plan: bakery }, "quoted")).json()) as { stamp: string };
    createIssue(app.db, {
      repoId: quoted.id,
      authorId: alice.id,
      title: "Someone pasted the stamp",
      body: `Look at Atlas plan \`${dry.stamp}\` — what is it?`,
    });
    const res = await post({ plan: bakery, confirm: true }, "quoted");
    expect(res.status).toBe(201);
    expect(issues(quoted).length).toBe(4);
  });

  test("the MCP door: atlas dry-runs, then opens once, with the API's checks", async () => {
    const viaMcp = await another("viamcp");
    let id = 1;
    const call = async (args: Record<string, unknown>) => {
      const res = await fetch(`${servers.url}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${rw}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name: "atlas", arguments: args } }),
      });
      const out = (await res.json()) as { result: { isError?: boolean; content: { text: string }[] } };
      const text = out.result.content[0]!.text;
      return out.result.isError === true ? { error: text } : { value: JSON.parse(text) as { status: string } };
    };
    expect((await call({ app: "alice/viamcp", plan: bakery })).value?.status).toBe("dry-run");
    expect(issues(viaMcp).length).toBe(0);
    expect((await call({ app: "alice/viamcp", plan: bakery, pillar: "P9" })).error).toContain("pillars");
    expect((await call({ app: "alice/viamcp", plan: bakery, confirm: true })).value?.status).toBe("opened");
    expect((await call({ app: "alice/viamcp", plan: bakery, confirm: true })).value?.status).toBe("already");
    expect(issues(viaMcp).length).toBe(3);
  });
});
