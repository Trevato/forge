// The switch disturbs nothing (#11917): each release counts the crew runs that were running in the
// process it drained, and the release card and `release_keeper` say so beside the stage timings.
import { expect, test } from "bun:test";
import { tick } from "../src/keeper/keeper.ts";
import { keeperAnswer } from "../src/keeper/landed.ts";
import { listKeeperReleases } from "../src/keeper/record.ts";
import { switched } from "../src/keeper/wire.ts";
import { runningAgentRuns, trackAgentRun, untrackAgentRun } from "../src/crew/running.ts";
import { keeperPanel } from "../src/web/pages/keeper-panel.ts";
import { keeperForge } from "./helpers/keeper.ts";

test("a switch with two crew runs in flight records 2, and the release card says so", async () => {
  const f = await keeperForge();
  await tick(f.ports);
  expect(listKeeperReleases(f.app.db)[0]!.stage).toBe("rolling");
  expect(listKeeperReleases(f.app.db)[0]!.interruptedRuns).toBeNull();

  trackAgentRun("run-one", new AbortController());
  trackAgentRun("run-two", new AbortController());
  try {
    switched(f.app.db, runningAgentRuns)({ buildMs: 4_000, proofMs: 3_000, switchMs: 1_000 });
  } finally {
    untrackAgentRun("run-one");
    untrackAgentRun("run-two");
  }

  const r = listKeeperReleases(f.app.db)[0]!;
  expect(r.interruptedRuns).toBe(2);
  expect(r.switchMs).toBe(1_000);
  expect(keeperAnswer(f.app.db).releases[0]!.interruptedRuns).toBe(2);
  expect(String(keeperPanel(f.app.db))).toContain("switch 1 s · interrupted 2 runs");
});

test("a quiet switch says interrupted 0 runs; a release that never counted says nothing", async () => {
  const f = await keeperForge();
  await tick(f.ports);
  expect(String(keeperPanel(f.app.db))).not.toContain("interrupted");
  switched(f.app.db, () => 0)({ buildMs: 0, proofMs: 0, switchMs: 0 });
  expect(String(keeperPanel(f.app.db))).toContain("interrupted 0 runs");
});
