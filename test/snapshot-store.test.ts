/**
 * The snapshot store tries again. An object store answers a burst or a
 * moment of maintenance with a 5xx; one such answer used to fail a whole
 * nightly snapshot and name no key. `withRetries` tries each call several
 * times with doubling waits and, when it still fails, says which key.
 */
import { describe, expect, test } from "bun:test";
import { withRetries, type Store } from "../src/snapshot/store.ts";

/** A store that fails the first `failures` calls of each kind, then works. */
function flaky(failures: number): { store: Store; calls: string[] } {
  const calls: string[] = [];
  const left = new Map<string, number>();
  const gate = async (what: string): Promise<void> => {
    calls.push(what);
    const n = left.get(what) ?? failures;
    if (n > 0) {
      left.set(what, n - 1);
      throw new Error("S3Error: an unexpected error has occurred");
    }
  };
  const kept = new Map<string, Uint8Array | string>();
  return {
    calls,
    store: {
      where: "flaky",
      async put(key, body) {
        await gate(`put ${key}`);
        kept.set(key, body);
      },
      async get(key) {
        await gate(`get ${key}`);
        const v = kept.get(key);
        return v === undefined
          ? undefined
          : typeof v === "string"
            ? new TextEncoder().encode(v)
            : v;
      },
      async list(prefix) {
        await gate(`list ${prefix}`);
        return [...kept.keys()].filter((k) => k.startsWith(prefix));
      },
      async names(prefix) {
        await gate(`names ${prefix}`);
        return [];
      },
      async delete(key) {
        await gate(`delete ${key}`);
        kept.delete(key);
      },
    },
  };
}

describe("the snapshot store, with retries", () => {
  test("a call that fails twice and then works is one call to the caller, after two waits that double", async () => {
    const waits: number[] = [];
    const f = flaky(2);
    const store = withRetries(f.store, {
      attempts: 5,
      baseMs: 100,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    await store.put("snapshots/a/forge.db", "db");
    expect(
      f.calls.filter((c) => c === "put snapshots/a/forge.db"),
    ).toHaveLength(3);
    expect(waits).toEqual([100, 200]);
    expect(await store.list("snapshots/")).toEqual(["snapshots/a/forge.db"]);
  });

  test("a call that never works fails after the attempts, naming the key and the last reason", async () => {
    const f = flaky(99);
    const store = withRetries(f.store, {
      attempts: 3,
      baseMs: 1,
      sleep: async () => {},
    });
    await expect(store.put("snapshots/b/repos/x.bundle", "x")).rejects.toThrow(
      /put snapshots\/b\/repos\/x\.bundle failed after 3 attempts: S3Error: an unexpected error has occurred/,
    );
    expect(f.calls).toHaveLength(3);
  });

  test("a call that never answers is given up at the deadline, and the next attempt works", async () => {
    const waits: number[] = [];
    let calls = 0;
    const kept = new Map<string, Uint8Array | string>();
    const stuckOnce: Store = {
      where: "stuck once",
      async put(key, body) {
        calls++;
        if (calls === 1) await new Promise<void>(() => {});
        kept.set(key, body);
      },
      async get() {
        return undefined;
      },
      async list(prefix) {
        return [...kept.keys()].filter((k) => k.startsWith(prefix));
      },
      async names() {
        return [];
      },
      async delete() {},
    };
    const store = withRetries(stuckOnce, {
      attempts: 3,
      baseMs: 10,
      deadlineMs: 20,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    const started = Date.now();
    await store.put("snapshots/b/forge.db", "db");
    expect(calls).toBe(2);
    expect(waits).toEqual([10]);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(await store.list("snapshots/")).toEqual(["snapshots/b/forge.db"]);
  });

  test("a call that never answers at all fails after the attempts and says so", async () => {
    const stuck: Store = {
      where: "stuck",
      async put() {
        await new Promise<void>(() => {});
      },
      async get() {
        return undefined;
      },
      async list() {
        return [];
      },
      async names() {
        return [];
      },
      async delete() {},
    };
    const store = withRetries(stuck, {
      attempts: 2,
      baseMs: 1,
      deadlineMs: 15,
      sleep: async () => {},
    });
    await expect(store.put("snapshots/c/forge.db", "db")).rejects.toThrow(
      /put snapshots\/c\/forge\.db failed after 2 attempts: no answer in 15 ms/,
    );
  });

  test("a store that works is called once, with no wait", async () => {
    const waits: number[] = [];
    const f = flaky(0);
    const store = withRetries(f.store, {
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    await store.put("k", "v");
    expect(new TextDecoder().decode(await store.get("k"))).toBe("v");
    expect(waits).toEqual([]);
    expect(f.calls).toEqual(["put k", "get k"]);
  });
});
