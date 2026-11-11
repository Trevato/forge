/**
 * The data browser's core: who sees which SQLite file, what a query may be,
 * and what is masked.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp as createAppRecord } from "../src/core/apps.ts";
import { createRepo } from "../src/core/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { envDataDir } from "../src/apps/data.ts";
import { createUser, type User } from "../src/core/users.ts";
import { rows, tables } from "../src/data/browse.ts";
import { ALLOW, maskPlan } from "../src/data/mask.ts";
import { query } from "../src/data/query.ts";
import { findSource, listSources } from "../src/data/sources.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const AUDITED_CLEAR: string[] = [
  "app_domain.said",
  "app_feature_setting.value",
  "comment.body",
  "degraded_span.sentence",
  "efficiency_sample.value",
  "feed_chip.value",
  "fleet_operation.value",
  "gift_redeem.code_id",
  "issue.body",
  "oauth_flow.detail",
  "oidc_key.public_jwk",
  "probe.said",
  "prompt_source.last_said",
  "repo_upstream_check.detail",
  "report.body",
  "review.body",
  "run.check_detail",
  "subscription.resting_said",
  "subscription_limit.said",
  "user_key.blob",
  "webhook_ping.payload",
  "week_projection.body",
  "week_retro.body",
];

describe("data browser core", () => {
  let dataDir: string;
  let app: App;
  let admin: User;
  let alice: User;
  let bob: User;
  let appId = "";

  const user = async (username: string, adminIfFirst = false) => {
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
      adminIfFirst,
    });
    if (!made.ok) throw new Error(made.error);
    return made.value;
  };
  const ids = (viewer: User | undefined) =>
    listSources(app.db, dataDir, viewer).map((s) => s.id);

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-data-browser-"));
    app = createApp({ dataDir, port: 0, host: "forge.test" });
    admin = await user("owner1", true);
    alice = await user("alice");
    bob = await user("bob");
    const repo = await createRepo(app.db, app.reposRoot, {
      ownerId: alice.id,
      name: "notes",
      visibility: "public",
    });
    if (!repo.ok) throw new Error(repo.error);
    const made = createAppRecord(app.db, {
      repoId: repo.value.id,
      slug: "notes",
      access: "public",
    });
    if (!made.ok) throw new Error(made.error);
    appId = made.value.id;
    for (const env of ["production", "pull-3"] as const) {
      mkdirSync(envDataDir(dataDir, appId, env), { recursive: true });
      const d = new Database(join(envDataDir(dataDir, appId, env), "app.db"));
      d.exec("PRAGMA journal_mode = WAL");
      d.exec(
        "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, api_token TEXT, password_hash TEXT)",
      );
      d.exec("CREATE VIEW people AS SELECT name, api_token AS harmless FROM users");
      d.exec("CREATE VIEW allusers AS SELECT * FROM users");
      d.exec("CREATE VIEW renamed(a, b, c, d) AS SELECT * FROM users");
      d.exec("CREATE VIEW deeper AS SELECT c FROM renamed");
      d.exec("CREATE VIEW names AS SELECT id, name FROM users");
      d.exec(
        `INSERT INTO users VALUES (1, 'ann', 'tok-ann-1', 'hash-1'), (2, 'ben', 'tok-ben-2', NULL)`,
      );
      d.close();
    }
  });

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a writer sees their app's production and preview databases", () => {
    expect(ids(alice)).toEqual([
      `app:${appId}:production:app.db`,
      `app:${appId}:pull-3:app.db`,
    ]);
  });

  test("a reader of the app can't find its data", () => {
    expect(ids(bob)).toEqual([]);
    expect(ids(undefined)).toEqual([]);
    expect(
      findSource(app.db, dataDir, bob, `app:${appId}:production:app.db`),
    ).toBeUndefined();
  });

  test("only an admin sees forge.db", () => {
    expect(ids(admin)).toContain("forge");
    expect(ids(alice)).not.toContain("forge");
    expect(findSource(app.db, dataDir, alice, "forge")).toBeUndefined();
  });

  test("tables with counts, rows with filter, order and page", () => {
    const src = findSource(app.db, dataDir, alice, `app:${appId}:production:app.db`)!;
    expect(tables(src)).toEqual([{ name: "users", rows: 2 }]);
    const r = rows(src, "users", { filter: { text: "b" }, order: { column: "id", dir: "desc" } })!;
    expect(r.total).toBe(1);
    expect(r.rows[0]![1]).toBe("ben");
    expect(rows(src, "nope")).toBeUndefined();
    expect(rows(src, "users", { order: { column: "id; DROP TABLE users" } })).toBeUndefined();
  });

  test("a token column is masked, and cannot be searched or ordered", () => {
    const src = findSource(app.db, dataDir, alice, `app:${appId}:production:app.db`)!;
    const r = rows(src, "users")!;
    expect(JSON.stringify(r)).not.toContain("tok-ann");
    expect(JSON.stringify(r)).not.toContain("hash-1");
    expect(r.rows[1]![3]).toBeNull();
    expect(rows(src, "users", { filter: { text: "tok-ann", column: "api_token" } })!.total).toBe(0);
    expect(rows(src, "users", { order: { column: "api_token" } })).toBeUndefined();
  });

  test("a query cannot read a secret by alias or subquery either", async () => {
    const src = findSource(app.db, dataDir, alice, `app:${appId}:production:app.db`)!;
    for (const sql of [
      "SELECT api_token AS t FROM users",
      "SELECT (SELECT api_token FROM users LIMIT 1) AS t",
      "SELECT * FROM users",
    ]) {
      const r = await query(src, sql);
      expect(r.ok).toBe(true);
      expect(JSON.stringify(r)).not.toContain("tok-ann");
    }
    const bypass = await query(src, "SELECT api_token FROM main.users");
    expect(bypass.ok).toBe(false);
    const plain = await query(src, "SELECT name FROM users ORDER BY id");
    expect(plain.ok && plain.rows).toEqual([["ann"], ["ben"]]);
  });

  test("INSERT and PRAGMA writable_schema are refused", async () => {
    const src = findSource(app.db, dataDir, alice, `app:${appId}:production:app.db`)!;
    for (const sql of [
      "INSERT INTO users (name) VALUES ('x')",
      "PRAGMA writable_schema = 1",
      "SELECT 1; DELETE FROM users",
      "WITH x AS (SELECT 1) DELETE FROM users",
      "-- hi\nUPDATE users SET name = 'x'",
    ]) {
      const r = await query(src, sql);
      expect(r.ok).toBe(false);
    }
    expect(rows(src, "users")!.total).toBe(2);
  });

  test("a result stops at 1,000 rows", async () => {
    const src = findSource(app.db, dataDir, alice, `app:${appId}:production:app.db`)!;
    const r = await query(
      src,
      "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < 5000) SELECT i FROM n",
    );
    expect(r.ok && r.rows.length).toBe(1000);
    expect(r.ok && r.truncated).toBe(true);
  });

  test("a slow query stops at the cap", async () => {
    const src = findSource(app.db, dataDir, alice, `app:${appId}:production:app.db`)!;
    const started = performance.now();
    const r = await query(
      src,
      "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n) SELECT count(*) FROM n",
      400,
    );
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toBe("timeout");
    expect(performance.now() - started).toBeLessThan(3000);
  });

  test("reading never blocks the app's own writes", () => {
    const src = findSource(app.db, dataDir, alice, `app:${appId}:production:app.db`)!;
    const w = new Database(src.path);
    tables(src);
    w.exec("INSERT INTO users (name) VALUES ('cy')");
    w.close();
    expect(rows(src, "users")!.total).toBe(3);
  });

  const prod = () => findSource(app.db, dataDir, alice, `app:${appId}:production:app.db`)!;

  test("a schema qualifier in any quoting is refused", async () => {
    for (const from of [
      '"main"."users"',
      "[main].[users]",
      "`main`.`users`",
      'main /**/ .users',
      '"MAIN" . users',
      "main\n.users",
    ]) {
      const r = await query(prod(), `SELECT api_token FROM ${from}`);
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r)).not.toContain("tok-ann");
    }
  });

  test("a view that aliases a secret is masked, in rows and in queries", async () => {
    const src = prod();
    expect(JSON.stringify(rows(src, "people") ?? "")).not.toContain("tok-ann");
    const r = await query(src, "SELECT harmless FROM people");
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r)).not.toContain("tok-ann");
    expect(JSON.stringify(r)).toContain("••••");
  });

  test("a view by star, by a column list, or over such a view is masked whole", async () => {
    const src = prod();
    for (const [view, col] of [["allusers", "api_token"], ["renamed", "c"], ["deeper", "c"]] as const) {
      expect(JSON.stringify(rows(src, view) ?? "")).not.toContain("tok-ann");
      for (const sql of [`SELECT * FROM ${view}`, `SELECT ${col} AS x FROM ${view}`]) {
        const r = await query(src, sql);
        expect(r.ok).toBe(true);
        expect(JSON.stringify(r)).not.toContain("tok-ann");
        expect(JSON.stringify(r)).toContain("••••");
      }
    }
    // A view that names no secret and uses no star stays in clear.
    const clear = await query(src, "SELECT name FROM names");
    expect(JSON.stringify(clear)).toContain("ann");
  });

  test("an allowlisted column is shown in clear, and only for its source", () => {
    const src = prod();
    ALLOW[src.id] = ["users.api_token"];
    try {
      expect(JSON.stringify(rows(src, "users"))).toContain("tok-ann-1");
      expect(JSON.stringify(rows(src, "users"))).not.toContain("hash-1");
      const other = findSource(app.db, dataDir, alice, `app:${appId}:pull-3:app.db`)!;
      expect(JSON.stringify(rows(other, "users"))).not.toContain("tok-ann");
    } finally {
      delete ALLOW[src.id];
    }
  });

  test("a filter on a column that does not exist finds nothing", () => {
    expect(rows(prod(), "users", { filter: { text: "a", column: "nope" } })).toBeUndefined();
  });

  test("a guest or a non-writer cannot find forge", () => {
    for (const who of [undefined, alice, bob]) expect(findSource(app.db, dataDir, who, "forge")).toBeUndefined();
  });

  test("a page that is not a finite number is the first page; a huge one is capped", () => {
    const src = prod();
    for (const page of [Number.NaN, Number.POSITIVE_INFINITY, -4])
      expect(rows(src, "users", { page })!.page).toBe(0);
    expect(rows(src, "users", { page: 1e12 })!.page).toBe(1000);
  });

  test("forge.db is masked for an admin, setting values included", async () => {
    app.db.exec("INSERT OR REPLACE INTO forge_setting (key, value, updated_by, updated_at) VALUES ('smtp', 'SETTING-SECRET', 'x', 'now')");
    const src = findSource(app.db, dataDir, admin, "forge")!;
    expect(JSON.stringify(rows(src, "forge_setting"))).not.toContain("SETTING-SECRET");
    const r = await query(src, "SELECT value FROM forge_setting");
    expect(JSON.stringify(r)).not.toContain("SETTING-SECRET");
    const users = JSON.stringify(rows(src, "user"));
    expect(users).not.toContain("$argon2");
  });

  test("every forge.db column that could hold a secret is masked or audited as clear", () => {
    const src = findSource(app.db, dataDir, admin, "forge")!;
    const plan = maskPlan(new Database(src.path, { readonly: true }), "forge");
    const loose = /value|body|payload|code|key|blob|nonce|verifier|secret|token|hash|salt|enc|jwk|evidence|said|detail/i;
    const open: string[] = [];
    for (const [table, masked] of plan) {
      const db = new Database(src.path, { readonly: true });
      for (const c of db.query<{ name: string }, []>(`PRAGMA table_info("${table}")`).all())
        if (loose.test(c.name) && !masked.has(c.name)) open.push(`${table}.${c.name}`);
      db.close();
    }
    // Reviewed: these hold public or operational text, never a credential.
    // A new column that matches and is not here fails until someone looks.
    expect(open.sort()).toEqual(AUDITED_CLEAR);
  });
});
