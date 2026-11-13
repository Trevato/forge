// A hotfix does not wait (#11839): `release now` cuts at the next tick past the spacing, the merge queue and a
// snapshot, never past a hold or a full disk; each release says where its time went; the keeper says what holds it.
import { describe, expect, test } from "bun:test";
import type { Ctx } from "../src/http/context.ts";
import { tool as keeperTool } from "../src/http/mcp/tools/release_keeper.ts";
import { tool as nowTool } from "../src/http/mcp/tools/release_now.ts";
import { decideCut, MIN_INTERVAL_MS, type CadenceInput } from "../src/keeper/cadence.ts";
import { setHold } from "../src/keeper/hold.ts";
import { stagesLine, stagesOf } from "../src/keeper/landed.ts";
import { tick } from "../src/keeper/keeper.ts";
import { stepWithBeat } from "../src/keeper/beat.ts";
import { keepTimings, listKeeperReleases } from "../src/keeper/record.ts";
import { pendingNow } from "../src/keeper/now.ts";
import { keeperPanel } from "../src/web/pages/keeper-panel.ts";
import { keeperForge, B, A } from "./helpers/keeper.ts";

const NOW = Date.parse("2026-11-12T12:00:00Z");
const base: CadenceInput = { main: B, newest: { version: "0.7.283", sha: A }, live: "0.7.283", inFlight: false, gating: 0, lastCutAt: NOW - 60_000, hold: undefined, now: NOW };

describe("decideCut with a hotfix", () => {
  test("skips the spacing, the merge queue and a snapshot", () => {
    expect(decideCut({ ...base, gating: 2, snapshotMs: 1000 }).cut).toBe(false);
    expect(decideCut({ ...base, gating: 2, snapshotMs: 1000, hotfix: true })).toEqual({ cut: true, version: "0.7.284" });
    expect(decideCut({ ...base, lastCutAt: NOW - MIN_INTERVAL_MS + 1 }).cut).toBe(false);
    expect(decideCut({ ...base, hotfix: true }).cut).toBe(true);
  });
  test("still stops for a hold, a release in flight and a full disk", () => {
    expect(decideCut({ ...base, hotfix: true, hold: "frozen" })).toMatchObject({ cut: false });
    expect(decideCut({ ...base, hotfix: true, inFlight: true })).toMatchObject({ cut: false });
    expect(decideCut({ ...base, hotfix: true, diskUsed: 0.9 })).toMatchObject({ cut: false });
  });
});

describe("release now", () => {
  test("a person asks, the next tick cuts inside the spacing and the reason stays on the release", async () => {
    const f = await keeperForge();
    const ctx = { app: f.app } as unknown as Ctx;
    f.world.gating = 1;
    expect(await tick(f.ports)).toContain("merge queue");
    const asked = await nowTool.run(ctx, f.user, { reason: "covered pages on phones" });
    expect(asked.ok).toBe(true);
    expect(pendingNow(f.app.db, f.world.now)?.reason).toBe("covered pages on phones");
    expect(await tick(f.ports)).toContain("cut 0.7.284");
    expect(listKeeperReleases(f.app.db)[0]!.hotfix).toBe("covered pages on phones (alice)");
    expect(pendingNow(f.app.db, f.world.now)).toBeUndefined();
  });
  test("an agent, an empty reason and a request that has lapsed cut nothing", async () => {
    const f = await keeperForge();
    const ctx = { app: f.app } as unknown as Ctx;
    expect((await nowTool.run(ctx, { ...f.user, kind: "agent" as const }, { reason: "x" })).ok).toBe(false);
    expect((await nowTool.run(ctx, f.user, { reason: "  " })).ok).toBe(false);
    expect(pendingNow(f.app.db, f.world.now)).toBeUndefined();
    await nowTool.run(ctx, f.user, { reason: "later" });
    expect(pendingNow(f.app.db, Date.now() + 2 * 3_600_000)).toBeUndefined();
  });
  test("a hold still stops it", async () => {
    const f = await keeperForge();
    setHold(f.app.db, { kind: "owner", version: "0.7.283", reason: "launch freeze", at: f.world.now });
    await nowTool.run({ app: f.app } as unknown as Ctx, f.user, { reason: "urgent" });
    expect(await tick(f.ports)).toContain("held:");
  });
});

describe("what release_keeper shows", () => {
  test("stage timings, the request, and what the tick last said held it", async () => {
    const f = await keeperForge();
    const ctx = { app: f.app } as unknown as Ctx;
    f.world.gating = 1;
    await stepWithBeat(f.app.db, async () => ({ line: "the merge queue is landing", outcome: "skipped" }), () => new Date(f.world.now));
    f.world.gating = 0;
    await nowTool.run(ctx, f.user, { reason: "fix" });
    await tick(f.ports);
    const r = listKeeperReleases(f.app.db)[0]!;
    keepTimings(f.app.db, r.id, { buildMs: 4000, proofMs: 3000, switchMs: 900 });
    const answer = await keeperTool.run(ctx, f.user, {});
    expect(answer.ok).toBe(true);
    const data = (answer as unknown as { value: Record<string, any> }).value ?? (answer as any).data ?? answer;
    const rel = JSON.stringify(data);
    expect(rel).toContain('"buildMs":4000');
    expect(rel).toContain('"holding"');
    expect(rel).toContain("the merge queue is landing");
    const html = String(keeperPanel(f.app.db, true, new Date(f.world.now)));
    expect(html).toContain("build 4 s");
    expect(html).toContain("switch 1 s");
    expect(html).toContain("/releases/now");
  });
  test("a stage not measured is left out of the line", () => {
    const s = stagesOf({ cutAt: "2026-11-12T12:00:00Z", liveAt: "2026-11-12T12:01:10Z", finishedAt: "2026-11-12T12:11:10Z", buildMs: null, proofMs: null, switchMs: null });
    expect(stagesLine(s)).toBe("cut→live 1 min 10 s · verify 10 min 0 s");
  });
});
