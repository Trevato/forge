/**
 * Production behind main's newest release for over an hour is one
 * `release:behind` cause, and catching up clears it (#2612).
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { vitals } from "../src/kernel/vitals.ts";
import { newestOf, readNewest, setBehind, watchBehind, type Newest } from "../src/release/behind.ts";
import { setTagged, shippedReleases } from "../src/release/shipped.ts";

let dataDir: string;
let app: App;
beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-behind-"));
  app = createApp({ dataDir, port: 0 });
});
afterAll(async () => {
  setBehind(undefined);
  app.db.close();
  await rm(dataDir, { recursive: true, force: true });
});

const T0 = Date.parse("2026-10-16T17:00:00Z");
const MIN = 60_000;

function harness(live: string, newest: Newest | undefined) {
  let clock = T0;
  const state = { live, newest };
  const watch = watchBehind({ live: () => state.live, read: async () => state.newest, now: () => clock });
  setBehind(watch);
  const card = () =>
    vitals({ db: app.db, signals: app.signals, dataDir, now: clock }).degraded.find((d) => d.cause === "release:behind");
  return { state, watch, card, advance: (ms: number) => (clock += ms) };
}

test("matching versions say nothing", async () => {
  const h = harness("0.7.165", { version: "0.7.165", at: T0 - 5 * 3_600_000 });
  await h.watch.tick();
  expect(h.card()).toBeUndefined();
});

test("behind by 30 minutes says nothing", async () => {
  const h = harness("0.7.162", { version: "0.7.165", at: T0 - 30 * MIN });
  await h.watch.tick();
  expect(h.card()).toBeUndefined();
});

test("behind by 2 hours raises the cause once, and catching up clears it", async () => {
  const h = harness("0.7.162", { version: "0.7.165", at: T0 - 120 * MIN });
  await h.watch.tick();
  const first = h.card();
  expect(first).toMatchObject({
    sentence: "production is 0.7.162; main released 0.7.165 2 h ago.",
    href: "/board",
  });
  h.advance(10 * MIN);
  await h.watch.tick();
  const again = vitals({ db: app.db, signals: app.signals, dataDir, now: T0 + 10 * MIN }).degraded.filter(
    (d) => d.cause === "release:behind",
  );
  expect(again).toHaveLength(1);
  expect(again[0]!.since).toBe(first!.since);

  h.state.live = "0.7.165";
  expect(h.card()).toBeUndefined();
});

test("a read that finds nothing clears the cause; an unstamped forge says nothing", async () => {
  const h = harness("0.7.162", { version: "0.7.165", at: T0 - 120 * MIN });
  await h.watch.tick();
  h.state.newest = undefined;
  await h.watch.tick();
  expect(h.card()).toBeUndefined(); // read gave nothing: no cause, not a stale one
  h.state.newest = { version: "0.7.165", at: T0 - 120 * MIN };
  h.state.live = "dev";
  await h.watch.tick();
  expect(h.card()).toBeUndefined();
});

test("the newest is the first tagged release, or nothing while none is tagged", () => {
  expect(newestOf([{ version: "1.2.3", migrations: 1, at: T0 }, { version: "1.2.2", migrations: 1, at: T0 - MIN }])).toEqual({ version: "1.2.3", at: T0 });
  expect(newestOf([])).toBeUndefined();
  // A frozen release carries no time it was cut: no cause can be dated from it.
  expect(newestOf([{ version: "1.2.3", migrations: 1 }])).toBeUndefined();
});

test("readNewest reads the release tags and when each was cut from the git store, and keeps them as shipped", async () => {
  const dir = join(dataDir, "r.git");
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  const git = (args: string[], date = "2026-10-16T10:00:00Z", stdin?: string) =>
    Bun.spawn(["git", ...args], { cwd: dir, env: { ...env, GIT_COMMITTER_DATE: date }, stdout: "ignore", stderr: "ignore", ...(stdin ? { stdin: new Blob([stdin]) } : {}) }).exited;
  await Bun.$`mkdir -p ${dir}`.quiet();
  await git(["init", "-q", "-b", "main"]);
  await git(["commit", "-q", "--allow-empty", "-m", "one"]);
  expect(await readNewest(dir)).toBeUndefined();
  await git(["tag", "-a", "-F", "-", "v9.1.0"], "2026-10-16T10:00:00Z", JSON.stringify({ version: "9.1.0", migrations: 91, ids: [] }));
  await git(["tag", "-a", "-F", "-", "v9.1.1"], "2026-10-16T12:00:00Z", JSON.stringify({ version: "9.1.1", migrations: 91, ids: [] }));
  // Main never moved: the release is the tag.
  expect(await readNewest(dir)).toEqual({ version: "9.1.1", at: Date.parse("2026-10-16T12:00:00Z") });
  expect(shippedReleases()[0]!.version).toBe("9.1.1");
  setTagged([]);
  expect(await readNewest(join(dataDir, "nope.git"))).toBeUndefined();
});
