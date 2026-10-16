/**
 * Snapshots kept on the volume they copy, with no off-box mirror, share its
 * one point of failure: vitals says so, and says nothing once they live
 * elsewhere or a mirror copies them off (#1148).
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { forgeVitals, snapshotPlace } from "../src/actions/health.ts";
import { sharesVolume, SNAPSHOTS_ON_STATE_VOLUME, vitals } from "../src/kernel/vitals.ts";
import { dirStore, withRetries } from "../src/snapshot/store.ts";

let dataDir: string;
let app: App;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-vitals-snapshots-"));
  app = createApp({ dataDir, port: 0 });
});

afterAll(async () => {
  app.db.close();
  await rm(dataDir, { recursive: true, force: true });
});

const read = (snapshots?: { dir?: string; mirrored: boolean }) =>
  vitals({ db: app.db, signals: app.signals, dataDir, snapshots });
const flagged = (v: ReturnType<typeof read>) =>
  v.degraded.find((d) => d.cause === "snapshots");

test("a snapshot directory on the data volume, mirrored nowhere, is a need pointing at Backups", () => {
  const v = read({ dir: join(dataDir, "snapshots"), mirrored: false });
  expect(v.needs).toContain(SNAPSHOTS_ON_STATE_VOLUME);
  expect(flagged(v)?.href).toBe("/settings/backups");
});

test("a mirror copying them off the box clears it", () => {
  expect(flagged(read({ dir: join(dataDir, "snapshots"), mirrored: true }))).toBeUndefined();
});

test("a bucket store, which has no directory, is never flagged", () => {
  expect(flagged(read({ mirrored: false }))).toBeUndefined();
});

test("a forge told nothing about snapshots is never flagged", () => {
  expect(flagged(read())).toBeUndefined();
});

test("sharesVolume reads a path that does not exist yet by its nearest parent", () => {
  expect(sharesVolume(dataDir, join(dataDir, "not", "made", "yet"))).toBe(true);
});

test.skipIf(!existsSync("/proc/self"))("sharesVolume tells two volumes apart", () => {
  expect(sharesVolume(dataDir, "/proc/self")).toBe(false);
});

test("a directory store names its directory, through the retry wrapper too", () => {
  const root = join(dataDir, "store");
  expect(dirStore(root).dir).toBe(root);
  expect(withRetries(dirStore(root)).dir).toBe(root);
});

test("a forge running no snapshot service has no place, and forgeVitals carries no such need", () => {
  expect(snapshotPlace(app)).toBeUndefined();
  expect(forgeVitals(app).degraded.some((d) => d.cause === "snapshots")).toBe(false);
});
