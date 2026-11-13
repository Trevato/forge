/** The "release tick quiet" alarm (#11890): no heartbeat from the release tick for 60 min fires one alarm; a fresh beat clears it. */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { releaseQuietAlarm } from "../src/flow/alarm_release_quiet.ts";
import { firedAlarms } from "../src/flow/alarms.ts";
import { recordBeat } from "../src/keeper/beat.ts";
import { recordCut } from "../src/keeper/record.ts";

const NOW = new Date("2026-11-12T12:00:00.000Z");
const minAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
const fresh = () => createApp({ dataDir: mkdtempSync(join(tmpdir(), "forge-quiet-")), port: 0 }).db;
const quiet = (db: ReturnType<typeof fresh>) => firedAlarms(db, NOW, { dataDir: null }).filter((a) => a.key === "release_quiet");

describe("release tick quiet alarm", () => {
  test("59 min since the last beat says nothing", () => {
    const db = fresh();
    recordBeat(db, "skipped", "main has not moved", minAgo(59));
    expect(releaseQuietAlarm(db, NOW).fired).toBe(false);
    expect(quiet(db)).toEqual([]);
  });

  test("61 min since the last beat fires one alarm naming when and the outcome", () => {
    const db = fresh();
    recordBeat(db, "skipped", "main has not moved", minAgo(61));
    const a = releaseQuietAlarm(db, NOW);
    expect(a.fired).toBe(true);
    expect(a.since).toBe(minAgo(61).toISOString());
    expect(a.says).toBe("The release tick was last heard from 1 h 1 min ago (skipped); its reason is on /releases.");
    const fired = quiet(db);
    expect(fired).toHaveLength(1);
    expect(fired[0]).toEqual({ key: "release_quiet", says: a.says, since: a.since!, href: "/releases" });
  });

  test("a public-only reader gets the alarm without the reason, which may be private", () => {
    const db = fresh();
    recordBeat(db, "failed", "push to acme/secret-infra refused", minAgo(61));
    const fired = firedAlarms(db, NOW, { dataDir: null, publicOnly: true }).filter((a) => a.key === "release_quiet");
    expect(fired).toHaveLength(1);
    expect(fired[0]!.says).toContain("(failed)");
    expect(fired[0]!.says).not.toContain("secret-infra");
    expect(quiet(db)[0]!.says).not.toContain("secret-infra");
  });

  test("a fresh beat clears it", () => {
    const db = fresh();
    recordBeat(db, "failed", "tag push refused", minAgo(120));
    expect(releaseQuietAlarm(db, NOW).fired).toBe(true);
    recordBeat(db, "cut", "cut v1.2.3", minAgo(1));
    expect(releaseQuietAlarm(db, NOW).fired).toBe(false);
    expect(quiet(db)).toEqual([]);
  });

  test("never a beat on a forge that has never released says nothing", () => {
    expect(releaseQuietAlarm(fresh(), NOW).fired).toBe(false);
  });

  test("never a beat on a forge that has released fires, counted from the newest cut", () => {
    const db = fresh();
    recordCut(db, { version: "v1.0.0", sha: "a".repeat(40), knownGood: { version: "v0.9.0", image: "img:0.9" }, at: minAgo(30).getTime() });
    expect(releaseQuietAlarm(db, NOW).fired).toBe(false);
    const later = new Date(NOW.getTime() + 31 * 60_000);
    const a = releaseQuietAlarm(db, later);
    expect(a.fired).toBe(true);
    expect(a.since).toBe(minAgo(30).toISOString());
    expect(a.says).toBe("The release tick has never been heard from: no heartbeat since the last release was cut 1 h 1 min ago.");
  });
});
