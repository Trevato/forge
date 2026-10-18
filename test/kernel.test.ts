import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/kernel/db.ts";
import { createUser, verifyPasswordThrottled } from "../src/core/users.ts";
import { migrations } from "../src/core/schema.ts";
import { CHEAP, cheapened, realHash } from "./helpers/cheap-hash.ts";
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

  test("a fresh database after the first is a copy of the migrated empty one (#2038)", () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-kernel-"));
    try {
      // random() tells a copy from a second run of the migrations.
      const list = [
        "CREATE TABLE seed (n INTEGER); INSERT INTO seed (n) VALUES (random())",
        "CREATE TABLE parent (id INTEGER PRIMARY KEY); CREATE TABLE child (pid INTEGER REFERENCES parent(id))",
      ];
      const seed = (db: ReturnType<typeof openDb>) =>
        db.query<{ n: number }, []>("SELECT n FROM seed").all();
      const first = openDb(join(dir, "a.db"), list);
      // Written after the image was taken: never part of a later copy.
      first.exec("INSERT INTO parent (id) VALUES (1)");
      const second = openDb(join(dir, "b.db"), list);
      const memory = openDb(":memory:", list);
      for (const copy of [second, memory]) {
        expect(seed(copy)).toEqual(seed(first));
        expect(copy.query("SELECT id FROM parent").all()).toEqual([]);
        expect(() => copy.exec("INSERT INTO child (pid) VALUES (99)")).toThrow();
        expect(copy.query("SELECT $n AS n").get({ n: 3 })).toEqual({ n: 3 });
        expect(
          copy.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version,
        ).toBe(2);
      }
      expect(
        second.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode,
      ).toBe("wal");
      // A list that grew since the copy was taken still runs what is new.
      list.push("CREATE TABLE later (z INTEGER)");
      const third = openDb(join(dir, "c.db"), list);
      expect(seed(third)).toEqual(seed(first));
      third.exec("INSERT INTO later (z) VALUES (1)");
      // A different list is never handed this one's copy.
      const other = openDb(join(dir, "d.db"), [list[0]!]);
      expect(seed(other)).not.toEqual(seed(first));
      for (const db of [first, second, memory, third, other]) db.close();
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

describe("passwords under test are hashed at argon2id's floor (#2038)", () => {
  test("bunfig preloads it: an account made in a test stores the cheapest argon2id", async () => {
    const db = openDb(":memory:", migrations);
    const made = await createUser(db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
    });
    if (!made.ok) throw new Error(made.error);
    const row = db
      .query<{ password_hash: string }, []>("SELECT password_hash FROM user")
      .get();
    expect(row?.password_hash.startsWith("$argon2id$v=19$m=8,t=1,p=1$")).toBe(true);
    expect((await verifyPasswordThrottled(db, { username: "alice", password: "a-good-passphrase", source: "127.0.0.1" })).ok).toBe(true);
    expect((await verifyPasswordThrottled(db, { username: "alice", password: "a-bad-passphrase", source: "127.0.0.1" })).ok).toBe(false);
    db.close();
  });

  test("only the default is cheapened; a named cost and the runtime's own are kept", async () => {
    expect(cheapened(undefined)).toEqual(CHEAP);
    expect(cheapened("argon2id")).toEqual(CHEAP);
    const named = { algorithm: "argon2id", memoryCost: 16, timeCost: 2 } as const;
    expect(cheapened(named)).toBe(named);
    expect(cheapened("bcrypt")).toBe("bcrypt");
    // What production stores still verifies: the cost lives in the hash.
    const real = await realHash("a-good-passphrase", "argon2id");
    expect(real.startsWith("$argon2id$v=19$m=65536,t=2,p=1$")).toBe(true);
    expect(await Bun.password.verify("a-good-passphrase", real)).toBe(true);
  });
});
