/** `parseFrom` and the words limit, in their own module (src/actions/tell_from.ts). */
import { expect, test } from "bun:test";
import { FROM_MAX, parseFrom, TELL_TEXT_MAX } from "../src/actions/tell_from.ts";

test("absent from is none; a same-forge path is kept", () => {
  expect(parseFrom(undefined)).toBeNull();
  expect(parseFrom(null)).toBeNull();
  expect(parseFrom("/alice/notes/pulls/3")).toBe("/alice/notes/pulls/3");
});

test("anything off the forge, odd or too long is refused", () => {
  for (const bad of ["", "alice", "//evil.test/x", "https://x/y", "/a b", "/a\\b", "/a\nb", "/a<b", 5, "/" + "x".repeat(FROM_MAX)])
    expect(parseFrom(bad)).toBeUndefined();
  expect(parseFrom("/" + "x".repeat(FROM_MAX - 1))).toBeDefined();
});

test("a secret in the query is scrubbed, the path and fragment are kept", () => {
  const out = parseFrom("/alice/notes?token=abc123secret&tab=pulls#top");
  expect(out).toStartWith("/alice/notes?");
  expect(out).not.toContain("abc123secret");
  expect(out).toEndWith("#top");
  expect(parseFrom("/alice/notes?tab=pulls")).toBe("/alice/notes?tab=pulls");
});

test("the words limit is the one the doors share", () => {
  expect(TELL_TEXT_MAX).toBe(2000);
});
