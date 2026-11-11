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
