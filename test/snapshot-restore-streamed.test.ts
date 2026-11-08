/**
 * The restore drill streams the snapshot into decompression (#2743): a
 * packed file's parts are unpacked as they arrive, in order, so no whole
 * compressed copy is held or written, the restored bytes match, and the
 * last part's download is the only wait left.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pack, partPath, unpacker, type PackedFile } from "../src/snapshot/parts.ts";
import { restoreSnapshot } from "../src/snapshot/restore.ts";
import { dirStore, type Store } from "../src/snapshot/store.ts";

const NAME = "2026-10-19T08-00-00Z";
const prefix = `snapshots/${NAME}/`;

/** Bytes under `dir`, every file counted. */
function diskBytes(dir: string): number {
  let total = 0;
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const path = join(d, name);
      const s = statSync(path);
      if (s.isDirectory()) walk(path);
      else total += s.size;
    }
  };
  try {
    walk(dir);
  } catch {}
  return total;
}

describe("a packed file unpacks as its parts arrive", () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "forge-restore-streamed-"));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("the file is already growing while the last part is still downloading; peak disk stays under 1.2x; bytes match", async () => {
    const db = crypto.getRandomValues(new Uint8Array(1_500_000));
    const { packed, parts } = await pack("forge.db", db, 64 * 1024);
    expect(parts.length).toBeGreaterThan(10);
    const inner = dirStore(join(root, "store"));
    for (const [i, part] of parts.entries()) await inner.put(prefix + partPath("forge.db", i), part);
    const files = parts.map((part, i) => ({ path: partPath("forge.db", i), bytes: part.byteLength }));
    await inner.put(
      `${prefix}manifest.json`,
      JSON.stringify({
        name: NAME,
        startedAt: "2026-10-19T08:00:00.000Z",
        finishedAt: "2026-10-19T08:01:00.000Z",
        version: "t",
        repos: 0,
        apps: 0,
        files,
        bytes: files.reduce((n, f) => n + f.bytes, 0),
        key: "none",
        packed: [packed],
      }),
    );
    const dataDir = join(root, "data");
    const last = prefix + partPath("forge.db", parts.length - 1);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let peak = 0;
    let grewBeforeLast = 0;
    const store: Store = {
      ...inner,
      get: async (key) => {
        peak = Math.max(peak, diskBytes(dataDir));
        if (key !== last) return inner.get(key);
        // Everything else has landed; wait for the file to show it was unpacked on arrival.
        for (let i = 0; i < 100 && diskBytes(dataDir) === 0; i++) await Bun.sleep(20);
        if (diskBytes(dataDir) === 0) throw new Error(`never came: still waiting while diskBytes(dataDir) === 0`);
        grewBeforeLast = diskBytes(dataDir);
        await gate;
        return inner.get(key);
      },
    };
    const done = restoreSnapshot(store, NAME, dataDir);
    await Bun.sleep(400);
    release();
    await done;
    peak = Math.max(peak, diskBytes(dataDir));
    expect(grewBeforeLast).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(db.byteLength * 1.2);
    expect(new Uint8Array(await Bun.file(join(dataDir, "forge.db")).arrayBuffer())).toEqual(db);
    expect(readdirSync(dataDir)).toEqual(["forge.db"]);
  });
});

describe("unpacker refuses what does not add up, and leaves nothing behind", () => {
  let root: string;
  let n = 0;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "forge-unpacker-"));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** Feed `parts` in order to an unpacker of `file`, finish it, and say what it refused with. */
  async function refusal(file: PackedFile, parts: Uint8Array[]): Promise<{ error: string; target: string }> {
    const target = join(root, `out-${n++}`);
    const u = unpacker(file, target);
    let error = "";
    try {
      for (const [i, part] of parts.entries()) await u.feed(i, part);
      await u.finish();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    await Bun.sleep(30);
    return { error, target };
  }
  const gone = (target: string): void => {
    expect(existsSync(target)).toBe(false);
    expect(existsSync(`${target}.partial`)).toBe(false);
  };
  const db = crypto.getRandomValues(new Uint8Array(200_000));

  test("a short set of parts", async () => {
    const { packed, parts } = await pack("forge.db", db, 16 * 1024);
    const r = await refusal(packed, parts.slice(0, -1));
    expect(r.error).toContain(`came back in ${parts.length - 1} parts, not ${parts.length}`);
    gone(r.target);
  });

  test("a wrong packed size", async () => {
    const { packed, parts } = await pack("forge.db", db, 16 * 1024);
    const r = await refusal({ ...packed, packedBytes: packed.packedBytes + 1 }, parts);
    expect(r.error).toContain("bytes, not");
    gone(r.target);
  });

  test("a wrong unpacked size", async () => {
    const { packed, parts } = await pack("forge.db", db, 16 * 1024);
    const r = await refusal({ ...packed, bytes: packed.bytes + 1 }, parts);
    expect(r.error).toContain(`unpacks to ${db.byteLength} bytes, not ${db.byteLength + 1}`);
    gone(r.target);
  });

  test("a corrupt part", async () => {
    const { packed, parts } = await pack("forge.db", db, 16 * 1024);
    const bad = parts.map((p) => new Uint8Array(p));
    bad[0] = new Uint8Array(bad[0]!.byteLength).fill(0xab);
    const r = await refusal(packed, bad);
    expect(r.error).not.toBe("");
    gone(r.target);
  });

  test("a part fed early resolves only once it is written, and a failure frees it", async () => {
    const { packed, parts } = await pack("forge.db", db, 16 * 1024);
    const target = join(root, `out-${n++}`);
    const u = unpacker(packed, target);
    let settled = false;
    const early = u.feed(2, parts[2]!).then(
      () => (settled = true),
      () => (settled = true),
    );
    await Bun.sleep(50);
    expect(settled).toBe(false);
    await u.feed(0, parts[0]!);
    await Bun.sleep(50);
    expect(settled).toBe(false);
    u.abort();
    await early;
    await Bun.sleep(30);
    expect(settled).toBe(true);
    gone(target);
  });
});
