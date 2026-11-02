import { expect, test } from "bun:test";
import { parseRepoRef } from "../src/cli/args.ts";

test("owner/name is accepted, surrounding whitespace trimmed", () => {
  expect(parseRepoRef("a/b")).toEqual({ owner: "a", name: "b" });
  expect(parseRepoRef(" a/b ")).toEqual({ owner: "a", name: "b" });
});

test("empty segments and wrong part counts are refused, not repaired", () => {
  for (const bad of ["a//b", "/a/b", "a/b/", "a", "a/b/c", "/", ""]) {
    expect(parseRepoRef(bad)).toBeUndefined();
  }
  expect(parseRepoRef(undefined)).toBeUndefined();
});
