import { describe, expect, test } from "bun:test";
import { checkOnApproval } from "../src/checks/approval.ts";
import type { Run } from "../src/core/runs.ts";

const run = (over: Partial<Run>): Run =>
  ({
    id: "r",
    kind: "check",
    env: "pull-7",
    state: "ok",
    baseOid: "base1",
    ...over,
  }) as Run;

describe("checkOnApproval: an approval checks a head again only when it says something new (#4391)", () => {
  test("a head never checked is checked when approved", () => {
    expect(checkOnApproval([], "pull-7", "base1", true)).toBe(true);
    expect(checkOnApproval([], "pull-7", "base1", false)).toBe(true);
  });

  test("a head with only a red, a cancelled or another environment's green is checked", () => {
    const runs = [
      run({ state: "failed" }),
      run({ state: "cancelled" }),
      run({ env: "pull-8" }),
      run({ kind: "deploy" }),
    ];
    expect(checkOnApproval(runs, "pull-7", "base1", true)).toBe(true);
  });

  test("a green head on an unmoved base is not checked again", () => {
    expect(checkOnApproval([run({})], "pull-7", "base1", false)).toBe(false);
  });

  test("a green head on a moved base is checked again where nothing gates the land", () => {
    expect(checkOnApproval([run({})], "pull-7", "base2", false)).toBe(true);
    expect(checkOnApproval([run({ baseOid: "" })], "pull-7", "base2", false)).toBe(true);
  });

  test("a green head on a moved base is not checked again where the land gates on today's base", () => {
    expect(checkOnApproval([run({})], "pull-7", "base2", true)).toBe(false);
  });

  test("an unreadable base is no reason to check a green head again", () => {
    expect(checkOnApproval([run({})], "pull-7", undefined, false)).toBe(false);
  });
});
