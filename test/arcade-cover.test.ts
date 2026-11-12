import { expect, test } from "bun:test";
import { COVER_JS } from "../src/arcade/cover.ts";

// Evaluate only coverTitle from the browser string, with no DOM.
const coverTitle = new Function(`${COVER_JS}; return coverTitle;`)() as (
  name: string,
  version: string,
) => { lines: string[]; number: string };

test("splits a hyphenated name into its lines and takes the trailing number", () => {
  expect(coverTitle("space-pong", "0.12.3")).toEqual({ lines: ["space", "pong"], number: "12.3" });
});

test("a version of four characters or fewer is used whole", () => {
  expect(coverTitle("space-pong", "v12").number).toBe("v12");
});

test("a one-word name gives one line", () => {
  expect(coverTitle("pong", "1").lines).toEqual(["pong"]);
});

test("a long version with no trailing number gives an empty number", () => {
  expect(coverTitle("space-pong", "release-candidate").number).toBe("");
});
