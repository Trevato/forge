import { expect, test } from "bun:test";
import { heldPostsJs, newPostIds, newPostsLabel } from "../src/web/studio/held_posts.ts";

const js = new Function(`${heldPostsJs}; return { newPostIds, newPostsLabel };`)() as {
  newPostIds: typeof newPostIds;
  newPostsLabel: typeof newPostsLabel;
};

const cases: [string[], string[], string[]][] = [
  [["a", "b"], ["a", "b"], []],
  [["a", "b"], ["x", "y", "z", "a", "b"], ["x", "y", "z"]],
  [["a", "b", "c"], ["d", "a", "c"], ["d"]],
  [["a"], ["b", "b", "a", "c", "b", "c"], ["b", "c"]],
  [[], [], []],
  [["__proto__"], ["__proto__", "constructor", "$a"], ["constructor", "$a"]],
];

test("newPostIds: none new, three on top, one removed and one added, duplicates", () => {
  for (const [shown, fresh, want] of cases) {
    expect(newPostIds(shown, fresh)).toEqual(want);
    expect(js.newPostIds(shown, fresh)).toEqual(want);
  }
});

test("newPostsLabel pluralises and is empty for none", () => {
  for (const [n, want] of [[0, ""], [1, "1 new post"], [2, "2 new posts"], [3, "3 new posts"], [-1, ""], [NaN, ""]] as const) {
    expect(newPostsLabel(n)).toBe(want);
    expect(js.newPostsLabel(n)).toBe(want);
  }
});

test("heldPostsJs is small and has no script tag", () => {
  expect(heldPostsJs.replace(/\s+/g, " ").length).toBeLessThan(600);
  expect(heldPostsJs).not.toContain("<script");
});
