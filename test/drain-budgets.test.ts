import { expect, test } from "bun:test";
import { drainBudgets } from "../src/drain.ts";

test("a roll's drain defaults to ten seconds for checks and for the crew", () => {
  expect(drainBudgets({})).toEqual({ checksMs: 10_000, crewMs: 10_000 });
});

test("each variable overrides its own budget", () => {
  expect(drainBudgets({ FORGE_CHECKS_DRAIN_S: "660" })).toEqual({ checksMs: 660_000, crewMs: 10_000 });
  expect(drainBudgets({ FORGE_CREW_DRAIN_S: "30" })).toEqual({ checksMs: 10_000, crewMs: 30_000 });
});

test("junk falls back to the default", () => {
  for (const junk of ["", "abc", "-5", "0", "0.4", "NaN", "Infinity"])
    expect(drainBudgets({ FORGE_CHECKS_DRAIN_S: junk, FORGE_CREW_DRAIN_S: junk })).toEqual({
      checksMs: 10_000,
      crewMs: 10_000,
    });
});
