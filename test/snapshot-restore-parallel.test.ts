/**
 * A restore reads its snapshot several objects at a time (#2539). Read one
 * after another, the drill of a snapshot with thousands of objects spent its
 * whole ten minutes in the restore step; the reads now share the upload's
 * limits, never more than `IN_FLIGHT` at once, and a missing or short file
 * still refuses the restore by name.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { runGit } from "../src/git/env.ts";
import { restoreSnapshot } from "../src/snapshot/restore.ts";
import { IN_FLIGHT } from "../src/snapshot/snapshot.ts";
import { dirStore, type Store } from "../src/snapshot/store.ts";

const NAME = "2026-10-14T08-00-00Z";
const prefix = `snapshots/${NAME}/`;
const FILES = 40;

/**
 * A store whose gets take `delay(key)` ms and which keeps the high-water
 * marks of gets, and of bytes, open at once. The manifest is read alone
 * before any file, so it is not counted.
 */
function slow(
  inner: Store,
  delay: number | ((key: string) => number),
): Store & { most: () => number; mostBytes: () => number } {
  let open = 0;
  let most = 0;
  let openBytes = 0;
  let mostBytes = 0;
  return {
    ...inner,
    async get(key) {
      const body = await inner.get(key);
      if (key.endsWith("manifest.json")) return body;
      const bytes = body?.byteLength ?? 0;
      open++;
      openBytes += bytes;
      most = Math.max(most, open);
      mostBytes = Math.max(mostBytes, openBytes);
      try {
        await Bun.sleep(typeof delay === "number" ? delay : delay(key));
        return body;
      } finally {
        open--;
        openBytes -= bytes;
      }
    },
    most: () => most,
    mostBytes: () => mostBytes,
  };
}

const manifestOf = (files: { path: string; bytes: number }[]): string =>
  JSON.stringify({
    name: NAME,
    startedAt: "2026-10-14T08:00:00.000Z",
    finishedAt: "2026-10-14T08:01:00.000Z",
    version: "t",
    repos: 0,
    apps: 1,
    files,
    bytes: files.reduce((s, f) => s + f.bytes, 0),
    // An old snapshot that carried its key raw: nothing to look for sealed.
    key: "raw",
  });

async function seed(store: Store, skip?: string): Promise<void> {
  const files: { path: string; bytes: number }[] = [];
  for (let n = 0; n < FILES; n++) {
    const path = `apps/a/file-${n}.txt`;
    const body = `file ${n}\n`;
    if (path !== skip) await store.put(prefix + path, body);
    files.push({ path, bytes: Buffer.byteLength(body) });
  }
  await store.put(`${prefix}manifest.json`, manifestOf(files));
}

describe("a restore reads in parallel", () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "forge-restore-parallel-"));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("several gets are in flight at once, never more than IN_FLIGHT, and every file lands", async () => {
    const store = slow(dirStore(join(root, "store-1")), 20);
    await seed(store);
    const dataDir = join(root, "data-1");
    const restored = await restoreSnapshot(store, NAME, dataDir);
    expect(restored.files).toBe(FILES);
    expect(store.most()).toBeGreaterThan(1);
    expect(store.most()).toBeLessThanOrEqual(IN_FLIGHT);
    for (let n = 0; n < FILES; n++)
      expect(readFileSync(join(dataDir, "apps/a", `file-${n}.txt`), "utf8")).toBe(`file ${n}\n`);
  });

  test("a file the store does not hold still refuses the restore, by name", async () => {
    const store = slow(dirStore(join(root, "store-2")), 5);
    await seed(store, "apps/a/file-17.txt");
    await expect(restoreSnapshot(store, NAME, join(root, "data-2"))).rejects.toThrow(
      `snapshot ${NAME} is missing apps/a/file-17.txt`,
    );
  });

  test("past IN_FLIGHT_BYTES the next read waits, though fewer than IN_FLIGHT are open", async () => {
    const store = slow(dirStore(join(root, "store-3")), 20);
    const files: { path: string; bytes: number }[] = [];
    for (let n = 0; n < 6; n++) {
      const path = `apps/a/big-${n}.bin`;
      await store.put(prefix + path, new Uint8Array(100).fill(n));
      files.push({ path, bytes: 100 });
    }
    await store.put(`${prefix}manifest.json`, manifestOf(files));
    const restored = await restoreSnapshot(store, NAME, join(root, "data-3"), { inFlightBytes: 250 });
    expect(restored.files).toBe(6);
    expect(store.mostBytes()).toBeLessThanOrEqual(250);
    expect(store.most()).toBe(2);
  });

  test("repositories come back in the manifest's order when later reads land first", async () => {
    // Neither bundle clones, so the error names the first one tried.
    const order = ["alice/first", "alice/second", "alice/third"];
    const files = order.map((r) => ({ path: `repos/${r}.bundle`, bytes: 13 }));
    const inner = dirStore(join(root, "store-4"));
    for (const f of files) await inner.put(prefix + f.path, "not a bundle\n");
    await inner.put(`${prefix}manifest.json`, manifestOf(files));
    // The first entry answers last, the last first.
    const store = slow(inner, (key) => {
      const at = files.findIndex((f) => prefix + f.path === key);
      return at < 0 ? 0 : (files.length - at) * 30;
    });
    await expect(restoreSnapshot(store, NAME, join(root, "data-4"))).rejects.toThrow(
      "could not restore alice/first",
    );
  });

  test("when clones fail at once, the one named is the manifest's earliest, not the race's winner", async () => {
    const order = ["alice/first", "alice/second", "alice/third"];
    const files = order.map((r) => ({ path: `repos/${r}.bundle`, bytes: 13 }));
    const store = dirStore(join(root, "store-5"));
    for (const f of files) await store.put(prefix + f.path, "not a bundle\n");
    await store.put(`${prefix}manifest.json`, manifestOf(files));
    // Every clone fails; the first entry's fails last.
    const git: typeof runGit = async (args) => {
      const first = args.some((a) => a.endsWith("first.bundle"));
      await Bun.sleep(first ? 60 : 5);
      return { ok: false, error: { code: 128, stderr: "not a bundle", args } };
    };
    await expect(restoreSnapshot(store, NAME, join(root, "data-5"), { git })).rejects.toThrow(
      "could not restore alice/first",
    );
  });
});
