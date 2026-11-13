/** Work a query may cause is bounded: cells are cut, the result has a byte cap, workers are few. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rows } from "../src/data/browse.ts";
import { CELL_CAP } from "../src/data/mask.ts";
import { query, QUERY_WORKERS, queriesRunning } from "../src/data/query.ts";
import type { Source } from "../src/data/sources.ts";

let dir: string;
let src: Source;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-data-limits-"));
  const path = join(dir, "x.db");
  const d = new Database(path);
  d.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, body TEXT)");
  d.query("INSERT INTO t (body) VALUES (?)").run("y".repeat(50_000));
  d.close();
  src = { id: "app:x:production:x.db", label: "x", kind: "app", path };
});
afterAll(() => rm(dir, { recursive: true, force: true }));

test("browsing a table cuts a long cell", () => {
  const cell = rows(src, "t")!.rows[0]![1] as string;
  expect(cell.length).toBe(CELL_CAP + 1);
  expect(cell.endsWith("…")).toBe(true);
});

test("a query cuts a long cell and shows a blob by its size", async () => {
  const r = await query(src, "SELECT body, zeroblob(100000) AS z FROM t");
  if (!r.ok) throw new Error(r.message);
  expect((r.rows[0]![0] as string).length).toBeLessThanOrEqual(CELL_CAP + 1);
  expect(r.rows[0]![1]).toBe("<blob 100000 bytes>");
});

test("a result stops at its byte cap", async () => {
  const r = await query(
    src,
    "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 900) SELECT i, (SELECT body FROM t) FROM n",
  );
  if (!r.ok) throw new Error(r.message);
  expect(r.truncated).toBe(true);
  expect(r.rows.length).toBeLessThan(900);
});

test("more queries than workers are told the forge is busy, and the slot frees", async () => {
  const slow = "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3000000) SELECT count(*) FROM n";
  const held = Array.from({ length: QUERY_WORKERS }, () => query(src, slow));
  expect(queriesRunning()).toBe(QUERY_WORKERS);
  const extra = await query(src, "SELECT 1");
  expect(extra.ok).toBe(false);
  if (!extra.ok) expect(extra.error).toBe("busy");
  await Promise.all(held);
  expect(queriesRunning()).toBe(0);
  expect((await query(src, "SELECT 1")).ok).toBe(true);
});

test("a query that would use huge memory is stopped, not served", async () => {
  const r = await query(
    src,
    "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 100) SELECT length(group_concat(hex(zeroblob(5000000)))) FROM n",
  );
  expect(r.ok).toBe(false);
}, 15_000);

test("a query never sets SQLite's heap limit: it is the whole process's, and the forge's own connections would fail with out of memory (2026-11-13)", async () => {
  expect((await query(src, "SELECT 1")).ok).toBe(true);
  // The limit a data query leaves behind is read from another connection: 0 is none.
  const probe = new Database(":memory:");
  expect(probe.query<{ hard_heap_limit: number }, []>("PRAGMA hard_heap_limit").get()?.hard_heap_limit).toBe(0);
  probe.close();
  // And nothing in src/ sets one or the soft one but the data query's own process (`query_child.ts` runs `query_worker.ts`).
  const { readdirSync, readFileSync } = await import("node:fs");
  const root = new URL("../src/", import.meta.url).pathname;
  const named: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name === "query_worker.ts") continue;
    const text = readFileSync(join(entry.parentPath, entry.name), "utf8");
    for (const line of text.split("\n"))
      if (/PRAGMA\s+(hard|soft)_heap_limit/i.test(line) && !line.trim().startsWith("//") && !line.trim().startsWith("*"))
        named.push(`${entry.name}: ${line.trim()}`);
  }
  expect(named).toEqual([]);
});

test("after a query that hits the heap limit, a connection of the forge's own still allocates (the 2026-11-13 failure)", async () => {
  const main = new Database(join(dir, "main.db"));
  main.exec("PRAGMA cache_size = -1048576");
  main.exec("CREATE TABLE m (a INTEGER PRIMARY KEY, b TEXT)");
  main.exec("WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 300000) INSERT INTO m SELECT x, hex(randomblob(500)) FROM c");
  main.query("SELECT sum(length(b)) FROM m WHERE a < 200000").get(); // the main connection holds more than the 128 MiB a data query may use
  const r = await query(
    src,
    "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 100) SELECT length(group_concat(hex(zeroblob(5000000)))) FROM n",
  );
  expect(r.ok).toBe(false);
  // New pages need new allocations: with a process-wide limit left behind, this throws "out of memory".
  expect(main.query<{ s: number }, []>("SELECT sum(length(b)) AS s FROM m WHERE a >= 200000").get()?.s).toBeGreaterThan(0);
  expect(() => main.query("INSERT INTO m (b) VALUES ('x')").run()).not.toThrow();
  main.close();
}, 60_000);
