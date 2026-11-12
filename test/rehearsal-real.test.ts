/**
 * The roll rehearsal (#873), for real: two short rolls of two forge
 * processes on one data directory. A forge that exits the moment it is
 * signalled refuses the requests routers still send it; one that lingers
 * past a probe period refuses none.
 *
 * In the gate (#11098); `scripts/flake-hunt.ts admit` is how it is proven.
 */

import { describe, expect, test } from "bun:test";
import { rehearse } from "../scripts/rehearse-roll.ts";
import { isRefusal, missLine, parseArgs, type RehearsalArgs } from "../scripts/rehearsal.ts";

describe("a real roll of two forge processes on one data directory", () => {
  const short = (lingerS: number): RehearsalArgs => ({
    ...parseArgs([], `${import.meta.dir}/..`),
    // Room for a slow boot and a long linger on a busy machine (#2020).
    seconds: 30,
    probeMs: 300,
    lingerS,
    concurrency: 2,
  });

  test("an old forge that exits on SIGTERM refuses what routers still send it", async () => {
    const v = await rehearse(short(0));
    expect(v.problem, v.problem ?? "").toBeNull();
    expect(v.refused).toBeGreaterThan(0);
    expect(v.tally.byOutcome["refused"]).toBeGreaterThan(0);
  }, 60_000);

  test("an old forge that lingers past a probe period refuses nobody", async () => {
    const v = await rehearse(short(5));
    expect(v.problem, v.problem ?? "").toBeNull();
    // Each refusal says when, whom, what came back and where both processes were.
    expect(v.tally.misses.filter((m) => isRefusal(m.outcome)).map(missLine)).toEqual([]);
    expect(v.refused).toBe(0);
    expect(v.tally.byForge["old"]).toBeGreaterThan(0);
    expect(v.tally.byForge["new"]).toBeGreaterThan(0);
    // It lingered: the old forge left rotation before it stopped answering.
    expect(v.timeline.oldExitMs).toBeGreaterThanOrEqual(5000);
    expect(v.timeline.oldOutOfRotationMs).toBeLessThan(v.timeline.oldExitMs ?? 0);
  }, 60_000);
});
