/**
 * The database's size (#12010): the walk of the file sizes every b-tree as
 * SQLite's own `dbstat` would (each page counted once, overflow included),
 * names the largest tables and indexes in order with their rows, the daily
 * readings give growth a day, and the vitals say a file past Bun's 2 GiB
 * map or growing faster than 64 MiB a day. /system and the MCP `system`
 * tool (`kind: "size"`) show it to whoever reads the machine.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser, type User } from "../src/core/users.ts";
import type { Ctx } from "../src/http/context.ts";
import { vitals } from "../src/kernel/vitals.ts";
import { tool as systemTool } from "../src/http/mcp/tools/system.ts";
import { dbSizeSection } from "../src/web/pages/system.ts";
import {
  DB_FILE_CAP,
  DB_GROWTH_MAX,
  KEEP_DAYS,
  dbGrowth,
  dbSizeCache,
  dbSizeNeed,
  measureDbWalk,
  noteDbSize,
  overflowPages,
  rootsOf,
  walkFile,
  type DbSize,
} from "../src/system/db_size.ts";

const DAY = 86_400_000;

describe("overflowPages, by hand (fileformat2 §1.6)", () => {
  test("a payload that fits on the page spills nothing", () => {
    // Table leaf, 4096 usable: X = 4096 - 35 = 4061.
    expect(overflowPages(4061, 4096, true)).toBe(0);
    // Index: X = floor(4084·64/255) - 23 = 1025 - 23 = 1002.
    expect(overflowPages(1002, 4096, false)).toBe(0);
  });

  test("20,005 bytes in a table leaf of 4096 usable spill into 4 pages", () => {
    // M = floor(4084·32/255) - 23 = 489; K = 489 + (19516 mod 4092) = 489 + 3148 = 3637 ≤ 4061,
    // so 3637 stay and 16,368 = 4 × 4092 spill.
    expect(overflowPages(20_005, 4096, true)).toBe(4);
    // One byte past X: K = 489 + (3573 mod 4092) = 4062 > 4061, so only M = 489 stay
    // and 3573 spill into 1.
    expect(overflowPages(4062, 4096, true)).toBe(1);
  });
});

describe("the walk of a seeded database", () => {
  let dir: string;
  let db: Database;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "forge-db-size-"));
    db = new Database(join(dir, "forge.db"));
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(`
      CREATE TABLE big (id INTEGER PRIMARY KEY, body TEXT);
      CREATE INDEX big_body ON big (body);
      CREATE TABLE small (a);
      CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID;
      CREATE TABLE empty (a);
    `);
    const big = db.prepare("INSERT INTO big (body) VALUES (?)");
    const kv = db.prepare("INSERT INTO kv (k, v) VALUES (?, ?)");
    db.transaction(() => {
      // Every seventh body is 20 KB: overflow pages the walk must count.
      for (let i = 0; i < 3000; i++) big.run(`${"x".repeat(i % 7 === 0 ? 20_000 : 300)}${i}`);
      for (let i = 0; i < 50; i++) db.run("INSERT INTO small VALUES (?)", [i]);
      for (let i = 0; i < 5000; i++) kv.run(`k${i}`, "v".repeat(100));
    })();
    // Freed pages go to the freelist; they must not count toward any table.
    db.run("DELETE FROM big WHERE id % 5 = 0");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  });

  afterAll(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("every page is one b-tree's or free, and rows are the tables' rows", async () => {
    const r = await walkFile(join(dir, "forge.db"), rootsOf(db));
    const pageCount = db.query<{ page_count: number }, []>("PRAGMA page_count").get()!.page_count;
    const freelist = db.query<{ freelist_count: number }, []>("PRAGMA freelist_count").get()!.freelist_count;
    expect(r.freePages).toBe(freelist);
    expect(freelist).toBeGreaterThan(0);
    expect(r.trees.reduce((n, t) => n + t.pages, 0) + r.freePages).toBe(pageCount);
    const rows = (name: string) => r.trees.find((t) => t.name === name)!.rows;
    expect(rows("big")).toBe(2400);
    expect(rows("small")).toBe(50);
    expect(rows("kv")).toBe(5000);
    expect(rows("empty")).toBe(0);
    expect(rows("big_body")).toBe(2400);
  });

  test("the largest come first, tables and indexes apart, with rows and their table", async () => {
    const w = await measureDbWalk(db, dir, () => Date.parse("2026-11-13T12:00:00Z"));
    expect(w.at).toBe("2026-11-13T12:00:00.000Z");
    expect(w.pageSize).toBe(4096);
    expect(w.tables.map((t) => t.name)).toEqual(["big", "kv", "empty", "small", "sqlite_schema"]);
    expect(w.tables[0]!.rows).toBe(2400);
    // Each body of 20 KB keeps at most 4061 bytes on its leaf and spills 4 overflow pages
    // (by hand above).
    const long = db.query<{ n: number }, []>("SELECT count(*) AS n FROM big WHERE length(body) > 20000").get()!.n;
    expect(long).toBe(343);
    expect(w.tables[0]!.bytes).toBeGreaterThan(long * 4 * 4096);
    // A WITHOUT ROWID table's key is the table itself: no index beside it.
    expect(w.indexes.map((i) => [i.name, i.table])).toEqual([["big_body", "big"]]);
    expect(w.freeBytes).toBeGreaterThan(0);
  });

  test("ten of each at most", async () => {
    for (let i = 0; i < 12; i++) db.exec(`CREATE TABLE t${i} (a); CREATE INDEX t${i}_a ON t${i} (a)`);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const w = await measureDbWalk(db, dir);
    expect(w.tables).toHaveLength(10);
    expect(w.indexes).toHaveLength(10);
    expect(w.tables[0]!.name).toBe("big");
  });

  test("a file that is not a database is refused, not guessed at", async () => {
    await Bun.write(join(dir, "not.db"), "hello, this is not SQLite".repeat(10));
    await expect(walkFile(join(dir, "not.db"), [])).rejects.toThrow("not a SQLite database");
  });
});

describe("growth and the need", () => {
  let dataDir: string;
  let app: App;
  const roomy = () => ({ freeBytes: 95, totalBytes: 100 });

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), "forge-db-growth-"));
    app = createApp({ dataDir, port: 0, disk: roomy });
  });

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("one reading a UTC day, the first kept, 60 days kept", () => {
    const t0 = Date.parse("2026-09-01T08:00:00Z");
    noteDbSize(app.db, dataDir, t0);
    noteDbSize(app.db, dataDir, t0 + 3_600_000);
    const rows = () => app.db.query<{ day: string; at: string }, []>("SELECT day, at FROM db_size_day ORDER BY day").all();
    expect(rows()).toEqual([{ day: "2026-09-01", at: "2026-09-01T08:00:00.000Z" }]);
    noteDbSize(app.db, dataDir, t0 + (KEEP_DAYS + 1) * DAY);
    expect(rows().map((r) => r.day)).toEqual(["2026-11-01"]);
    app.db.run("DELETE FROM db_size_day");
  });

  test("growth a day is the file now against the oldest reading of the last week", () => {
    const now = Date.parse("2026-11-13T12:00:00Z");
    const put = app.db.prepare("INSERT INTO db_size_day (day, at, bytes) VALUES (?, ?, ?)");
    // Ten days ago is outside the week; four days ago is the oldest inside it.
    put.run("2026-11-03", "2026-11-03T12:00:00.000Z", 1_000);
    put.run("2026-11-09", "2026-11-09T12:00:00.000Z", 100_000_000);
    put.run("2026-11-12", "2026-11-12T12:00:00.000Z", 200_000_000);
    const g = dbGrowth(app.db, 500_000_000, now);
    // (500,000,000 - 100,000,000) / 4 days.
    expect(g.perDay).toBe(100_000_000);
    expect(g.days).toBe(4);
    expect(g.readings.map((r) => r.day)).toEqual(["2026-11-03", "2026-11-09", "2026-11-12"]);
    // Eight hours after the oldest reading, under 20 hours, says nothing yet.
    expect(dbGrowth(app.db, 1, Date.parse("2026-11-03T20:00:00Z"))).toMatchObject({ perDay: null, days: 0 });
  });

  test("the need fires past the 2 GiB map or 64 MiB a day, the size first", () => {
    expect(DB_FILE_CAP).toBe(2 * 1024 ** 3 - 64 * 1024);
    expect(dbSizeNeed(DB_FILE_CAP, { perDay: DB_GROWTH_MAX, days: 7 })).toBeUndefined();
    expect(dbSizeNeed(DB_FILE_CAP + 1, { perDay: null, days: 0 })?.cause).toBe("db-size");
    expect(dbSizeNeed(4.5 * 1024 ** 3, { perDay: 10 * DB_GROWTH_MAX, days: 7 })).toEqual({
      cause: "db-size",
      sentence: "The database is 4.5 GiB, past the 2 GiB Bun maps; /system names its largest tables.",
    });
    expect(dbSizeNeed(1024 ** 3, { perDay: DB_GROWTH_MAX + 1, days: 3.5 })).toEqual({
      cause: "db-growth",
      sentence: "The database grows 64 MiB a day over 3.5 days, past the 64 MiB a day worth a look; /system names its largest tables.",
    });
  });

  const MiB = 1024 ** 2;
  const GiB = 1024 ** 3;
  const fixedWalk = {
    at: "2026-11-13T13:00:41.000Z",
    pageSize: 4096,
    freeBytes: 0.4 * GiB,
    tables: [
      { name: "run_log", bytes: 2.1 * GiB, rows: 3_200_000 },
      { name: "event", bytes: 812 * MiB, rows: 41_300 },
      { name: "check_run", bytes: 300 * MiB, rows: 9_000 },
      { name: "comment", bytes: 120 * MiB, rows: 812 },
      { name: "issue", bytes: 40 * MiB, rows: 12_000 },
      { name: "user", bytes: 1 * MiB, rows: 30 },
    ],
    indexes: [],
  };

  test("with a walk, the need names the five largest tables, their bytes and rows, and the freelist (#12051)", () => {
    expect(dbSizeNeed(4.6 * GiB, { perDay: null, days: 0 }, fixedWalk)).toEqual({
      cause: "db-size",
      sentence:
        "The database is 4.6 GiB, past the 2 GiB Bun maps: as of 13:00Z its largest tables are run_log 2.1 GiB (3.2M rows), event 812 MiB (41k rows), check_run 300 MiB (9k rows), comment 120 MiB (812 rows), issue 40 MiB (12k rows); 410 MiB free.",
    });
    expect(dbSizeNeed(GiB, { perDay: DB_GROWTH_MAX + 1, days: 3.5 }, fixedWalk)?.sentence).toBe(
      "The database grows 64 MiB a day over 3.5 days, past the 64 MiB a day worth a look: as of 13:00Z its largest tables are run_log 2.1 GiB (3.2M rows), event 812 MiB (41k rows), check_run 300 MiB (9k rows), comment 120 MiB (812 rows), issue 40 MiB (12k rows); 410 MiB free.",
    );
    // Quiet stays quiet, walk or no walk.
    expect(dbSizeNeed(GiB, { perDay: null, days: 0 }, fixedWalk)).toBeUndefined();
  });

  test("without a walk, the need keeps pointing at /system", () => {
    for (const w of [null, { ...fixedWalk, tables: [] }])
      expect(dbSizeNeed(4.6 * GiB, { perDay: null, days: 0 }, w)?.sentence).toBe(
        "The database is 4.6 GiB, past the 2 GiB Bun maps; /system names its largest tables.",
      );
  });

  test("the vitals' db need carries the walk, the sentence the Sentinel issue quotes", () => {
    const now = Date.now();
    let asked = 0;
    const dbWalk = () => {
      asked++;
      return fixedWalk;
    };
    const cause = () => vitals({ db: app.db, signals: app.signals, dataDir, disk: roomy, now, dbWalk }).degraded.find((d) => d.cause.startsWith("db-"));
    app.db.run("DELETE FROM db_size_day");
    expect(cause()).toBeUndefined();
    // No need, no walk asked for.
    expect(asked).toBe(0);
    const then = now - 2 * DAY;
    app.db.query("INSERT INTO db_size_day (day, at, bytes) VALUES (?, ?, ?)").run(new Date(then).toISOString().slice(0, 10), new Date(then).toISOString(), -300 * 1024 ** 2);
    expect(cause()?.sentence).toContain(": as of 13:00Z its largest tables are run_log 2.1 GiB (3.2M rows)");
    expect(asked).toBe(1);
    app.db.run("DELETE FROM db_size_day");
  });

  test("the vitals carry the growth need to /system, and drop it when growth is quiet", () => {
    const now = Date.now();
    const cause = () => vitals({ db: app.db, signals: app.signals, dataDir, disk: roomy, now }).degraded.find((d) => d.cause.startsWith("db-"));
    app.db.run("DELETE FROM db_size_day");
    expect(cause()).toBeUndefined();
    // A reading two days ago, 300 MiB smaller than nothing: the file "grew" past 64 MiB a day.
    const then = now - 2 * DAY;
    app.db.query("INSERT INTO db_size_day (day, at, bytes) VALUES (?, ?, ?)").run(new Date(then).toISOString().slice(0, 10), new Date(then).toISOString(), -300 * 1024 ** 2);
    const said = cause();
    expect(said?.cause).toBe("db-growth");
    expect(said?.href).toBe("/system");
    app.db.run("DELETE FROM db_size_day");
    expect(cause()).toBeUndefined();
  });

  test("the cache never waits on a peek, and shares one walk", async () => {
    let walks = 0;
    let finish: () => void = () => {};
    const cache = dbSizeCache(async (db, d) => {
      walks++;
      await new Promise<void>((r) => (finish = r));
      return measureDbWalk(db, d);
    });
    const first = cache.peek(app.db, dataDir);
    expect(first.walk).toBeNull();
    expect(first.fileBytes).toBeGreaterThan(0);
    expect(cache.peek(app.db, dataDir).walk).toBeNull();
    expect(walks).toBe(1);
    finish();
    const read = await cache.read(app.db, dataDir, 5_000);
    expect(walks).toBe(1);
    expect(read.walk?.tables.length).toBe(10);
    expect(cache.peek(app.db, dataDir).walk).toBe(read.walk);
  });

  test("last gives the cached walk without waiting, and starts the first one", async () => {
    let walks = 0;
    let finish = (): void => {};
    const cache = dbSizeCache(async (db, d) => {
      walks++;
      await new Promise<void>((r) => (finish = r));
      return measureDbWalk(db, d);
    });
    expect(cache.last(app.db, dataDir)).toBeNull();
    expect(walks).toBe(1);
    finish();
    const read = await cache.read(app.db, dataDir, 5_000);
    expect(cache.last(app.db, dataDir)).toBe(read.walk);
    expect(walks).toBe(1);
  });

  test("a walk that fails is said in the log, not swallowed, and the page keeps no walk", async () => {
    const said: { message: string; fields: Record<string, unknown> | undefined }[] = [];
    const log = { warn: (message: string, fields?: Record<string, unknown>) => void said.push({ message, fields }) };
    const cache = dbSizeCache(async () => {
      throw new Error("not a SQLite database");
    });
    const read = await cache.read(app.db, dataDir, 5_000, log);
    expect(read.walk).toBeNull();
    expect(said).toEqual([{ message: "database size walk failed", fields: { dataDir, error: "not a SQLite database" } }]);
  });

  test("the MCP system tool answers kind size to an admin and refuses a member", async () => {
    const make = async (username: string, isAdmin: boolean) => {
      const r = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase", isAdmin });
      if (!r.ok) throw new Error(r.error);
      return r.value;
    };
    const admin = await make("size-keeper", true);
    const member = await make("size-reader", false);
    const ctxOf = (user: User): Ctx => ({
      app,
      request: new Request("http://localhost/mcp", { method: "POST" }),
      url: new URL("http://localhost/mcp"),
      params: {},
      auth: { user, scope: "rw", via: "token" },
      theme: undefined,
    });
    const read = (await systemTool.run(ctxOf(admin), admin, { kind: "size" })) as { ok: boolean; value: DbSize };
    expect(read.ok).toBe(true);
    const body = read.value;
    expect(body.fileBytes).toBeGreaterThan(0);
    expect(body.growth.readings).toEqual([]);
    expect(body.walk === null || body.walk.tables.length === 10).toBe(true);
    expect(JSON.stringify(await systemTool.run(ctxOf(member), member, { kind: "size" }))).toContain("forbidden");
  });
});

describe("/system's Database size", () => {
  const size: DbSize = {
    fileBytes: 3 * 1024 ** 3,
    walBytes: 4 * 1024 ** 2,
    growth: { perDay: 10 * 1024 ** 2, days: 7, readings: [] },
    walk: {
      at: "2026-11-13T12:00:00.000Z",
      pageSize: 4096,
      freeBytes: 30 * 1024 ** 2,
      tables: [
        { name: "event", bytes: 2 * 1024 ** 3, rows: 1_234_567 },
        { name: "<run>", bytes: 1024 ** 2, rows: 3 },
      ],
      indexes: [{ name: "event_at", table: "event", bytes: 512 * 1024 ** 2 }],
    },
  };

  test("one table, tables then indexes in the order given, escaped, with the file and its growth", () => {
    const out = String(dbSizeSection(size));
    expect(out).toContain("<h2>Database size</h2>");
    expect(out.match(/<table/g)).toHaveLength(1);
    expect(out.indexOf('data-table="event"')).toBeLessThan(out.indexOf('data-table="&lt;run&gt;"'));
    expect(out.indexOf('data-table="&lt;run&gt;"')).toBeLessThan(out.indexOf('data-index="event_at"'));
    expect(out).not.toContain("<run>");
    expect(out).toContain("1,234,567");
    expect(out).toContain("forge.db is 3.0 GiB; grows 10 MiB a day over 7 days");
    expect(out).toContain("past 2.0 GiB");
  });

  test("the facts are dl rows, not pills, and an index row has no filler cell", () => {
    const out = String(dbSizeSection(size));
    expect(out).toContain('<dl class="status-rows" id="sys-db-summary"');
    for (const [dt, dd] of [["File", "3.0 GiB"], ["WAL", "4.0 MiB"], ["Free inside", "30 MiB"], ["Growth", "grows 10 MiB a day over 7 days"]])
      expect(out).toContain(`<dt>${dt}</dt><dd>${dd}</dd>`);
    expect(out).not.toContain('class="pill');
    expect(out).not.toContain("—");
    const index = out.slice(out.indexOf('data-index="event_at"'), out.indexOf("</tr>", out.indexOf('data-index="event_at"')));
    expect(index.match(/<td/g)).toHaveLength(2);
    expect(index).toContain('colspan="2"');
  });

  test("while the first walk runs it says so, and growth waits for a day of readings", () => {
    const out = String(dbSizeSection({ ...size, fileBytes: 1024, walk: null, growth: { perDay: null, days: 0, readings: [] } }));
    expect(out).toContain("being measured");
    expect(out).toContain("growth needs a day of readings");
    expect(out).not.toContain("<table");
    expect(out).not.toContain("past ");
  });
});
