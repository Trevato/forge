// A release is judged on its first five minutes (#8848): its worst event-loop stall is kept beside the last
// release's, and over five seconds it holds the next cut with the reason; it stays live, since it answers.
import { expect, test } from "bun:test";
import { tick } from "../src/keeper/keeper.ts";
import { listKeeperReleases } from "../src/keeper/record.ts";
import { standingHolds } from "../src/keeper/hold.ts";
import { createBootStall, STALL_HOLD_MS } from "../src/perf/boot_stall.ts";
import { keeperPanel } from "../src/web/pages/keeper-panel.ts";
import { keeperRows } from "../src/tui/screens/keeper.ts";
import { withLandedToLive } from "../src/keeper/landed.ts";
import { keeperForge } from "./helpers/keeper.ts";

/** Cut and verify the next release, whose process saw `stallMs`. */
async function release(f: Awaited<ReturnType<typeof keeperForge>>, version: string, stallMs: number): Promise<string> {
  const ports = { ...f.ports, bootStallMs: () => stallMs };
  await tick(ports);
  f.world.live = version;
  const line = await tick(ports);
  f.world.main = `${version.length}`.padEnd(40, "d");
  f.world.now += 3_600_000;
  return line;
}

test("the worst stall counts only inside the first five minutes", () => {
  const w = createBootStall();
  w.note(900, 10_000);
  w.note(46_000, 4 * 60_000);
  w.note(70_000, 6 * 60_000);
  expect(w.worst()).toBe(46_000);
});

test("a release under the limit keeps its stall and holds nothing", async () => {
  const f = await keeperForge();
  const line = await release(f, "0.7.284", 1_800);
  expect(line).toContain("0.7.284 verified live");
  expect(listKeeperReleases(f.app.db)[0]!.worstStallMs).toBe(1_800);
  expect(standingHolds(f.app.db)).toEqual([]);
});

test("a release over 5 s stays live, holds the next cut with the stall and the last release's", async () => {
  const f = await keeperForge();
  await release(f, "0.7.284", 3_000);
  const line = await release(f, "0.7.285", 45_887);
  expect(line).toContain("0.7.285 verified live");
  const [h] = standingHolds(f.app.db);
  expect(h!.reason).toBe(`0.7.285 blocked the event loop 45887 ms in its first 5 minutes, over the ${STALL_HOLD_MS} ms limit (the release before: 3000 ms)`);
  const [newest] = listKeeperReleases(f.app.db);
  expect(newest).toMatchObject({ version: "0.7.285", stage: "verified", worstStallMs: 45_887 });
  expect(await tick({ ...f.ports, bootStallMs: () => 0 })).toContain("held:");
  expect(f.events("release.held")[0]).toMatchObject({ version: "0.7.285", worstStallMs: 45_887 });
  // The report: the stall beside the last release's.
  expect(String(keeperPanel(f.app.db))).toContain("45887 ms (last 3000 ms) — held");
  const rows = keeperRows(withLandedToLive(f.app.db, listKeeperReleases(f.app.db)));
  expect(rows[0]!.meta).toContain("boot stall 45887 ms (last 3000 ms)");
});
