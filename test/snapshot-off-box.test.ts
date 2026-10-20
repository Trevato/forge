/**
 * Home's "Last off-box backup" read "never" on a forge whose nightly lands in
 * a bucket every morning (#3701): the tile read only the second, mirror
 * bucket. A snapshot that lands in a bucket is off the machine; one in a
 * directory, or a bucket on loopback, is not. The tile shows the newest of
 * the two ways off.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { readKpis } from "../src/flow/kpis.ts";
import { recordMirror } from "../src/snapshot/mirror.ts";
import { isOffBox, lastOffBox } from "../src/snapshot/off_box.ts";
import { lastSnapshotOutcome, noteOffBox, recordSnapshotOutcome } from "../src/snapshot/outcome.ts";
import { startSnapshots } from "../src/snapshot/service.ts";
import { dirStore, type Store } from "../src/snapshot/store.ts";
import { kpiForge } from "../src/tui/screens/dashboard.ts";

describe("isOffBox", () => {
  test("a bucket elsewhere is off the machine; a directory or a loopback bucket is not", () => {
    expect(isOffBox({ where: "s3.us-west-004.backblazeb2.com/forge-snapshots" })).toBe(true);
    expect(isOffBox({ where: "minio.platform.svc:9000/app-forge" })).toBe(true);
    expect(isOffBox(dirStore("/data/backups"))).toBe(false);
    expect(isOffBox({ where: "localhost:9000/b" })).toBe(false);
    expect(isOffBox({ where: "LOCALHOST/b" })).toBe(false);
    expect(isOffBox({ where: "127.0.0.1:9000/b" })).toBe(false);
    expect(isOffBox({ where: "[::1]:9000/b" })).toBe(false);
  });
});

describe("lastOffBox", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "forge-offbox-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("nothing kept is never; a landing in a directory is still never", () => {
    expect(lastOffBox(dir)).toBeNull();
    recordSnapshotOutcome(dir, { landed: "s1", offBox: false }, "2026-10-19T08:30:00.000Z");
    expect(lastOffBox(dir)).toBeNull();
  });

  test("a landing in a bucket counts, and a later failure keeps it", () => {
    recordSnapshotOutcome(dir, { landed: "s2", offBox: true }, "2026-10-20T08:30:00.000Z");
    expect(lastOffBox(dir)).toBe("2026-10-20T08:30:00.000Z");
    recordSnapshotOutcome(dir, { error: "no answer" }, "2026-10-20T09:30:00.000Z");
    expect(lastSnapshotOutcome(dir)?.offBox).toBe(true);
    expect(lastOffBox(dir)).toBe("2026-10-20T08:30:00.000Z");
  });

  test("the newer of the mirror and the destination wins", () => {
    recordMirror(dir, { where: "b2", attemptAt: "2026-10-20T10:00:00.000Z", reachable: true, newest: "s1", newestAt: "2026-10-19T08:30:00.000Z" });
    expect(lastOffBox(dir)).toBe("2026-10-20T08:30:00.000Z");
    recordMirror(dir, { where: "b2", attemptAt: "2026-10-21T10:00:00.000Z", reachable: true, newest: "s3", newestAt: "2026-10-21T08:30:00.000Z" });
    expect(lastOffBox(dir)).toBe("2026-10-21T08:30:00.000Z");
  });

  test("an outcome kept before stores were recorded learns it once, and is not overwritten after", async () => {
    const old = mkdtempSync(join(tmpdir(), "forge-offbox-old-"));
    try {
      noteOffBox(old, true);
      expect(lastSnapshotOutcome(old)).toBeUndefined();
      recordSnapshotOutcome(old, { landed: "s1" }, "2026-10-20T08:30:00.000Z");
      expect(lastOffBox(old)).toBeNull();
      noteOffBox(old, true);
      expect(lastOffBox(old)).toBe("2026-10-20T08:30:00.000Z");
      noteOffBox(old, false);
      expect(lastSnapshotOutcome(old)?.offBox).toBe(true);
    } finally {
      await rm(old, { recursive: true, force: true });
    }
  });
});

describe("a snapshot that lands", () => {
  let root: string;
  let app: App;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "forge-offbox-svc-"));
    app = createApp({ dataDir: join(root, "data"), port: 0 });
  });
  afterAll(async () => {
    app.close();
    await rm(root, { recursive: true, force: true });
  });

  test("in a directory is not off the machine; in a bucket it is, and home's tile shows its age", async () => {
    const local = startSnapshots(app, dirStore(join(root, "store")), { version: "t", nightly: false });
    try {
      await local.now();
    } finally {
      await local.stop();
    }
    expect(lastSnapshotOutcome(app.config.dataDir)?.offBox).toBe(false);
    expect(readKpis(app.db, new Date(), kpiForge(app)).backupAt).toBeNull();

    // A bucket, as far as the forge can tell: no directory, a host that is not this machine.
    const { dir: _dir, ...inner } = dirStore(join(root, "bucket"));
    const bucket: Store = { ...inner, where: "s3.example.com/forge-snapshots" };
    const remote = startSnapshots(app, bucket, { version: "t", nightly: false });
    try {
      await remote.now();
    } finally {
      await remote.stop();
    }
    const kept = lastSnapshotOutcome(app.config.dataDir);
    expect(kept?.offBox).toBe(true);
    // The terminal's figures read the same data directory as home.
    expect(readKpis(app.db, new Date(), kpiForge(app)).backupAt).toBe(kept!.landedAt!);
  }, 30_000);
});
