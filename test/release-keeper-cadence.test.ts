// When the release keeper cuts (#7557): each rule refuses on its own, and a cut is a tag, never a commit to main.
import { describe, expect, test } from "bun:test";
import { decideCut, MIN_INTERVAL_MS, nextVersion, SNAPSHOT_WAIT_MS, type CadenceInput } from "../src/keeper/cadence.ts";
import { tick } from "../src/keeper/keeper.ts";
import { listKeeperReleases, recordCut } from "../src/keeper/record.ts";
import { A, B, keeperForge } from "./helpers/keeper.ts";

const NOW = Date.parse("2026-10-27T12:00:00.000Z");
const ready: CadenceInput = {
  main: B,
  newest: { version: "0.7.283", sha: A },
  live: "0.7.283",
  inFlight: false,
  gating: 0,
  lastCutAt: NOW - MIN_INTERVAL_MS,
  hold: undefined,
  now: NOW,
};

describe("cadence", () => {
  test("the next version is the patch plus one", () => {
    expect(nextVersion("0.7.283")).toBe("0.7.284");
    expect(nextVersion("1.0.9")).toBe("1.0.10");
    expect(nextVersion("0.7")).toBeUndefined();
  });

  test("main past a live tag, nothing in flight, the queue still, the interval passed, no hold: cut", () => {
    expect(decideCut(ready)).toEqual({ cut: true, version: "0.7.284" });
  });

  test("each rule refuses alone, and says which", () => {
    const why = (o: Partial<CadenceInput>) => {
      const d = decideCut({ ...ready, ...o });
      return d.cut ? "" : d.why;
    };
    expect(why({ main: A })).toBe("main is still 0.7.283");
    expect(why({ inFlight: true })).toContain("still rolling");
    expect(why({ live: "0.7.282" })).toBe("0.7.283 is not live yet (live: 0.7.282)");
    expect(why({ gating: 2 })).toBe("the merge queue is landing (2 gates running)");
    // One minute short of 30 is refused; exactly 30 passes (above).
    expect(why({ lastCutAt: NOW - MIN_INTERVAL_MS + 60_000 })).toBe("the last cut was 29 min ago; the interval is 30 min");
    expect(why({ hold: "owner: freeze for the demo" })).toBe("held: owner: freeze for the demo");
    expect(why({ newest: undefined })).toContain("no release tag");
    expect(why({ snapshotMs: 42 * 60_000 })).toBe("a snapshot is being taken (42 min in); a release would cut it short");
  });

  test("a snapshot in flight holds the cut, until it has run long enough to be stuck (#9653)", async () => {
    expect(decideCut({ ...ready, snapshotMs: 0 }).cut).toBe(false);
    expect(decideCut({ ...ready, snapshotMs: SNAPSHOT_WAIT_MS - 1 }).cut).toBe(false);
    expect(decideCut({ ...ready, snapshotMs: SNAPSHOT_WAIT_MS })).toEqual({ cut: true, version: "0.7.284" });
    expect(decideCut({ ...ready, snapshotMs: undefined })).toEqual({ cut: true, version: "0.7.284" });
    const f = await keeperForge();
    const held = await tick({ ...f.ports, snapshotting: () => 10 * 60_000 });
    expect(held).toBe("a snapshot is being taken (10 min in); a release would cut it short");
    expect(f.world.tags).toEqual([]);
    expect(await tick({ ...f.ports, snapshotting: () => undefined })).toContain("cut 0.7.284");
  });

  test("a tag the keeper rolled back is settled: the fix after it may be cut", () => {
    expect(decideCut({ ...ready, newest: { version: "0.7.284", sha: A }, live: "0.7.283", settled: true })).toEqual({ cut: true, version: "0.7.285" });
  });

  test("the keeper's cut is a tag on main's head, and records the known-good version and image first", async () => {
    const f = await keeperForge();
    const line = await tick(f.ports);
    expect(line).toContain("cut 0.7.284");
    expect(f.world.tags).toEqual([{ version: "0.7.284", sha: B }]);
    const [r] = listKeeperReleases(f.app.db);
    expect(r).toMatchObject({ version: "0.7.284", sha: B, stage: "rolling", knownGood: { version: "0.7.283", image: "reg.test/o/forge:0.7.283" } });
    expect(f.state.set).toEqual(["reg.test/o/forge:0.7.284"]);
    expect(f.events("release.cut")).toHaveLength(1);
    expect(f.events("release.released")).toEqual([{ version: "0.7.284", image: "reg.test/o/forge:0.7.284" }]);
    // While it rolls, a second tick cuts nothing more.
    f.world.main = "d".repeat(40);
    f.world.now += 2 * MIN_INTERVAL_MS;
    expect(await tick(f.ports)).toBe("0.7.284 is rolling");
    expect(f.world.tags).toHaveLength(1);
  });

  test("the queue mid-landing holds the cut", async () => {
    const f = await keeperForge();
    f.world.gating = 1;
    expect(await tick(f.ports)).toContain("merge queue is landing");
    expect(f.world.tags).toHaveLength(0);
    expect(f.state.set).toHaveLength(0);
  });

  test("the cut is recorded before the tag: a crash between them is tagged on the next tick, not stranded", async () => {
    const f = await keeperForge();
    // The process died after the row and before the tag.
    recordCut(f.app.db, { version: "0.7.284", sha: B, knownGood: { version: "0.7.283", image: "reg.test/o/forge:0.7.283" }, at: f.world.now });
    expect(f.world.tags).toHaveLength(0);
    expect(await tick(f.ports)).toBe("0.7.284 is rolling");
    expect(f.world.tags).toEqual([{ version: "0.7.284", sha: B }]);
    expect(f.state.set).toEqual(["reg.test/o/forge:0.7.284"]);
    // Tagged once: the next tick does not tag it again.
    await tick(f.ports);
    expect(f.world.tags).toHaveLength(1);
  });

  test("a refused tag drops the cut, so the cadence is not left waiting on a release that never was", async () => {
    const f = await keeperForge();
    f.world.refuseTag = "the origin refused v0.7.284";
    expect(await tick(f.ports)).toBe("not cut: the origin refused v0.7.284");
    expect(listKeeperReleases(f.app.db)).toHaveLength(0);
    expect(f.state.set).toHaveLength(0);
    expect(f.events("release.cut")).toHaveLength(0);
    f.world.refuseTag = undefined;
    expect(await tick(f.ports)).toContain("cut 0.7.284");
  });
});
