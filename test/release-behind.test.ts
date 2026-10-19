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
import { newestVersion, readNewest, setBehind, watchBehind, type Newest } from "../src/release/behind.ts";

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

test("the newest version is the first of the document, or nothing", () => {
  expect(newestVersion(JSON.stringify({ releases: [{ version: "1.2.3" }, { version: "1.2.2" }] }))).toBe("1.2.3");
  expect(newestVersion("{")).toBeUndefined();
  expect(newestVersion(JSON.stringify({ releases: [{ version: "a b; rm" }] }))).toBeUndefined();
});

test("readNewest reads the list and its landing time from the git store", async () => {
  const dir = join(dataDir, "r.git");
  const run = async (...a: string[]) => {
    const p = Bun.spawn(["git", ...a], {
      cwd: dir,
      stdout: "ignore",
      stderr: "ignore",
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    });
    await p.exited;
  };
  await Bun.spawn(["git", "init", "-q", "-b", "main", dir]).exited;
  const commit = async (v: string[], date: string) => {
    await Bun.$`mkdir -p ${dir}/src/core`.quiet();
    await Bun.write(
      join(dir, "src/core/releases.json"),
      JSON.stringify({ releases: v.map((version) => ({ version })) }, null, 2),
    );
    await run("add", ".");
    await Bun.spawn(["git", "commit", "-q", "-m", v[0]!, "--date", date], {
      cwd: dir,
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_COMMITTER_DATE: date },
    }).exited;
  };
  await commit(["0.1.0"], "2026-10-16T10:00:00Z");
  await commit(["0.1.1", "0.1.0"], "2026-10-16T12:00:00Z");
  expect(await readNewest(dir, "main")).toEqual({ version: "0.1.1", at: Date.parse("2026-10-16T12:00:00Z") });
  expect(await readNewest(dir, "nope")).toBeUndefined();
  expect(await readNewest(dir, "--bad")).toBeUndefined();
});
