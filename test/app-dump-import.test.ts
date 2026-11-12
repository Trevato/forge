/** A dump in, loaded and proved per table on both sides (#11697). */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createApp, type App } from "../src/app.ts";
import { importAppData } from "../src/actions/migrate.ts";
import { envDataDir } from "../src/apps/data.ts";
import { compareTables, firstRefused, importDump, insertedRows, splitSql } from "../src/apps/dump_import.ts";
import { createApp as createAppRecord } from "../src/core/apps.ts";
import { createRepo, getRepoById, type Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve } from "../src/http/server.ts";
import { createToken } from "../src/core/tokens.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const DUMP = `-- a dump; with; semicolons in comments
BEGIN TRANSACTION;
CREATE TABLE orders (id INTEGER PRIMARY KEY, who TEXT, total REAL, note BLOB);
INSERT INTO orders VALUES (1,'ann; "the first"',9.5,NULL);
INSERT INTO orders VALUES (2,'it''s /* not a comment */',12,X'00ff');
CREATE TABLE empty_t (a TEXT);
CREATE UNIQUE INDEX orders_who ON orders(who);
COMMIT;`;

describe("splitting and vetting", () => {
  test("quotes and comments hide semicolons", () => {
    expect(splitSql(DUMP)).toHaveLength(7);
    expect(splitSql("INSERT INTO t VALUES ('a;b'); /* ; */ ")).toEqual(["INSERT INTO t VALUES ('a;b')"]);
  });
  test("only the allowed kinds pass, and the refusal names its statement", () => {
    expect(firstRefused(splitSql(DUMP))).toBeUndefined();
    expect(firstRefused(splitSql("CREATE TABLE t(a); ATTACH DATABASE '/x' AS y"))).toEqual({ statement: 2, kind: "ATTACH DATABASE" });
    expect(firstRefused(splitSql("PRAGMA writable_schema=1"))?.statement).toBe(1);
    expect(firstRefused(splitSql("DROP TABLE t"))?.statement).toBe(1);
  });
});

describe("what a dump may do (#11697 review)", () => {
  const refused = (sql: string) => firstRefused(splitSql(sql));
  test("a recursive CTE, INSERT ... SELECT and CREATE TABLE AS are refused", () => {
    expect(refused("CREATE TABLE t(x); INSERT INTO t WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT x FROM c")?.statement).toBe(2);
    expect(refused("INSERT INTO t SELECT randomblob(1000000000)")?.statement).toBe(1);
    expect(refused("INSERT INTO t VALUES ((SELECT 1))")?.statement).toBe(1);
    expect(refused("INSERT INTO t VALUES (randomblob(1000000000))")?.statement).toBe(1);
    expect(refused("INSERT INTO t VALUES (1); INSERT INTO t VALUES (zeroblob(5))")?.statement).toBe(2);
    expect(refused("CREATE TABLE x AS SELECT 1")?.statement).toBe(1);
    expect(refused("CREATE TABLE x AS VALUES (1)")?.statement).toBe(1);
    expect(refused("CREATE TABLE x (a TEXT DEFAULT (hex(randomblob(500000000))))")?.statement).toBe(1);
    expect(refused("CREATE INDEX i ON t(a) WHERE a IN (SELECT 1)")?.statement).toBe(1);
  });
  test("plain dumps still pass, quoted words and column names that look like functions included", () => {
    expect(refused(`CREATE TABLE "t" (format TEXT, "select" TEXT, price DECIMAL(10,2) DEFAULT (datetime('now')));
      INSERT INTO "t" VALUES('select * from x; replace(1)', 'with', 1.5e3), ('b', NULL, -2);
      INSERT INTO "t"(format) VALUES (X'00ff'), (TRUE);`)).toBeUndefined();
  });
  test("an unbounded or mixed VALUES list is refused", () => {
    expect(refused("INSERT INTO t VALUES (1) (2)")?.statement).toBe(1);
    expect(refused("INSERT INTO t VALUES (1), (2) ON CONFLICT DO NOTHING")?.statement).toBe(1);
    expect(refused("INSERT INTO t VALUES (1); DELETE FROM t")?.statement).toBe(2);
  });
  test("a recursive CTE loaded through importDump writes nothing", () => {
    const dir = join(tmpdir(), `forge-dump-cte-${process.pid}`);
    const done = importDump(dir, "x.db", "CREATE TABLE t(x INT); INSERT INTO t WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT x FROM c", false);
    expect(done).toMatchObject({ ok: false, error: { error: "refused", statement: 2 } });
    expect(existsSync(join(dir, "x.db"))).toBe(false);
  });
  test("rows are counted from the dump's text, per table, apart from SQLite", () => {
    const counts = insertedRows(splitSql(`CREATE TABLE a(x); INSERT INTO a VALUES (1),(2),('3);(4)'); INSERT INTO "A" VALUES (9); INSERT INTO b(x) VALUES (1)`));
    expect([...counts]).toEqual([["a", 4], ["b", 1]]);
  });
  test("mismatch: a store that lost or gained a row, or changed one, is not accepted and nothing is put in place", () => {
    const fp = (rows: number, sha: string) => ({ table: "t", rows, sha256: sha });
    const counted = new Map([["t", 3]]);
    expect(compareTables([fp(3, "a")], [fp(3, "a")], counted)[0]!.match).toBe(true);
    expect(compareTables([fp(3, "a")], [fp(3, "b")], counted)[0]!.match).toBe(false);
    expect(compareTables([fp(3, "a")], [fp(2, "a")], counted)[0]!.match).toBe(false);
    // both loads agree with each other but not with the dump's own text
    expect(compareTables([fp(2, "a")], [fp(2, "a")], counted)[0]!.match).toBe(false);
    expect(compareTables([fp(3, "a")], [], counted)[0]!.match).toBe(false);
    const dir = join(tmpdir(), `forge-dump-mm-${process.pid}`);
    const done = importDump(dir, "m.db", "CREATE TABLE t(a); INSERT INTO t VALUES (1),(2);", false, (store) => store.exec("INSERT INTO t VALUES (3)"));
    expect(done).toMatchObject({ ok: false, error: { error: "mismatch", tables: [{ table: "t", rows: 2, inserted: 2, match: false, store: { rows: 3 } }] } });
    expect(existsSync(join(dir, "m.db"))).toBe(false);
    expect(existsSync(join(dir, "m.db.importing"))).toBe(false);
    const kept = join(dir, "n.db");
    mkdirSync(dir, { recursive: true });
    writeFileSync(kept, "old");
    importDump(dir, "n.db", "CREATE TABLE t(a); INSERT INTO t VALUES (1);", true, (store) => store.exec("DELETE FROM t"));
    expect(Bun.file(kept).size).toBe(3);
  });
  test("a dump of more statements than the ceiling is refused before it runs", () => {
    const dir = join(tmpdir(), `forge-dump-big-${process.pid}`);
    const sql = "BEGIN;" + ";".repeat(0) + "INSERT INTO t VALUES (1);".repeat(1_000_001);
    expect(importDump(dir, "b.db", sql, false)).toMatchObject({ ok: false, error: { error: "too_large" } });
  });
});

describe("importAppData", () => {
  let dataDir: string;
  let app: App;
  let owner: User;
  let stranger: User;
  let repo: Repo;
  let bare: Repo;
  const mk = async (name: string, admin = false): Promise<User> => {
    const made = await createUser(app.db, { origin: "seed", trusted: true, username: name, email: `${name}@forge.local`, password: "a-good-passphrase", adminIfFirst: admin });
    if (!made.ok) throw new Error(made.error);
    return made.value;
  };
  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-dump-"));
    app = createApp({ dataDir, port: 0, host: "forge.test" });
    await mk("owner1", true);
    owner = await mk("alice");
    stranger = await mk("bob");
    const r = await createRepo(app.db, app.reposRoot, { ownerId: owner.id, name: "shop", visibility: "public" });
    if (!r.ok) throw new Error(r.error);
    repo = getRepoById(app.db, r.value.id)!;
    const rec = createAppRecord(app.db, { repoId: repo.id, slug: "shop", access: "public" });
    if (!rec.ok) throw new Error(rec.error);
    const b = await createRepo(app.db, app.reposRoot, { ownerId: owner.id, name: "plain", visibility: "public" });
    if (!b.ok) throw new Error(b.error);
    bare = b.value;
  });
  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const dirOf = () => envDataDir(dataDir, (app.db.query("SELECT id FROM app").get() as { id: string }).id, "production");

  test("loads, and the counts and checksums match a hand calculation", () => {
    const done = importAppData(app, owner, repo, { dump: DUMP });
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    const orders = done.value.tables.find((t) => t.table === "orders")!;
    expect(orders.rows).toBe(2);
    // rows in rowid order, each value as SQLite's quote() writes it, joined by US, ended by newline
    const by = createHash("sha256")
      .update("1\x1f'ann; \"the first\"'\x1f9.5\x1fNULL\n2\x1f'it''s /* not a comment */'\x1f12.0\x1fX'00FF'\n")
      .digest("hex");
    expect(orders.sha256).toBe(by);
    expect(orders.store).toEqual({ table: "orders", rows: 2, sha256: by });
    expect(orders.inserted).toBe(2);
    expect(orders.match).toBe(true);
    expect(done.value.tables.find((t) => t.table === "empty_t")?.rows).toBe(0);
    const stored = new Database(join(dirOf(), "app.db"), { readonly: true });
    expect(stored.query("SELECT count(*) AS n FROM orders").get()).toEqual({ n: 2 });
    stored.close();
  });

  test("an existing file is refused unless replace is said, then kept", () => {
    const again = importAppData(app, owner, repo, { dump: DUMP });
    expect(again).toEqual({ ok: false, error: { error: "exists", file: "app.db" } });
    const replaced = importAppData(app, owner, repo, { dump: "CREATE TABLE t(a); INSERT INTO t VALUES (1);", replace: true });
    const kept = replaced.ok ? replaced.value.kept : undefined;
    expect(kept).toMatch(/^app\.db\.before-import-\d+$/);
    expect(existsSync(join(dirOf(), kept!))).toBe(true);
    const d = new Database(join(dirOf(), "app.db"), { readonly: true });
    expect(d.query("SELECT name FROM sqlite_master").all()).toEqual([{ name: "t" }]);
    d.close();
  });

  test("a refused or broken dump changes nothing", () => {
    const before = Bun.file(join(dirOf(), "app.db")).size;
    expect(importAppData(app, owner, repo, { dump: "ATTACH DATABASE '/etc/x' AS y", replace: true })).toMatchObject({ error: { error: "refused", statement: 1 } });
    expect(importAppData(app, owner, repo, { dump: "CREATE TABLE u(a); INSERT INTO nope VALUES (1)", replace: true })).toMatchObject({ error: { error: "invalid", statement: 2 } });
    expect(importAppData(app, owner, repo, { dump: " -- nothing ", replace: true })).toMatchObject({ error: { error: "empty" } });
    expect(Bun.file(join(dirOf(), "app.db")).size).toBe(before);
    expect(existsSync(join(dirOf(), "app.db.importing"))).toBe(false);
  });

  test("a second replace keeps the first backup too", () => {
    const backups = () => readdirSync(dirOf()).filter((n) => n.startsWith("app.db.before-import"));
    const before = backups().length;
    const again = importAppData(app, owner, repo, { dump: "CREATE TABLE t2(a); INSERT INTO t2 VALUES (7);", replace: true });
    expect(again.ok).toBe(true);
    expect(backups().length).toBe(before + 1);
    // the same millisecond still gets its own name
    const dir = join(dataDir, "twice");
    const one = importDump(dir, "a.db", "CREATE TABLE t(a);", false, undefined, 5);
    const two = importDump(dir, "a.db", "CREATE TABLE u(a);", true, undefined, 5);
    const three = importDump(dir, "a.db", "CREATE TABLE v(a);", true, undefined, 5);
    expect([one.ok, two.ok && two.value.kept, three.ok && three.value.kept]).toEqual([true, "a.db.before-import-5", "a.db.before-import-5-1"]);
    const old = new Database(join(dir, "a.db.before-import-5"), { readonly: true });
    expect(old.query("SELECT name FROM sqlite_master").all()).toEqual([{ name: "t" }]);
    old.close();
  });

  test("who and where are checked at the boundary", () => {
    expect(importAppData(app, stranger, repo, { dump: DUMP, file: "x.db" })).toEqual({ ok: false, error: "not_found" });
    expect(importAppData(app, undefined, repo, { dump: DUMP })).toEqual({ ok: false, error: "unauthorized" });
    expect(importAppData(app, owner, bare, { dump: DUMP })).toEqual({ ok: false, error: "no_app" });
    expect(importAppData(app, owner, repo, { dump: DUMP, env: "../x" })).toEqual({ ok: false, error: "invalid_env" });
    expect(importAppData(app, owner, repo, { dump: DUMP, file: "../x.db" })).toEqual({ ok: false, error: "invalid_file" });
  });

  test("the API door: POST data-import, admin token, 404 for a stranger", async () => {
    const servers = await serve(app);
    try {
      const post = (who: User, payload: unknown) =>
        fetch(`${servers.url}/api/v1/repos/alice/shop/data-import`, {
          method: "POST",
          headers: { authorization: `Bearer ${createToken(app.db, who.id, "t", "admin").token}`, "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
      const ok = await post(owner, { dump: DUMP, replace: true, file: "api.db" });
      expect(ok.status).toBe(200);
      const report = (await ok.json()) as { tables: { table: string; rows: number; match: boolean }[] };
      expect(report.tables.map((t) => [t.table, t.rows, t.match])).toEqual([["empty_t", 0, true], ["orders", 2, true]]);
      expect((await post(owner, { dump: DUMP, file: "api.db" })).status).toBe(409);
      expect((await post(owner, { dump: "DROP TABLE t" })).status).toBe(422);
      expect((await post(stranger, { dump: DUMP })).status).toBe(404);
      // a recursive CTE is refused at the door, not run
      const cte = await post(owner, { dump: "CREATE TABLE t(x); INSERT INTO t WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT x FROM c", file: "cte.db" });
      expect(cte.status).toBe(422);
      expect(((await cte.json()) as { error: string }).error).toBe("refused");
      expect(existsSync(join(dirOf(), "cte.db"))).toBe(false);
      // a token that may only read cannot import, even for its own repository
      const ro = await fetch(`${servers.url}/api/v1/repos/alice/shop/data-import`, {
        method: "POST",
        headers: { authorization: `Bearer ${createToken(app.db, owner.id, "ro", "ro").token}`, "content-type": "application/json" },
        body: JSON.stringify({ dump: DUMP, file: "ro.db" }),
      });
      expect(ro.status).toBeGreaterThanOrEqual(400);
      expect(ro.status).toBeLessThan(500);
      expect(existsSync(join(dirOf(), "ro.db"))).toBe(false);
      // a body past 16 MB is stopped by the bytes read, with no length declared
      const chunk = new TextEncoder().encode("x".repeat(1024 * 1024));
      let sent = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(c) {
          if (sent++ < 18) c.enqueue(chunk);
          else c.close();
        },
      });
      const huge = await fetch(`${servers.url}/api/v1/repos/alice/shop/data-import`, {
        method: "POST",
        headers: { authorization: `Bearer ${createToken(app.db, owner.id, "t", "admin").token}`, "content-type": "application/json" },
        body: stream,
        duplex: "half",
      });
      expect(huge.status).toBe(413);
      expect(existsSync(join(dirOf(), "app.db.importing"))).toBe(false);
    } finally {
      servers.stop();
    }
  });
});
