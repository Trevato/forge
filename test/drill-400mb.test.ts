/**
 * A 400 MB snapshot through a store throttled to the forge's 150 Mbit/s
 * downlink restores, whole and for real, inside the drill's size-scaled
 * budget (#2813): streamed into decompression (#2743), each phase timed
 * (#2742), the budget grown with the size (#2773).
 *
 * Two proofs of the same rule. The full one is 400 MB at 150 Mbit/s (21 s
 * of wire, a 16 min 40 s budget) and writes the 400 MB database to disk, so
 * it runs only where the scratch disk has room (`ROOM`), and is skipped by
 * name where it does not: a check's scratch disk ran out (ENOSPC) at about
 * 320 MB. The scaled one is 1/4 of both, 100 MB at 37.5 Mbit/s (the same
 * 21 s of wire, an 11 min 40 s budget), and always runs, so the streaming,
 * the phase times and the budget are proven everywhere; only the disk
 * write of the full size is not.
 *
 * Both snapshots are generated here, a real `forge.db` followed by
 * incompressible padding, never kept in the repo. Neither has a large
 * repository, so the `bundles` phase is ~0 ms in both: clone time at this
 * size is not proven here.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statfsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { drillBudgetMs, runDrill } from "../src/snapshot/drill.ts";
import { PART_BYTES, partPath, partPaths, unpack } from "../src/snapshot/parts.ts";
import { listSnapshots, takeSnapshot, type Manifest } from "../src/snapshot/snapshot.ts";
import { dirStore, type Store } from "../src/snapshot/store.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const MB = 1_000_000;
/** Free bytes the full run wants on the scratch disk: the 400 MB restored, the rest as margin. */
const ROOM = 1_500_000_000;
const free = (): number => {
  const s = statfsSync(tmpdir());
  return s.bavail * s.bsize;
};
const roomy = free() >= ROOM;

/** Fill `out` (a multiple of 4 bytes) with pseudo-random words, so zstd can only store it. */
function fillNoise(out: Uint8Array): void {
  const words = new Uint32Array(out.buffer, out.byteOffset, out.byteLength / 4);
  let x = 2463534242;
  for (let i = 0; i < words.length; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    words[i] = x;
  }
}

describe("a 400 MB snapshot through a 150 Mbit/s store", () => {
  let root = "";
  let app: App;
  let real: Store;
  let base: Manifest;
  let database: Uint8Array;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "forge-drill-400-"));
    app = createApp({ dataDir: join(root, "live"), port: 0 });
    const u = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!u.ok) throw new Error(u.error);
    real = dirStore(join(root, "store"));
    await takeSnapshot(
      { db: app.db, dataDir: app.config.dataDir, reposRoot: app.reposRoot, version: "t" },
      real,
      new Date("2026-10-18T08:00:00Z"),
    );
    base = (await listSnapshots(real))[0]!;
    // The database is the snapshot's own copy, the live file being in its WAL.
    const own = base.packed!.find((p) => p.path === "forge.db")!;
    const prefix = `snapshots/${base.name}/`;
    database = await unpack(own, await Promise.all(partPaths(own).map(async (k) => (await real.get(prefix + k))!)));
  });
  afterAll(() => {
    app.close();
    rmSync(root, { recursive: true, force: true });
  });

  /**
   * Drill a snapshot of `wireBytes` served at `mbit` Mbit/s: forge.db then
   * padding to that size on the wire, a database whose tail SQLite never
   * reads, in one zstd frame as the real packer writes it.
   */
  async function prove(wireBytes: number, mbit: number): Promise<void> {
    const prefix = `snapshots/${base.name}/`;
    const wirePerMs = (mbit * MB) / 8 / 1000;
    const db = database;
    const whole = new Uint8Array(db.byteLength + wireBytes);
    whole.set(db);
    fillNoise(whole.subarray(db.byteLength));
    const raw = whole.byteLength;
    const zst = new Uint8Array(await Bun.zstdCompress(whole));
    const parts = Math.ceil(zst.byteLength / PART_BYTES);
    const partFiles = Array.from({ length: parts }, (_, n) => ({
      path: partPath("forge.db", n),
      bytes: zst.subarray(n * PART_BYTES, (n + 1) * PART_BYTES).byteLength,
    }));
    const others = base.files.filter((f) => !f.path.startsWith("forge.db.zst."));
    const files = [...others, ...partFiles];
    const manifest: Manifest = {
      ...base,
      files,
      bytes: files.reduce((n, f) => n + f.bytes, 0),
      packed: [
        ...(base.packed ?? []).filter((p) => p.path !== "forge.db"),
        { path: "forge.db", bytes: raw, packedBytes: zst.byteLength, parts },
      ],
    };
    expect(manifest.bytes).toBeGreaterThanOrEqual(wireBytes);

    // One link for every get: each waits its turn behind the bytes before it.
    let busy = 0;
    const link: Store = {
      ...real,
      where: `throttled ${mbit} Mbit/s`,
      async get(key) {
        if (key === `${prefix}manifest.json`) return new TextEncoder().encode(JSON.stringify(manifest));
        const m = key.startsWith(`${prefix}forge.db.zst.`) ? Number(key.slice(-4)) : -1;
        const body = m >= 0 ? zst.subarray(m * PART_BYTES, (m + 1) * PART_BYTES) : await real.get(key);
        if (body === undefined) return undefined;
        busy = Math.max(performance.now(), busy) + body.byteLength / wirePerMs;
        await Bun.sleep(Math.max(0, busy - performance.now()));
        return body;
      },
    };

    const t = performance.now();
    const r = await runDrill({
      store: link,
      dataDir: join(root, `drill-data-${mbit}`),
      boot: async () => ({ ok: true, reason: "" }),
    });
    const took = performance.now() - t;
    console.log(`drill of ${Math.round(manifest.bytes / MB)} MB at ${mbit} Mbit/s: ${Math.round(took)} ms; ${r.phases.map((p) => `${p.phase} ${p.ms} ms`).join(", ")}`);

    expect(r.reason).toBeNull();
    expect(r.verdict).toBe("green");
    expect(r.budgetMs).toBe(drillBudgetMs(manifest.bytes));
    expect(r.budgetMs).toBeGreaterThanOrEqual(10 * 60_000 + (wireBytes / MB) * 1_000);
    expect(r.ms).toBeLessThan(r.budgetMs);
    expect(r.phases.map((p) => p.phase)).toEqual(["manifest", "files", "unpack", "bundles", "key", "open", "boot"]);
    // The wire is the floor of the download; every phase has a time.
    const download = r.phases.find((p) => p.phase === "files")!.ms;
    expect(download).toBeGreaterThanOrEqual(manifest.bytes / wirePerMs - 500);
    for (const p of r.phases) expect(p.ms).toBeGreaterThanOrEqual(0);
  }

  test.skipIf(!roomy)("400 MB at 150 Mbit/s restores green inside its 16 min 40 s budget, each phase timed", async () => {
    await prove(400 * MB, 150);
  }, 90_000);

  test("scaled by 4, 100 MB at 37.5 Mbit/s restores green inside its 11 min 40 s budget, each phase timed", async () => {
    await prove(100 * MB, 37.5);
  }, 90_000);
});
