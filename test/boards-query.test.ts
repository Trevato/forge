/**
 * Board queries: a typed query over the forge's tables runs as
 * parameterised SQL; anything unknown or injected is refused by name.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { migrations } from "../src/core/schema.ts";
import { openDb } from "../src/kernel/db.ts";
import { runQuery as run, type Scope } from "../src/boards/query.ts";
import { SOURCES } from "../src/boards/sources.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "bun:test";
import { createApp } from "../src/app.ts";
import { createAgent } from "../src/actions/crew.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve } from "../src/http/server.ts";

let db: Database;
const ALL: Scope = { repoIds: "all" };
const R1: Scope = { repoIds: ["r1"] };
const runQuery = (d: Database, q: unknown, scope: Scope = R1) => run(d, q, scope);

beforeAll(() => {
  db = openDb(":memory:", migrations);
  db.run("INSERT INTO user (id, username, email, password_hash) VALUES ('u1','u','u@x','x')");
  db.run("INSERT INTO repo (id, owner_id, name) VALUES ('r1','u1','n')");
  const run = db.prepare(
    "INSERT INTO run (id, repo_id, kind, state, cost_usd, created_at) VALUES (?, 'r1', ?, ?, ?, ?)",
  );
  run.run("a", "agent", "ok", 1, "2026-10-01T10:05:00.000Z");
  run.run("b", "agent", "failed", 2, "2026-10-01T10:45:00.000Z");
  run.run("c", "deploy", "ok", 4, "2026-10-01T11:10:00.000Z");
  // a private repo with its own run, pull, review, app, decision and spend
  db.run("INSERT INTO repo (id, owner_id, name) VALUES ('r2','u1','secret')");
  run.run("d", "agent", "ok", 8, "2026-10-01T10:20:00.000Z");
  db.run("UPDATE run SET repo_id = 'r2' WHERE id = 'd'");
  for (const [id, repo, n] of [["i1", "r1", 1], ["i2", "r2", 2], ["i3", "r1", 3]] as const) {
    db.run("INSERT INTO issue (id, repo_id, number, kind, title, author_id) VALUES (?, ?, ?, 'pull', 't', 'u1')", [id, repo, n]);
    db.run("INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, merged_at) VALUES (?, 'main', 'h', 'o', 'o', ?)", [id, id === "i3" ? null : "2026-10-02T09:30:00.000Z"]);
  }
  db.run("INSERT INTO review (id, issue_id, author_id, state, created_at) VALUES ('v1','i1','u1','approved','2026-10-02T09:00:00.000Z'), ('v2','i2','u1','commented','2026-10-02T09:10:00.000Z')");
  db.run("INSERT INTO app (id, repo_id, slug, access) VALUES ('p1','r1','one','public'), ('p2','r2','two','private')");
  db.run("INSERT INTO decision (id, kind, repo_id, state, answer, p, by, ms, created_at) VALUES ('x1','k','r1','s','a',0.5,'m',10,'2026-10-03T01:00:00.000Z'), ('x2','k','r2','s','a',0.5,'m',30,'2026-10-03T01:30:00.000Z')");
  db.run("INSERT INTO usage (run_id, repo_id, outcome, cost_usd, tokens_in, at) VALUES ('a','r1','ok',1,100,'2026-10-01T10:05:00.000Z'), ('d','r2','ok',8,50,'2026-10-01T10:20:00.000Z')");
});

describe("runQuery", () => {
  test("counts runs per hour", () => {
    const a = runQuery(db, { source: "runs", aggregate: "count", groupBy: { bucket: "hour" } });
    expect(a).toEqual({
      ok: true,
      rows: [
        { group: "2026-10-01T10:00:00Z", value: 2 },
        { group: "2026-10-01T11:00:00Z", value: 1 },
      ],
    });
  });

  test("filters, ranges and aggregates", () => {
    const sum = runQuery(db, {
      source: "runs", aggregate: "sum", column: "cost_usd",
      filter: [{ column: "state", op: "eq", value: "ok" }],
    });
    expect(sum).toEqual({ ok: true, rows: [{ group: null, value: 5 }] });
    const ranged = runQuery(db, {
      source: "runs", aggregate: "max", column: "cost_usd",
      from: "2026-10-01T10:30:00Z", to: "2026-10-01T11:00:00Z",
    });
    expect(ranged).toEqual({ ok: true, rows: [{ group: null, value: 2 }] });
    const byState = runQuery(db, { source: "runs", aggregate: "avg", column: "cost_usd", groupBy: "state" });
    expect(byState).toEqual({
      ok: true,
      rows: [{ group: "failed", value: 2 }, { group: "ok", value: 2.5 }],
    });
  });

  test("deploys are runs of kind deploy only", () => {
    expect(runQuery(db, { source: "deploys", aggregate: "count" })).toEqual({
      ok: true, rows: [{ group: null, value: 1 }],
    });
  });

  test("an unknown column is refused by name", () => {
    const a = runQuery(db, { source: "runs", aggregate: "count", filter: [{ column: "nope", op: "eq", value: "x" }] });
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.error).toContain("nope");
  });

  test("an unknown source and op are refused by name", () => {
    const s = runQuery(db, { source: "user", aggregate: "count" });
    expect(!s.ok && s.error).toContain("user");
    const o = runQuery(db, { source: "runs", aggregate: "count", filter: [{ column: "state", op: "like", value: "x" }] });
    expect(!o.ok && o.error).toContain("like");
  });

  test("an injected column name is refused", () => {
    for (const column of ['state" FROM run; DROP TABLE run; --', "state; --", "constructor", "__proto__"]) {
      expect(runQuery(db, { source: "runs", aggregate: "count", groupBy: column }).ok).toBe(false);
      expect(runQuery(db, { source: "runs", aggregate: "sum", column }).ok).toBe(false);
      expect(
        runQuery(db, { source: "runs", aggregate: "count", filter: [{ column, op: "eq", value: "x" }] }).ok,
      ).toBe(false);
    }
    expect(runQuery(db, { source: "runs", aggregate: "count", groupBy: { bucket: "hour'); --" } }).ok).toBe(false);
    expect(db.query("SELECT COUNT(*) AS n FROM run").get()).toEqual({ n: 4 });
  });

  test("an injected value is only data", () => {
    const a = runQuery(db, {
      source: "runs", aggregate: "count",
      filter: [{ column: "state", op: "eq", value: "ok' OR '1'='1" }],
    });
    expect(a).toEqual({ ok: true, rows: [{ group: null, value: 0 }] });
  });

  test("bad shapes are refused, not thrown", () => {
    for (const q of [null, 3, [], {}, { source: "runs" }, { source: "runs", aggregate: "sum" },
      { source: "runs", aggregate: "sum", column: "state" },
      { source: "runs", aggregate: "count", from: "never" },
      { source: "runs", aggregate: "count", filter: [{ column: "cost_usd", op: "eq", value: "1" }] }]) {
      expect(runQuery(db, q).ok).toBe(false);
    }
  });
});

describe("series", () => {
  test("splits each group by a second column, ordered by group then series", () => {
    const a = runQuery(db, { source: "runs", aggregate: "count", groupBy: { bucket: "hour" }, series: "kind" });
    expect(a).toEqual({
      ok: true,
      rows: [
        { group: "2026-10-01T10:00:00Z", value: 2, series: "agent" },
        { group: "2026-10-01T11:00:00Z", value: 1, series: "deploy" },
      ],
    });
  });
  test("without a group it is the series alone", () => {
    const a = runQuery(db, { source: "runs", aggregate: "sum", column: "cost_usd", series: "state" });
    expect(a).toEqual({ ok: true, rows: [{ group: null, value: 2, series: "failed" }, { group: null, value: 5, series: "ok" }] });
  });
  test("an unknown or injected series is refused by name", () => {
    expect(runQuery(db, { source: "runs", aggregate: "count", series: "kind\" FROM run; --" })).toEqual({
      ok: false, error: 'unknown column: "kind\\" FROM run; --"',
    });
    expect(runQuery(db, { source: "runs", aggregate: "count", series: 3 }).ok).toBe(false);
  });
});

describe("scope", () => {
  const count = { source: "runs", aggregate: "count" };
  test("a guest scope sees none of a private repo's runs", () => {
    expect(runQuery(db, count, { repoIds: ["r1"] })).toEqual({ ok: true, rows: [{ group: null, value: 3 }] });
    expect(runQuery(db, { ...count, filter: [{ column: "repo_id", op: "eq", value: "r2" }] }, { repoIds: ["r1"] }))
      .toEqual({ ok: true, rows: [{ group: null, value: 0 }] });
    expect(runQuery(db, { ...count, groupBy: "repo_id" }, { repoIds: ["r1"] }))
      .toEqual({ ok: true, rows: [{ group: "r1", value: 3 }] });
  });
  test("an admin scope sees all of them", () => {
    expect(runQuery(db, count, ALL)).toEqual({ ok: true, rows: [{ group: null, value: 4 }] });
    expect(runQuery(db, { ...count, groupBy: "repo_id" }, ALL)).toEqual({
      ok: true, rows: [{ group: "r1", value: 3 }, { group: "r2", value: 1 }],
    });
  });
  test("an empty scope answers with no rows", () => {
    expect(runQuery(db, count, { repoIds: [] })).toEqual({ ok: true, rows: [] });
  });
  test("a malformed scope is refused", () => {
    for (const sc of [undefined, {}, { repoIds: "r1" }, { repoIds: [1] }, { repoIds: "ALL" }]) {
      expect(run(db, count, sc as never).ok).toBe(false);
    }
  });
  test("an injected repo id is only data", () => {
    expect(runQuery(db, count, { repoIds: ["r1' OR '1'='1"] })).toEqual({ ok: true, rows: [{ group: null, value: 0 }] });
  });
  test("pulls and reviews are scoped through their issue", () => {
    const pulls = { source: "pulls", aggregate: "count" };
    expect(runQuery(db, pulls, { repoIds: ["r1"] })).toEqual({ ok: true, rows: [{ group: null, value: 2 }] });
    expect(runQuery(db, pulls, { repoIds: ["r2"] })).toEqual({ ok: true, rows: [{ group: null, value: 1 }] });
    expect(runQuery(db, { source: "reviews", aggregate: "count" }, { repoIds: ["r1"] }))
      .toEqual({ ok: true, rows: [{ group: null, value: 1 }] });
  });
  test("every other source is scoped too", () => {
    for (const source of ["apps", "decisions", "spend", "deploys"]) {
      const a = runQuery(db, { source, aggregate: "count" }, { repoIds: ["nope"] });
      expect(a).toEqual({ ok: true, rows: [{ group: null, value: 0 }] });
    }
  });
});

describe("every source", () => {
  test("pulls: a null merged_at makes a null bucket", () => {
    expect(runQuery(db, { source: "pulls", aggregate: "count", groupBy: { bucket: "day" } }, ALL)).toEqual({
      ok: true,
      rows: [{ group: null, value: 1 }, { group: "2026-10-02T00:00:00Z", value: 2 }],
    });
    expect(runQuery(db, { source: "pulls", aggregate: "count", from: "2026-10-01T00:00:00Z" }, ALL)).toEqual({
      ok: true, rows: [{ group: null, value: 2 }],
    });
  });
  test("reviews per state", () => {
    expect(runQuery(db, { source: "reviews", aggregate: "count", groupBy: "state" }, ALL)).toEqual({
      ok: true, rows: [{ group: "approved", value: 1 }, { group: "commented", value: 1 }],
    });
  });
  test("apps per access", () => {
    expect(runQuery(db, { source: "apps", aggregate: "count", groupBy: "access" }, ALL)).toEqual({
      ok: true, rows: [{ group: "private", value: 1 }, { group: "public", value: 1 }],
    });
  });
  test("decisions: avg ms per day", () => {
    expect(runQuery(db, { source: "decisions", aggregate: "avg", column: "ms", groupBy: { bucket: "day" } }, ALL)).toEqual({
      ok: true, rows: [{ group: "2026-10-03T00:00:00Z", value: 20 }],
    });
  });
  test("spend: cost per hour", () => {
    expect(runQuery(db, { source: "spend", aggregate: "sum", column: "cost_usd", groupBy: { bucket: "hour" } }, ALL)).toEqual({
      ok: true, rows: [{ group: "2026-10-01T10:00:00Z", value: 9 }],
    });
  });
});

describe("free text", () => {
  test("is not in the registry", () => {
    for (const [source, column] of [["runs", "reason"], ["runs", "branch"], ["runs", "env"], ["deploys", "branch"],
      ["decisions", "answer"], ["pulls", "head_branch"], ["pulls", "base_branch"], ["apps", "slug"]]) {
      expect(runQuery(db, { source, aggregate: "count", groupBy: column }).ok).toBe(false);
    }
  });
});

describe("sources", () => {
  test("every listed column exists in the table", () => {
    for (const [name, s] of Object.entries(SOURCES)) {
      const real = new Set(
        s.select === undefined
          ? (db.query(`PRAGMA table_info("${s.table}")`).all() as { name: string }[]).map((c) => c.name)
          : db.query(`SELECT * FROM (${s.select}) LIMIT 0`).columnNames,
      );
      for (const c of Object.keys(s.columns)) expect(real.has(c), `${name}.${c}`).toBe(true);
      expect(s.columns[s.time]).toBe("time");
    }
  });

  test("no sealed or secret column is listed", () => {
    const secret = /token(?!s_)|secret|password|hash|_enc$|sealed|key|cipher|session_id|detail|body|summary/i;
    for (const [name, s] of Object.entries(SOURCES)) {
      for (const c of Object.keys(s.columns)) expect(secret.test(c), `${name}.${c}`).toBe(false);
    }
  });
});

describe("boards API", () => {
  let dir: string;
  let app: ReturnType<typeof createApp>;
  let servers: Awaited<ReturnType<typeof serve>>;
  const tok: Record<string, string> = {};
  const call = (path: string, who: string | null, body?: string) =>
    fetch(servers.url + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(who ? { authorization: `Bearer ${tok[who]}` } : {}),
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body }),
    });
  const q = (who: string | null, query: unknown) => call("/api/v1/boards/query", who, JSON.stringify(query));

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-boards-"));
    app = createApp({ dataDir: dir, port: 0 });
    servers = await serve(app);
    const mk = async (username: string, adminIfFirst?: boolean) => {
      const r = await createUser(app.db, {
        trusted: true, username, email: `${username}@forge.local`,
        password: "a-good-passphrase", ...(adminIfFirst ? { adminIfFirst } : {}),
      });
      if (!r.ok) throw new Error(r.error);
      return r.value;
    };
    const alice = await mk("alice", true);
    const bob = await mk("bob");
    const made = await createAgent(app, alice, { username: "scout" });
    if (!made.ok) throw new Error(String(made.error));
    tok.admin = createToken(app.db, alice.id, "t", "admin").token;
    tok.bob = createToken(app.db, bob.id, "t", "admin").token;
    tok.agent = createToken(app.db, made.value.user.id, "t", "rw").token;
    app.db.run("INSERT INTO repo (id, owner_id, name) VALUES ('rb', ?, 'n')", [alice.id]);
    app.db.run("INSERT INTO run (id, repo_id, kind, state) VALUES ('ra','rb','agent','ok'), ('rc','rb','agent','failed')");
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("an admin lists the sources", async () => {
    const res = await call("/api/v1/boards/sources", "admin");
    expect(res.status).toBe(200);
    const j = (await res.json()) as { sources: { name: string }[] };
    expect(j.sources.map((s) => s.name)).toContain("runs");
  });

  test("an admin gets counts", async () => {
    const res = await q("admin", { source: "runs", aggregate: "count", groupBy: "state" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      rows: [{ group: "failed", value: 1 }, { group: "ok", value: 1 }],
    });
  });

  test("an agent token and a non-admin get 403", async () => {
    for (const who of ["agent", "bob"]) {
      expect((await call("/api/v1/boards/sources", who)).status).toBe(403);
      expect((await q(who, { source: "runs", aggregate: "count" })).status).toBe(403);
    }
  });

  test("the security sources are admin only: a non-admin gets 403, a repo scope gets nothing", async () => {
    for (const source of ["signins", "tokens", "adminActions"]) {
      expect((await q("bob", { source, aggregate: "count" })).status).toBe(403);
      expect((await q("agent", { source, aggregate: "count" })).status).toBe(403);
      expect((await q("admin", { source, aggregate: "count" })).status).toBe(200);
      expect(run(app.db, { source, aggregate: "count" }, { repoIds: ["r1"] })).toEqual({ ok: true, rows: [] });
    }
  });

  test("the security sources list no secret column", () => {
    for (const source of ["signins", "tokens", "adminActions"]) {
      for (const c of Object.keys(SOURCES[source]!.columns)) expect(c).not.toMatch(/hash|token|secret|payload|name/);
    }
  });

  test("signed out is 401", async () => {
    expect((await call("/api/v1/boards/sources", null)).status).toBe(401);
    expect((await q(null, { source: "runs", aggregate: "count" })).status).toBe(401);
  });

  test("a refusal is a 400 with its message; non-JSON is a 400", async () => {
    const bad = await q("admin", { source: "runs", aggregate: "count", groupBy: "nope" });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { message: string }).message).toContain("unknown column");
    const raw = await call("/api/v1/boards/query", "admin", "not json");
    expect(raw.status).toBe(400);
  });

  test("a body over the cap is a 413, not a 400", async () => {
    const big = JSON.stringify({ source: "runs", aggregate: "count", pad: "x".repeat(17 * 1024 * 1024) });
    const res = await call("/api/v1/boards/query", "admin", big);
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: string }).error).toBe("too_large");
  });
});
