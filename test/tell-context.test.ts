import { expect, test } from "bun:test";
import { contextNote, parseContext } from "../src/actions/tell_context.ts";

test("a page told with a #fragment is told without it", () => {
  const c = parseContext({ page: "https://app.example.test/a?b=1#access_token=secret" });
  expect(c).toEqual({ page: "https://app.example.test/a?b=1" });
  expect(contextNote(c ?? undefined)).not.toContain("secret");
});

test("a page without a fragment is kept as it was", () => {
  expect(parseContext({ page: "https://app.example.test/a" })).toEqual({
    page: "https://app.example.test/a",
  });
});
