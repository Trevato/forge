/** The forge's own handle keeps a gigabyte of pages; the override sets it; a bare handle keeps the modest default. */
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPragmas, openDb } from "../src/kernel/db.ts";

const cacheOf = (db: Database) => db.query<{ cache_size: number }, []>("PRAGMA cache_size").get()!.cache_size;

test("openDb keeps 1 GiB, FORGE_DB_CACHE_MIB overrides it, a bare handle keeps 64 MiB", async () => {
  const dir = await mkdtemp(join(tmpdir(), "forge-cache-"));
  try {
    const a = openDb(join(dir, "a.db"), []);
    expect(cacheOf(a)).toBe(-1024 * 1024);
    a.close();
    process.env["FORGE_DB_CACHE_MIB"] = "256";
    const b = openDb(join(dir, "b.db"), []);
    expect(cacheOf(b)).toBe(-256 * 1024);
    b.close();
    const c = new Database(join(dir, "c.db"));
    applyPragmas(c);
    expect(cacheOf(c)).toBe(-64 * 1024);
    c.close();
  } finally {
    delete process.env["FORGE_DB_CACHE_MIB"];
    await rm(dir, { recursive: true, force: true });
  }
});
