/**
 * The write clock with two connections on one file (`core/write_clock.ts`):
 * what `data_version` reports for the other connection's commits, and the
 * rule a cache lives by: the stamp is read before the value is computed.
 */
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Stamped } from "../src/kernel/stamped.ts";
import { quietly, writeStamp } from "../src/core/write_clock.ts";

const open: Database[] = [];
afterEach(() => open.splice(0).forEach((d) => d.close()));

function pair(): { serve: Database; work: Database } {
  const path = join(mkdtempSync(join(tmpdir(), "forge-clock-")), "f.db");
  const serve = new Database(path, { create: true });
  serve.exec("PRAGMA journal_mode = WAL; CREATE TABLE page (n INTEGER); CREATE TABLE telemetry (n INTEGER)");
  const work = new Database(path);
  work.exec("PRAGMA busy_timeout = 2000");
  open.push(serve, work);
  return { serve, work };
}
const dv = (d: Database) => d.query<{ v: number }, []>("SELECT data_version AS v FROM pragma_data_version").get()!.v;

test("data_version: the other connection's commit moves it, one's own never; many commits between two reads move it once", () => {
  const { serve, work } = pair();
  const [s0, w0] = [dv(serve), dv(work)];
  serve.run("INSERT INTO page VALUES (1)");
  expect(dv(serve)).toBe(s0);
  expect(dv(work)).toBe(w0 + 1);
  for (let i = 0; i < 5; i++) work.run("INSERT INTO page VALUES (2)");
  expect(dv(serve)).toBe(s0 + 1);
});

test("the stamp moves with every commit of the other connection, quiet to it or not, and with this one's own loud writes only", () => {
  const { serve, work } = pair();
  const before = writeStamp(serve);
  quietly(work, () => work.run("INSERT INTO telemetry VALUES (1)"));
  const afterForeignQuiet = writeStamp(serve);
  expect(afterForeignQuiet).not.toBe(before);
  work.run("INSERT INTO page VALUES (1)");
  const afterForeign = writeStamp(serve);
  expect(afterForeign).not.toBe(afterForeignQuiet);
  // Equal stamps: nothing was written by anyone in between.
  expect(writeStamp(serve)).toBe(afterForeign);
  quietly(serve, () => serve.run("INSERT INTO telemetry VALUES (2)"));
  expect(writeStamp(serve)).toBe(afterForeign);
  serve.run("INSERT INTO page VALUES (3)");
  expect(writeStamp(serve)).not.toBe(afterForeign);
});

test("a cache that reads the stamp first is never served a value built from rows older than the commit that came while it computed", () => {
  const { serve, work } = pair();
  const cache = new Stamped<number>({ maxEntries: 4, maxAgeMs: 60_000 });
  const count = (): number => serve.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM page").get()!.n;
  // The other thread commits in the middle of the computation.
  const slow = (): number => {
    const seen = count();
    work.run("INSERT INTO page VALUES (1)");
    return seen;
  };
  const stamp = writeStamp(serve)!;
  expect(cache.get("k", stamp, slow)).toBe(0);
  // The next reader's stamp has moved, so the entry (built from 0 rows) is not served as current.
  const next = writeStamp(serve)!;
  expect(next).not.toBe(stamp);
  expect(cache.get("k", next, count)).toBe(1);
});
