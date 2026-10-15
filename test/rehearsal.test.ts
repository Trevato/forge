/**
 * The roll rehearsal (#873): its plain parts, and two short real rolls of
 * two forge processes on one data directory. A forge that exits the moment
 * it is signalled refuses the requests routers still send it; one that
 * lingers past a probe period refuses none.
 */

import { describe, expect, test } from "bun:test";
import { rehearse } from "../scripts/rehearse-roll.ts";
import {
  count,
  DEFAULTS,
  emptyTally,
  isRefusal,
  judge,
  parseArgs,
  refusals,
  report,
  Rotation,
  type RehearsalArgs,
} from "../scripts/rehearsal.ts";

describe("arguments", () => {
  test("defaults roll this checkout onto itself, a minute long, at the chart's probe period", () => {
    const a = parseArgs([], "/here");
    expect(a).toEqual({
      from: null,
      old: "/here",
      next: "/here",
      seconds: 60,
      probeMs: 5000,
      lingerS: 10,
      concurrency: 4,
      paths: [...DEFAULTS.paths],
      json: false,
    });
  });

  test("each flag is read once and checked", () => {
    const a = parseArgs(
      ["--from", "/snap", "--old", "/v1", "--new", "/v2", "--seconds", "5", "--paths", "/,/x", "--json"],
      "/here",
    );
    expect([a.from, a.old, a.next, a.seconds, a.paths, a.json]).toEqual([
      "/snap",
      "/v1",
      "/v2",
      5,
      ["/", "/x"],
      true,
    ]);
    expect(() => parseArgs(["--seconds", "1"], "/")).toThrow("--seconds is 2 to 3600");
    expect(() => parseArgs(["--linger", "1.5"], "/")).toThrow("whole number");
    expect(() => parseArgs(["--paths", "http://elsewhere/"], "/")).toThrow("not a plain path");
    expect(() => parseArgs(["--seconds", "3", "--seconds", "4"], "/")).toThrow("given twice");
    expect(() => parseArgs(["--evil"], "/")).toThrow("unknown argument");
    expect(() => parseArgs(["--from"], "/")).toThrow("wants a value");
  });
});

describe("rotation", () => {
  test("a forge joins on a ready probe, leaves on a not-ready one, and is asked in turn", () => {
    const r = new Rotation<string>();
    expect(r.next()).toBeNull();
    r.saw("old", true);
    r.saw("old", true);
    expect([r.next(), r.next()]).toEqual(["old", "old"]);
    r.saw("new", true);
    expect(new Set([r.next(), r.next()])).toEqual(new Set(["old", "new"]));
    r.saw("old", false);
    expect([r.next(), r.next(), r.has("old")]).toEqual(["new", "new", false]);
  });
});

describe("the verdict", () => {
  const rolled = { newInRotationMs: 3000, oldOutOfRotationMs: 1000, oldExitMs: 10_000 };

  test("a 5xx, a refused connection and nobody in rotation are refusals; a 4xx or redirect is not", () => {
    expect([500, 502, 503, "refused", "nobody"].every((o) => isRefusal(o as never))).toBe(true);
    expect([200, 302, 404].some((o) => isRefusal(o))).toBe(false);
  });

  test("zero refused over a roll that happened is a pass", () => {
    const t = emptyTally();
    count(t, "old", 200);
    count(t, "new", 302);
    const v = judge(t, rolled);
    expect(v.ok).toBe(true);
    expect(report(v)).toContain("zero refused: 2 requests");
  });

  test("one refusal fails it, and the report counts it", () => {
    const t = emptyTally();
    count(t, "old", 200);
    count(t, "old", "refused");
    count(t, "new", 503);
    expect(refusals(t)).toBe(2);
    const v = judge(t, rolled);
    expect(v.ok).toBe(false);
    expect(report(v)).toContain("2 of 3 requests refused");
  });

  test("a rehearsal that rolled nothing has no verdict", () => {
    const t = emptyTally();
    count(t, "old", 200);
    expect(judge(t, { ...rolled, newInRotationMs: null }).problem).toBe(
      "the new forge never became ready",
    );
    expect(judge(t, { ...rolled, oldExitMs: null }).ok).toBe(false);
    expect(judge(emptyTally(), rolled).problem).toBe("no request was sent");
  });
});

describe("a real roll of two forge processes on one data directory", () => {
  const short = (lingerS: number): RehearsalArgs => ({
    ...parseArgs([], `${import.meta.dir}/..`),
    seconds: 8,
    probeMs: 300,
    lingerS,
    concurrency: 2,
  });

  test("an old forge that exits on SIGTERM refuses what routers still send it", async () => {
    const v = await rehearse(short(0));
    expect(v.problem).toBeNull();
    expect(v.refused).toBeGreaterThan(0);
    expect(v.tally.byOutcome["refused"]).toBeGreaterThan(0);
  }, 60_000);

  test("an old forge that lingers past a probe period refuses nobody", async () => {
    const v = await rehearse(short(2));
    expect(v.problem).toBeNull();
    expect(v.refused).toBe(0);
    expect(v.tally.byForge["old"]).toBeGreaterThan(0);
    expect(v.tally.byForge["new"]).toBeGreaterThan(0);
    // It lingered: the old forge left rotation before it stopped answering.
    expect(v.timeline.oldExitMs).toBeGreaterThanOrEqual(2000);
    expect(v.timeline.oldOutOfRotationMs).toBeLessThan(v.timeline.oldExitMs ?? 0);
  }, 60_000);
});
