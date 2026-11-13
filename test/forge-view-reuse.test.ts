import { expect, test } from "bun:test";
import { recentView, VIEW_REUSE_MS } from "../src/http/api/forge_view.ts";

test("one reader's picture is built once within the reuse window, and again after it", () => {
  let built = 0;
  const build = () => `picture ${++built}`;
  expect(recentView("reader-a", build, 1_000)).toBe("picture 1");
  expect(recentView("reader-a", build, 1_000 + VIEW_REUSE_MS - 1)).toBe("picture 1");
  expect(recentView("reader-a", build, 1_000 + VIEW_REUSE_MS)).toBe("picture 2");
});

test("another reader never gets this reader's picture", () => {
  const at = 10_000_000;
  expect(recentView("reader-b", () => "b's", at)).toBe("b's");
  expect(recentView("reader-c", () => "c's", at)).toBe("c's");
  expect(recentView("reader-b", () => "new", at + 1)).toBe("b's");
});
