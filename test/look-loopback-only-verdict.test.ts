/**
 * The decision behind test/look-loopback-only.test.ts (#10680), without
 * spawning Chrome: in the forge's check a missing prerequisite fails and
 * names itself; outside it the same gap skips with the reason.
 */
import { describe, expect, test } from "bun:test";
import { verdict } from "./look-loopback-only.verdict.ts";

describe("loopback-only look verdict", () => {
  test("in the check, a missing prerequisite fails and names it", () => {
    expect(verdict("no Chromium found", { FORGE_CHECK: "01abc" })).toEqual({
      kind: "fail",
      line: "loopback-only look: failed in the check, no Chromium found",
    });
    expect(verdict("unshare is not installed", { FORGE_CHECK: "01abc" }).kind).toBe("fail");
  });

  test("outside the check, a missing prerequisite skips with the reason", () => {
    expect(verdict("no Chromium found", {})).toEqual({
      kind: "skip",
      line: "loopback-only look: skipped, no Chromium found",
    });
    expect(verdict("cannot make a network namespace: denied", { FORGE_CHECK: "" }).kind).toBe("skip");
  });

  test("nothing missing runs, in the check or not", () => {
    expect(verdict(undefined, { FORGE_CHECK: "01abc" })).toEqual({ kind: "run" });
    expect(verdict(undefined, {})).toEqual({ kind: "run" });
  });
});
