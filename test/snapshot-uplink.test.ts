/**
 * The nightly snapshot fits the uplink (#2536). The forge runs behind a home
 * line shaped to 15 Mbit/s up; a 334 MB database in one put against a fixed
 * 180 s deadline failed every attempt, two nights running. Here a 400 MB
 * body crosses a fake store throttled to 15 Mbit/s — run a hundred times
 * faster, deadlines scaled alike — compressed and in parts, each part with
 * a deadline that follows its size, and comes back byte-identical.
 *
 * The round trip is checked in memory, through the same `unpack` a restore
 * runs: 400 MB written out per run filled the check's shared disk once
 * (ENOSPC, pull #2537). Restoring a packed database to disk is the drill's
 * test (`snapshot-drill.test.ts`), with parts small enough to be many.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { isPackedFile, pack, partPath, partPaths, PART_BYTES, unpack, type PackedFile } from "../src/snapshot/parts.ts";
import { deadlineFor, FLOOR_BYTES_PER_S, SLACK_MS, withRetries, type Store } from "../src/snapshot/store.ts";

/**
 * How much faster than life the link runs; every deadline shrinks alike.
 * A hundred keeps a part's slack at 600 ms, well above a busy check's
 * timer jitter, and the whole upload near a second.
 */
const SPEEDUP = 100;
const UPLINK_BYTES_PER_S = (15_000_000 / 8) * SPEEDUP;
const scaled = { floorBytesPerS: FLOOR_BYTES_PER_S * SPEEDUP, slackMs: SLACK_MS / SPEEDUP };

/**
 * A store behind one shaped link: puts share it first come, first served,
 * so one waits for the bytes queued ahead of it as on a real uplink.
 */
function throttled(): Store & { objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>();
  let freeAt = 0;
  return {
    where: "throttled",
    objects,
    async put(key, body) {
      const bytes = typeof body === "string" ? Buffer.from(body) : body;
      const now = performance.now();
      freeAt = Math.max(now, freeAt) + (bytes.byteLength / UPLINK_BYTES_PER_S) * 1000;
      await Bun.sleep(freeAt - now);
      objects.set(key, bytes);
    },
    get: async (key) => objects.get(key),
    list: async (prefix) => [...objects.keys()].filter((k) => k.startsWith(prefix)),
    names: async () => [],
    delete: async (key) => void objects.delete(key),
  };
}

/** 400 MB that compresses about as a database does: pages half data, half empty. */
function body400(): Uint8Array {
  const out = new Uint8Array(400 * 1_000_000);
  for (let at = 0; at < out.byteLength; at += 4096)
    crypto.getRandomValues(out.subarray(at, Math.min(at + 2048, out.byteLength)));
  return out;
}

const sha = (b: Uint8Array): string => new Bun.CryptoHasher("sha256").update(b).digest("hex");

describe("a 400 MB database behind a 15 Mbit/s uplink", () => {
  let body: Uint8Array | undefined;
  let digest: string;
  let packed: PackedFile;
  let parts: Uint8Array[];

  beforeAll(async () => {
    body = body400();
    digest = sha(body);
    ({ packed, parts } = await pack("forge.db", body));
  }, 60_000);

  afterAll(() => {
    body = undefined;
  });

  test("whole, in one put against a fixed 180 s, it never lands: the night of 2026-10-17", async () => {
    const link = throttled();
    const store = withRetries(link, { attempts: 1, deadlineMs: 180_000 / SPEEDUP });
    // 400 MB at 15 Mbit/s is 213 s: past the deadline however the timers run.
    await expect(store.put("forge.db", body!)).rejects.toThrow(/no answer in 2 s/);
    // Only the digest is needed from here; the rest of the suite runs lighter.
    body = undefined;
  });

  test("compressed, it is smaller, and cut in parts of 16 MB", () => {
    expect(packed.bytes).toBe(400 * 1_000_000);
    expect(packed.packedBytes).toBeLessThan(packed.bytes * 0.6);
    expect(packed.parts).toBe(Math.ceil(packed.packedBytes / PART_BYTES));
    expect(parts.every((p) => p.byteLength <= PART_BYTES)).toBe(true);
  });

  test("a part's deadline follows its size: bytes at 5 Mbit/s, plus slack, never a fixed 180 s", () => {
    expect(deadlineFor(PART_BYTES)).toBe(60_000 + Math.ceil((PART_BYTES / 625_000) * 1000));
    expect(deadlineFor(333_688_832)).toBeGreaterThan(533_000);
    expect(deadlineFor(0)).toBe(SLACK_MS);
  });

  // The queue holds 64 MB at once (IN_FLIGHT_BYTES): four 16 MB parts.
  test("in parts, four in flight as the snapshot's queue holds them, it lands and restores byte-identical", async () => {
    const link = throttled();
    const store = withRetries(link, { ...scaled, baseMs: 1 });
    const name = "2026-10-18T08-00-00Z";
    const prefix = `snapshots/${name}/`;
    const started = performance.now();
    const queue = parts.map((part, n) => ({ path: partPath("forge.db", n), part }));
    const files = queue.map((q) => ({ path: q.path, bytes: q.part.byteLength }));
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        for (let q = queue.shift(); q !== undefined; q = queue.shift()) await store.put(prefix + q.path, q.part);
      }),
    );
    // The link's own pace: every packed byte at 15 Mbit/s (a timer may wake a little early).
    const ms = performance.now() - started;
    expect(ms).toBeGreaterThanOrEqual((packed.packedBytes / UPLINK_BYTES_PER_S) * 1000 * 0.95);
    await store.put(
      `${prefix}manifest.json`,
      JSON.stringify({ name, startedAt: "", finishedAt: "", version: "t", repos: 0, apps: 0, files, bytes: packed.packedBytes, key: "none", packed: [packed] }),
    );
    // Back as a restore reads it: the manifest from the store, its packed
    // entry checked, every part fetched in order, joined and unpacked.
    const manifest = JSON.parse(new TextDecoder().decode((await store.get(`${prefix}manifest.json`))!));
    const [entry] = manifest.packed;
    expect(isPackedFile(entry)).toBe(true);
    const back: Uint8Array[] = [];
    for (const path of partPaths(entry)) back.push((await store.get(prefix + path))!);
    expect(sha(await unpack(entry, back))).toBe(digest);
  }, 60_000);

  test("parts that come back short, missing or out of count are refused, never written as a database", async () => {
    await expect(unpack(packed, parts.slice(1))).rejects.toThrow(/parts, not/);
    const short = [...parts];
    short[0] = short[0]!.subarray(1);
    await expect(unpack(packed, short)).rejects.toThrow(/bytes, not/);
    await expect(unpack({ ...packed, bytes: packed.bytes - 1 }, parts)).rejects.toThrow(/unpacks to/);
  });
});
