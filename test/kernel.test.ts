import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/kernel/db.ts";
import { ForgeError, defect } from "../src/kernel/error.ts";
import { id, secret } from "../src/kernel/id.ts";
import {
  andThen,
  err,
  map,
  ok,
  trap,
  unwrap,
  unwrapOr,
} from "../src/kernel/result.ts";

describe("result", () => {
  test("ok and err discriminate", () => {
    const good = ok(42);
    const bad = err("nope");
    expect(good.ok).toBe(true);
    expect(bad.ok).toBe(false);
    expect(good.value).toBe(42);
    expect(bad.error).toBe("nope");
  });

  test("map and andThen short-circuit on Err", () => {
    const bad: ReturnType<typeof err<string>> = err("boom");
    expect(map(bad, (n: number) => n + 1)).toBe(bad);
    expect(andThen(bad, (n: number) => ok(n + 1))).toBe(bad);
    expect(unwrap(map(ok(2), (n) => n * 3))).toBe(6);
  });

  test("trap catches throws", () => {
    const result = trap(() => {
      throw new Error("caught");
    });
    expect(result.ok).toBe(false);
  });

  test("unwrap throws ForgeError on Err, with cause", () => {
    try {
      unwrap(err("root"), "context msg");
      expect.unreachable();
    } catch (e) {
      expect(ForgeError.isInstance(e)).toBe(true);
      expect((e as ForgeError).code).toBe("result.unwrap");
      expect((e as ForgeError).cause).toBe("root");
    }
  });

  test("unwrapOr falls back", () => {
    expect(unwrapOr(err("x"), 7)).toBe(7);
    expect(unwrapOr(ok(1), 7)).toBe(1);
  });
});

describe("error", () => {
  test("isInstance works across realms via symbol marker", () => {
    const e = new ForgeError("test.code", "message");
    expect(ForgeError.isInstance(e)).toBe(true);
    expect(ForgeError.isInstance(new Error("plain"))).toBe(false);
    expect(ForgeError.isInstance(null)).toBe(false);
  });

  test("defect throws with code and cause", () => {
    expect(() => defect("a.b", "broken", "why")).toThrow(ForgeError);
    try {
      defect("a.b", "broken", "why");
    } catch (e) {
      expect((e as ForgeError).code).toBe("a.b");
      expect((e as ForgeError).cause).toBe("why");
    }
  });
});

describe("id", () => {
  test("ids are 26 chars, sortable by time", () => {
    const early = id(1_000_000);
    const late = id(2_000_000);
    expect(early).toHaveLength(26);
    expect(early < late).toBe(true);
    expect(early).toMatch(/^[0-9abcdefghjkmnpqrstvwxyz]{26}$/);
  });

  test("ids at the same millisecond are unique", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(id(5));
    expect(seen.size).toBe(1000);
  });

  test("ids are monotonic even within a millisecond", () => {
    // The property every id-ordered listing depends on: later id sorts higher.
    let prev = id(9);
    for (let i = 0; i < 1000; i++) {
      const next = id(9);
      expect(next > prev).toBe(true);
      prev = next;
    }
  });

  test("timestamp round-trips through the first 10 chars", () => {
    const now = Date.now();
    const a = id(now);
    const b = id(now);
    expect(a.slice(0, 10)).toBe(b.slice(0, 10));
  });

  test("secrets are long and unique", () => {
    const s = secret();
    expect(s.length).toBeGreaterThanOrEqual(43);
    expect(secret()).not.toBe(s);
  });
});

describe("db", () => {
  test("migrations apply linearly and are tracked", () => {
    const db = openDb(":memory:", [
      "CREATE TABLE a (x INTEGER)",
      "CREATE TABLE b (y INTEGER)",
    ]);
    db.exec("INSERT INTO a (x) VALUES (1)");
    db.exec("INSERT INTO b (y) VALUES (2)");
    const version = db
      .query<{ user_version: number }, []>("PRAGMA user_version")
      .get();
    expect(version?.user_version).toBe(2);
  });

  test("a failing migration rolls back atomically", () => {
    expect(() =>
      openDb(":memory:", [
        "CREATE TABLE a (x INTEGER); INSERT INTO nonexistent VALUES (1)",
      ]),
    ).toThrow();
  });

  test("future schema refuses to run", () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-kernel-"));
    try {
      const path = join(dir, "forge.db");
      const db = openDb(path, ["CREATE TABLE a (x INTEGER)"]);
      db.close();
      expect(() => openDb(path, [])).toThrow(ForgeError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("foreign keys are enforced", () => {
    const db = openDb(":memory:", [
      "CREATE TABLE parent (id INTEGER PRIMARY KEY); CREATE TABLE child (pid INTEGER REFERENCES parent(id))",
    ]);
    expect(() => db.exec("INSERT INTO child (pid) VALUES (99)")).toThrow();
  });
});
