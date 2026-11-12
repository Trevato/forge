/** The one sentence that says which named teams a pull waits on (#10079). */
import { expect, test } from "bun:test";
import { waitingOnTeams } from "../src/core/teams_words.ts";

test("no team holding says nothing", () => {
  expect(waitingOnTeams([])).toBe("");
});

test("one team: its review", () => {
  expect(waitingOnTeams(["Design"])).toBe("Waiting on Design's review");
});

test("two teams: both, joined with and, and reviews in the plural", () => {
  expect(waitingOnTeams(["Design", "Data science"])).toBe(
    "Waiting on Design's and Data science's reviews",
  );
});

test("names are passed through as plain text, not escaped here", () => {
  expect(waitingOnTeams(["<R&D>"])).toBe("Waiting on <R&D>'s review");
});
