/**
 * The drill's budget follows the snapshot's size (#2744): a 400 MB snapshot
 * through a store throttled to the budget's own per-MB rate restores within
 * its 16 min 40 s, and a store that stalls halfway fails within the same
 * budget — its gets' deadlines and retries kept inside what is left, not
 * five 180 s attempts past it.
 *
 * Time runs a thousand times fast: the budget, the link and the store's
 * deadlines are all divided by `SCALE`, so 1000 s of budget is 1 s here.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { DRILL_MS_PER_MB, drillBudgetMs, runDrill } from "../src/snapshot/drill.ts";
import { failedSentence } from "../src/snapshot/verdict.ts";
import { restoreSnapshot } from "../src/snapshot/restore.ts";
import { listSnapshots, takeSnapshot } from "../src/snapshot/snapshot.ts";
import { CALL_DEADLINE_MS, dirStore, withRetries, type Store } from "../src/snapshot/store.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const SCALE = 1000;
const MB = 1_000_000;
const NAME = "2026-10-19T08-00-00Z";
const OBJECTS = 40;
const OBJECT_BYTES = 10 * MB;
const files = Array.from({ length: OBJECTS }, (_, i) => ({ path: `files/blob-${i}`, bytes: OBJECT_BYTES }));
const manifest = { name: NAME, version: "t", repos: 0, apps: 0, files, bytes: OBJECTS * OBJECT_BYTES, key: "none" };
// One body for every get: the bytes are not the point, their time is.
const body = new Uint8Array(OBJECT_BYTES);

/**
 * The 400 MB snapshot behind one link at the budget's per-MB rate (1 MB a
 * second, scaled), retried as `s3Store` retries; gets from `stallFrom` on
 * never answer.
 */
function throttled(stallFrom = Infinity): Store {
  const msPerByte = DRILL_MS_PER_MB / MB / SCALE;
  let free = 0;
  let n = 0;
  const raw: Store = {
    where: "throttled",
    async put() {},
    async get(key) {
      if (key === `snapshots/${NAME}/manifest.json`) return new TextEncoder().encode(JSON.stringify(manifest));
      if (!key.startsWith(`snapshots/${NAME}/files/`)) return undefined;
      if (n++ >= stallFrom) return new Promise<never>(() => {});
      free = Math.max(performance.now(), free) + OBJECT_BYTES * msPerByte;
      await Bun.sleep(free - performance.now());
      return body;
    },
    list: async () => [],
    names: async () => [NAME],
    async delete() {},
  };
  return withRetries(raw, { baseMs: 500 / SCALE, deadlineMs: CALL_DEADLINE_MS / SCALE });
}

describe("a 400 MB snapshot's drill", () => {
  let root = "";
  let app: App;
  let real: Store;
  let realName = "";

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "forge-drill-size-"));
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
    realName = (await listSnapshots(real))[0]!.name;
  });
  afterAll(() => {
    app.close();
    rmSync(root, { recursive: true, force: true });
  });

  /**
   * Fetch every object of the 400 MB snapshot through the store the drill
   * hands over, four at a time, then restore a real forge to open; says
   * when a get failed.
   */
  function drill(store: Store) {
    const failed: { at?: number; message?: string } = {};
    const restore = (async (s: Store, name: string, target: string, o: { onProgress?: (p: unknown) => void }) => {
      expect(name).toBe(NAME);
      let next = 0;
      let done = 0;
      o.onProgress?.({ phase: "files", done: 0, total: OBJECTS, bytes: 0 });
      try {
        await Promise.all(
          Array.from({ length: 4 }, async () => {
            for (let f = files[next++]; f !== undefined; f = files[next++]) {
              const got = await s.get(`snapshots/${NAME}/${f.path}`);
              expect(got?.byteLength).toBe(f.bytes);
              done++;
              o.onProgress?.({ phase: "files", done, total: OBJECTS, bytes: done * OBJECT_BYTES });
            }
          }),
        );
      } catch (error) {
        failed.at = performance.now();
        failed.message = String(error);
        throw error;
      }
      return restoreSnapshot(real, realName, target, {});
    }) as unknown as typeof restoreSnapshot;
    const started = performance.now();
    const result = runDrill({
      store,
      dataDir: join(root, "drill-data"),
      timeoutMs: drillBudgetMs(manifest.bytes) / SCALE,
      boot: async () => ({ ok: true, reason: "" }),
      restore,
    });
    return { result, failed, started };
  }

  test("its budget is 10 min + 400 × 1 s = 16 min 40 s", () => {
    expect(drillBudgetMs(manifest.bytes)).toBe(1_000_000);
  });

  test("through a link at the budget's per-MB rate it fits", async () => {
    const { result } = drill(throttled());
    const r = await result;
    expect(r.reason).toBeNull();
    expect(r.verdict).toBe("green");
    expect(r.budgetMs).toBe(1_000);
    // 400 MB at 1 MB/s is 400 s of the 1000: it fits with the floor to spare.
    expect(r.ms).toBeLessThan(r.budgetMs);
    const download = r.phases.find((p) => p.phase === "files")!;
    expect(download.ms).toBeGreaterThanOrEqual(400 - 5);
  });

  test("a store that stalls at the 31st object fails within the budget, its gets' retries too", async () => {
    const { result, failed, started } = drill(throttled(30));
    const r = await result;
    expect(r.verdict).toBe("red");
    expect(r.failedStep).toBe("restore");
    expect(r.ms).toBeLessThan(r.budgetMs + 40);
    // Five unbounded 180 s attempts from the stall (~300 s in) would end
    // past 1200 s; held inside what is left, the get gives up by 1000.
    for (let i = 0; i < 50 && failed.at === undefined; i++) await Bun.sleep(10);
    expect(failed.message).toMatch(/get snapshots\/2026-10-19T08-00-00Z\/files\/blob-3\d failed after \d attempts?/);
    expect(failed.at! - started).toBeLessThan(r.budgetMs + 40);
    // The card says the budget in minutes.
    expect(failedSentence(r)).toContain("It had 0.1 min.");
  });
});
