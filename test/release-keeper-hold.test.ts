// A failed verify holds further cuts until a pull naming the cause lands and a verified release lifts it;
// an owner's hold is set and lifted by an admin, never an agent (#7557).
import { describe, expect, test } from "bun:test";
import type { Ctx } from "../src/http/context.ts";
import { tool as holdTool } from "../src/http/mcp/tools/release_hold.ts";
import { tool as keeperTool } from "../src/http/mcp/tools/release_keeper.ts";
import { blocking, names, setHold, standingHolds, type Hold } from "../src/keeper/hold.ts";
import { tick } from "../src/keeper/keeper.ts";
import { listKeeperReleases } from "../src/keeper/record.ts";
import { keeperPanel } from "../src/web/pages/keeper-panel.ts";
import { keeperForge } from "./helpers/keeper.ts";

/** A forge whose 0.7.284 failed its verify and was rolled back to 0.7.283. */
async function heldForge() {
  const f = await keeperForge();
  await tick(f.ports);
  f.world.live = "0.7.284";
  f.world.healthz = (n) => (n >= 5 ? { status: 503, ms: 2 } : { status: 200, ms: 2 });
  await tick(f.ports);
  f.world.live = "0.7.283";
  f.world.healthz = () => ({ status: 200, ms: 2 });
  f.world.newest = { version: "0.7.284", sha: f.world.main };
  f.world.main = "e".repeat(40);
  f.world.now += 3_600_000;
  return f;
}

describe("a failed verify's hold", () => {
  test("names the version and the probe numbers, and blocks the next cut", async () => {
    const f = await heldForge();
    const [h] = standingHolds(f.app.db);
    expect(h).toMatchObject({ kind: "failed", version: "0.7.284", probes: 8, badInRow: 3, causePull: null });
    expect(await tick(f.ports)).toBe(`held: 0.7.284 failed its verify (${h!.reason}); waiting for a pull saying "release hold ${h!.id}" to land`);
  });

  test("a pull that does not name it changes nothing; one that does lets the fix through, and its verify lifts the hold", async () => {
    const f = await heldForge();
    const [h] = standingHolds(f.app.db);
    f.land(10, "Tidy the explore page");
    expect(await tick(f.ports)).toContain("held:");
    // A changelog or a revert note mentions the version; that is no cause.
    f.land(12, "Changelog for 0.7.284", "Reverts the 0.7.284 notes.");
    expect(await tick(f.ports)).toContain("held:");
    expect(standingHolds(f.app.db)[0]!.causePull).toBeNull();
    f.land(11, "Fix the boot stall that sank 0.7.284", `Closes release hold ${h!.id}.`);
    const line = await tick(f.ports);
    expect(line).toContain("cut 0.7.285");
    expect(standingHolds(f.app.db)[0]!.causePull).toBe(11);
    // Not lifted yet: only a verified release lifts it.
    expect(standingHolds(f.app.db)).toHaveLength(1);
    f.world.live = "0.7.285";
    expect(await tick(f.ports)).toContain("0.7.285 verified live");
    expect(standingHolds(f.app.db)).toHaveLength(0);
    expect(listKeeperReleases(f.app.db).map((r) => [r.version, r.stage])).toEqual([["0.7.285", "verified"], ["0.7.284", "rolled_back"]]);
    expect(f.events("release.verified_live")[0]).toMatchObject({ version: "0.7.285", holdsLifted: 1 });
  });

  test("only `release hold N` names the cause: not the bare version, not another hold's number", () => {
    const h = { id: 4, version: "0.7.284" } as Hold;
    expect(names(h, "Fixes release hold #4")).toBe(true);
    expect(names(h, "release hold 4")).toBe(true);
    expect(names(h, "release hold 41")).toBe(false);
    expect(names(h, "after 0.7.2840")).toBe(false);
    expect(names(h, "after 10.7.284")).toBe(false);
    expect(names(h, "0.7.284 hung at boot")).toBe(false);
    expect(names(h, "prerelease hold 4")).toBe(false);
  });

  test("the /releases panel says what holds the next cut, with the numbers", async () => {
    const f = await heldForge();
    const out = String(keeperPanel(f.app.db));
    expect(out).toContain("0.7.284 failed its verify");
    expect(out).toContain("rolled back");
    expect(out).toContain("0.7.283");
  });
});

describe("an owner's hold", () => {
  test("an admin sets it with a reason through MCP; the keeper cuts nothing; only an admin lifts it", async () => {
    const f = await keeperForge();
    const ctx = { app: f.app } as unknown as Ctx;
    const set = await holdTool.run(ctx, f.user, { reason: "freeze for the launch demo" });
    expect(set.ok).toBe(true);
    expect(await tick(f.ports)).toBe("held: the owner holds releases: freeze for the launch demo");
    expect(f.world.tags).toHaveLength(0);
    const read = await keeperTool.run(ctx, f.user, {});
    expect(read.ok && (read.value as { blocked: string }).blocked).toBe("the owner holds releases: freeze for the launch demo");
    const agent = { ...f.user, kind: "agent" as const };
    expect((await holdTool.run(ctx, agent, { lift: 1 })).ok).toBe(false);
    expect((await holdTool.run(ctx, f.user, { lift: 1 })).ok).toBe(true);
    expect(blocking(standingHolds(f.app.db))).toBeUndefined();
    expect(await tick(f.ports)).toContain("cut 0.7.284");
  });

  test("an agent cannot set one, and a failed verify's hold is not lifted by hand", async () => {
    const f = await keeperForge();
    const ctx = { app: f.app } as unknown as Ctx;
    expect((await holdTool.run(ctx, { ...f.user, kind: "agent" as const }, { reason: "stop" })).ok).toBe(false);
    const h = setHold(f.app.db, { kind: "failed", version: "0.7.284", reason: "3 bad", at: f.world.now });
    const tried = await holdTool.run(ctx, f.user, { lift: h.id });
    expect(tried.ok).toBe(false);
    expect(standingHolds(f.app.db)).toHaveLength(1);
    expect((await holdTool.run(ctx, f.user, { reason: "" })).ok).toBe(false);
  });
});
