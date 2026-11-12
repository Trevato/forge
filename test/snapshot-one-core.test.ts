/**
 * The 1-CPU rule (#11561): a due snapshot waits while a crew run holds the
 * only core and is taken on the next tick after the run ends. The cap on
 * deferral is MAX_DEFER_MS, one hour: a run that is always active cannot
 * keep a snapshot from being taken.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { MAX_DEFER_MS, startSnapshots } from "../src/snapshot/service.ts";
import { listSnapshots } from "../src/snapshot/snapshot.ts";
import { dirStore } from "../src/snapshot/store.ts";

let root: string;
let app: App;
let n = 0;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "forge-onecore-"));
  app = createApp({ dataDir: join(root, "live"), port: 0 });
});
afterAll(async () => {
  app.close();
  await rm(root, { recursive: true, force: true });
});

async function setup(cpus: number, runs: { n: number }, clock: { t: number }) {
  const store = dirStore(join(root, `store-${n++}`));
  const snaps = startSnapshots(app, store, {
    version: "t",
    nightly: false,
    now: () => clock.t,
    cpus: () => cpus,
    activeCrewRuns: () => runs.n,
  });
  return { store, snaps };
}

const clock = () => ({ t: Date.parse("2026-11-12T09:00:00Z") });

test("1 CPU with a crew run active defers a due snapshot, then takes it once the run is gone", async () => {
  const runs = { n: 1 };
  const c = clock();
  const { store, snaps } = await setup(1, runs, c);
  try {
    expect(await snaps.takeIfDue()).toBe(false);
    expect(await listSnapshots(store)).toHaveLength(0);
    c.t += 5 * 60_000;
    expect(await snaps.takeIfDue()).toBe(false);
    runs.n = 0;
    expect(await snaps.takeIfDue()).toBe(true);
    expect(await listSnapshots(store)).toHaveLength(1);
  } finally {
    await snaps.stop();
  }
});

test("2 CPUs take a due snapshot at once, run or not", async () => {
  const { store, snaps } = await setup(2, { n: 1 }, clock());
  try {
    expect(await snaps.takeIfDue()).toBe(true);
    expect(await listSnapshots(store)).toHaveLength(1);
  } finally {
    await snaps.stop();
  }
});

test("the cap: a run that never ends defers a snapshot at most one hour, then it is taken", async () => {
  expect(MAX_DEFER_MS).toBe(3_600_000);
  const c = clock();
  const { store, snaps } = await setup(1, { n: 1 }, c);
  try {
    expect(await snaps.takeIfDue()).toBe(false);
    c.t += MAX_DEFER_MS - 1;
    expect(await snaps.takeIfDue()).toBe(false);
    c.t += 1;
    expect(await snaps.takeIfDue()).toBe(true);
    expect(await listSnapshots(store)).toHaveLength(1);
  } finally {
    await snaps.stop();
  }
});

test("the nightly timer: a held core re-arms it without taking; the next tick after the run takes", async () => {
  const runs = { n: 1 };
  const store = dirStore(join(root, `store-${n++}`));
  const snaps = startSnapshots(app, store, {
    version: "t",
    nightlyInMs: 20,
    snapshotCheckMs: 20,
    snapshotCatchUpMs: 3_600_000,
    catchUpMs: 3_600_000,
    cpus: () => 1,
    activeCrewRuns: () => runs.n,
  });
  try {
    await Bun.sleep(150);
    expect(await listSnapshots(store)).toHaveLength(0);
    runs.n = 0;
    for (let i = 0; i < 100 && (await listSnapshots(store)).length === 0; i++) await Bun.sleep(50);
    expect(await listSnapshots(store)).toHaveLength(1);
  } finally {
    await snaps.stop();
  }
});

test("a snapshot already running is left alone: a due check neither waits on it nor starts a second", async () => {
  const inner = dirStore(join(root, `store-${n++}`));
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const store = { ...inner, put: async (k: string, b: Uint8Array) => (await gate, inner.put(k, b)) };
  const snaps = startSnapshots(app, store, {
    version: "t",
    nightly: false,
    cpus: () => 1,
    activeCrewRuns: () => 0,
  });
  try {
    const running = snaps.now();
    await Bun.sleep(50);
    expect(snaps.progress()).toBeDefined();
    expect(await snaps.takeIfDue()).toBe(false);
    release();
    await running;
    expect(await listSnapshots(inner)).toHaveLength(1);
  } finally {
    release();
    await snaps.stop();
  }
});
