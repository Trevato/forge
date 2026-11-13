/**
 * What the serving thread observes, as rows for the engine's keeper, clog
 * watch and asks ledger (`engine/observed.ts`): publish, lose the memory,
 * adopt, and every reader answers as it did; a change is one row; a thing
 * gone is a row gone.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { adoptObserved, publishObserved } from "../src/engine/observed.ts";
import { hotFiles, holdHot, rememberPullFiles, standingHot, warmFiles, adoptTouched, adoptStanding, adoptStandingWide, observedStanding, observedStandingWide, observedTouched } from "../src/crew/hot_files.ts";
import { adoptHeat, observedHeat, sampleHeat, sampleTimes } from "../src/crew/hot_history.ts";
import { adoptWaiting, conflictedPulls, noteWaitingToFinish } from "../src/flow/conflicted.ts";
import { heldRuns, noteHeld } from "../src/runs/held.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();
const apps: App[] = [];
// These modules keep their maps for the whole test process, shared with every other file: leave them as they were found.
type Held = ReturnType<typeof snapshot>;
const snapshot = () => ({ touched: observedTouched(), standing: observedStanding(), wide: observedStandingWide(), heat: observedHeat() });
let found: Held;
beforeEach(() => {
  found = snapshot();
});
afterEach(() => {
  const now = snapshot();
  for (const [kind, adopt] of [["touched", adoptTouched], ["standing", adoptStanding], ["wide", adoptStandingWide], ["heat", adoptHeat]] as const) {
    for (const scope of now[kind].keys()) if (!found[kind].has(scope)) adopt(scope, undefined);
    for (const [scope, value] of found[kind]) adopt(scope, JSON.parse(JSON.stringify(value)));
  }
  apps.splice(0).forEach((a) => a.close());
});

const forge = async (dir?: string): Promise<App> => {
  const app = createApp({ dataDir: dir ?? (await mkdtemp(join(tmpdir(), "forge-observed-"))), port: 0 });
  apps.push(app);
  return app;
};

const wipe = (db: App["db"], repoId: string): void => {
  adoptTouched(repoId, undefined);
  adoptStanding(repoId, undefined);
  adoptStandingWide(repoId, undefined);
  adoptHeat(repoId, undefined);
  adoptWaiting(db, repoId, undefined);
};

test("what a thread observed, another adopts, and reads the same", async () => {
  const owner = await forge();
  const reader = await forge(owner.config.dataDir);
  const repoId = "r1";
  const pulls = [1, 2, 3, 4, 5, 6].map((n) => ({ number: n, files: ["src/a.ts", "src/b.ts", `src/only${n}.ts`] }));
  rememberPullFiles(repoId, pulls);
  sampleHeat(repoId, hotFiles(repoId), Date.now() - 3_600_000);
  holdHot(repoId, [], new Date());
  noteWaitingToFinish(owner.db, repoId, [{ repo: "o/r", number: 9, since: "2026-11-13T00:00:00.000Z", public: true }]);
  noteHeld(owner.db, new Map([["run1", "pace" as const]]));
  const before = {
    hot: [...hotFiles(repoId)],
    warm: warmFiles(),
    times: sampleTimes(repoId),
    waiting: conflictedPulls(owner.db),
    held: [...heldRuns(owner.db)],
    standing: standingHot(repoId),
  };
  expect(before.hot.length).toBe(2);
  expect(publishObserved(owner.db)).toBeGreaterThan(0);
  // Nothing changed: nothing is written.
  expect(publishObserved(owner.db)).toBe(0);

  // The other thread's memory is empty (here: this one's, wiped), then adopts.
  wipe(reader.db, repoId);
  noteHeld(reader.db, new Map());
  expect(hotFiles(repoId).size).toBe(0);
  expect(conflictedPulls(reader.db)).toEqual([]);
  expect(adoptObserved(reader.db)).toBeGreaterThan(0);
  expect([...hotFiles(repoId)]).toEqual(before.hot);
  expect(warmFiles()).toEqual(before.warm);
  expect(sampleTimes(repoId)).toEqual(before.times);
  expect(conflictedPulls(reader.db)).toEqual(before.waiting);
  expect([...heldRuns(reader.db)]).toEqual(before.held);
  expect(standingHot(repoId)).toEqual(before.standing);
  expect(adoptObserved(reader.db)).toBe(0);
});

test("a change is one row, and a thing that is gone is a row gone", async () => {
  const owner = await forge();
  const reader = await forge(owner.config.dataDir);
  rememberPullFiles("rA", [{ number: 1, files: ["x.ts"] }]);
  rememberPullFiles("rB", [{ number: 1, files: ["y.ts"] }]);
  publishObserved(owner.db);
  rememberPullFiles("rA", [{ number: 1, files: ["x.ts", "z.ts"] }]);
  expect(publishObserved(owner.db)).toBe(1);
  const rows = (): number => owner.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM engine_observation WHERE kind = 'touched' AND scope IN ('rA', 'rB')").get()!.n;
  expect(rows()).toBe(2);
  adoptTouched("rB", undefined);
  expect(publishObserved(owner.db)).toBe(1);
  expect(rows()).toBe(1);
  // The reader loses what the owner lost.
  adoptObserved(reader.db);
  expect(warmFiles().some((w) => w.repoId === "rB")).toBe(false);
  adoptTouched("rA", undefined);
  publishObserved(owner.db);
  expect(rows()).toBe(0);
});
