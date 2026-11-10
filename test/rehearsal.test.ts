/**
 * The roll rehearsal (#873): its plain parts. The two short real rolls of
 * two forge processes on one data directory are `rehearsal-real.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import {
  count,
  DEFAULTS,
  emptyTally,
  isRefusal,
  judge,
  missLine,
  parseArgs,
  refusals,
  report,
  Rotation,
  SILENT_PROBES_TO_LEAVE,
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

  test("a silent probe is a busy machine: a member leaves only after three in a row (#2453)", () => {
    const r = new Rotation<string>();
    r.saw("old", "ready");
    for (let i = 1; i < SILENT_PROBES_TO_LEAVE; i++) r.saw("old", "silent");
    r.saw("old", "ready");
    for (let i = 1; i < SILENT_PROBES_TO_LEAVE; i++) r.saw("old", "silent");
    expect(r.has("old")).toBe(true);
    r.saw("old", "silent");
    expect(r.has("old")).toBe(false);
    // Silence never lets anyone in; a not-ready answer sends a member out at once.
    r.saw("new", "silent");
    expect(r.has("new")).toBe(false);
    r.saw("new", "ready");
    r.saw("new", "not-ready");
    expect(r.has("new")).toBe(false);
  });
});

describe("the verdict", () => {
  const rolled = { newInRotationMs: 3000, oldOutOfRotationMs: 1000, oldExitMs: 10_000 };

  test("a 5xx, a refused connection and nobody in rotation are refusals; a 4xx or redirect is not", () => {
    expect([500, 502, 503, "refused", "nobody"].every((o) => isRefusal(o as never))).toBe(true);
    expect([200, 302, 404].some((o) => isRefusal(o))).toBe(false);
  });

  test("a slow answer is not a refusal, but every miss is kept with its moment", () => {
    expect(isRefusal("slow")).toBe(false);
    const t = emptyTally();
    const at = { atMs: 1234, code: "TimeoutError", forges: { old: "draining", new: "serving" } };
    count(t, "old", 200, at);
    count(t, "new", "slow", at);
    count(t, null, "nobody", { ...at, code: null });
    expect(refusals(t)).toBe(1);
    expect(t.misses.map((m) => [m.forge, m.outcome])).toEqual([
      ["new", "slow"],
      [null, "nobody"],
    ]);
    expect(missLine(t.misses[0]!)).toBe(
      "miss       1234 ms new: slow (TimeoutError); old draining, new serving",
    );
    expect(report(judge(t, rolled))).toContain("nobody in rotation: nobody; old draining");
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
