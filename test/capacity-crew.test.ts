/**
 * Crew runs at once defaults to what the pod's memory holds (#2548): one run
 * per 3 GiB above the forge's own 2 GiB, at least 2 and at most 16. The
 * environment still wins, then a stored value; the sentinel's
 * away-from-default check compares with this default, so a big machine
 * running its share is not flagged.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import {
  CAPACITY,
  capacityDefault,
  capacityValue,
  crewForMemory,
  memoryLimitBytes,
  setCapacity,
} from "../src/core/capacity.ts";
import { settingsAway } from "../src/crew/sentinel.ts";

const GiB = 1024 ** 3;

describe("crewForMemory", () => {
  test("one run per 3 GiB above 2 GiB, between 2 and 16", () => {
    expect(crewForMemory(4 * GiB)).toBe(2); // (4 − 2) / 3 = 0 → floor of 2
    expect(crewForMemory(32 * GiB)).toBe(10); // (32 − 2) / 3 = 10
    expect(crewForMemory(64 * GiB)).toBe(16); // (64 − 2) / 3 = 20 → ceiling of 16
    expect(crewForMemory(11 * GiB)).toBe(3); // (11 − 2) / 3 = 3
    expect(crewForMemory(GiB)).toBe(2);
    expect(crewForMemory(Number.NaN)).toBe(2);
  });

  test("the capacity page says how the default is reached", () => {
    expect(CAPACITY["crew.concurrency"].help).toContain(
      "Empty: one per 3 GiB of memory above the forge's own 2 GiB",
    );
  });
});

describe("the crew's default, and what overrides it", () => {
  let dataDir: string;
  let app: App;
  let saved: string | undefined;

  beforeEach(async () => {
    saved = process.env.FORGE_CREW_CONCURRENCY;
    delete process.env.FORGE_CREW_CONCURRENCY;
    dataDir = await mkdtemp(join(tmpdir(), "forge-capacity-crew-"));
    app = createApp({ dataDir, port: 0 });
  });
  afterEach(async () => {
    if (saved === undefined) delete process.env.FORGE_CREW_CONCURRENCY;
    else process.env.FORGE_CREW_CONCURRENCY = saved;
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("unset, it is the pod's memory's share", () => {
    expect(capacityDefault("crew.concurrency")).toBe(String(crewForMemory(memoryLimitBytes())));
  });

  test("a set FORGE_CREW_CONCURRENCY wins over memory", () => {
    process.env.FORGE_CREW_CONCURRENCY = "7";
    expect(capacityDefault("crew.concurrency")).toBe("7");
    process.env.FORGE_CREW_CONCURRENCY = "99"; // out of range: ignored
    expect(capacityDefault("crew.concurrency")).toBe(String(crewForMemory(memoryLimitBytes())));
  });

  test("a stored value overrides the default", () => {
    const other = capacityDefault("crew.concurrency") === "5" ? "6" : "5";
    setCapacity(app.db, "crew.concurrency", other, "system");
    expect(capacityValue(app.db, "crew.concurrency")).toBe(other);
    setCapacity(app.db, "crew.concurrency", null, "system");
    expect(capacityValue(app.db, "crew.concurrency")).toBe(capacityDefault("crew.concurrency"));
  });

  test("the sentinel flags a value away from the memory default, not one at it", () => {
    const now = Date.now();
    const age = () =>
      app.db
        .query("UPDATE forge_setting SET updated_at = ?1 WHERE key = 'crew.concurrency'")
        .run(new Date(now - 3 * 86_400_000).toISOString());
    const crew = () => settingsAway(app.db, now).filter((f) => f.key === "setting:crew.concurrency");
    const fallback = capacityDefault("crew.concurrency");
    setCapacity(app.db, "crew.concurrency", fallback, "system");
    age();
    expect(crew()).toEqual([]);
    const other = fallback === "5" ? "6" : "5";
    setCapacity(app.db, "crew.concurrency", other, "system");
    age();
    const found = crew();
    expect(found).toHaveLength(1);
    expect(found[0]!.evidence[0]).toBe(`crew.concurrency = "${other}", default "${fallback}"`);
  });
});
