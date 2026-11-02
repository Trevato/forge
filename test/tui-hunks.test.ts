import { expect, test } from "bun:test";
import { parseUnifiedDiff, type FileDiff } from "../src/git/diff.ts";
import {
  HunkList,
  sectionLabel,
  sectionNote,
  type Section,
} from "../src/tui/local/hunks.ts";

/** A one-file unified diff with `n` hunks, parsed by the module's own parser. */
function fileWith(n: number): FileDiff {
  let text = "diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n";
  for (let i = 0; i < n; i++) {
    const at = 1 + i * 20;
    text += `@@ -${at},1 +${at},1 @@\n-old ${i}\n+new ${i}\n`;
  }
  const file = parseUnifiedDiff(text).files[0];
  if (file === undefined) throw new Error("fixture did not parse");
  return file;
}

test("the cursor lands on a hunk that exists when the file shrinks", () => {
  const list = new HunkList();
  list.setFile(fileWith(3));
  expect(list.hunks.length).toBe(3);
  list.select(2);
  expect(list.index).toBe(2);

  const one = fileWith(1);
  list.setFile(one);
  expect(list.index).toBe(0);
  expect(list.current).toBe(one.hunks[0]);
});

test("a null file leaves no hunks and no current", () => {
  const list = new HunkList();
  list.setFile(fileWith(2));
  list.setFile(null);
  expect(list.hunks).toEqual([]);
  expect(list.current).toBeUndefined();
  expect(list.index).toBe(0);
});

test("every section has a label and a note", () => {
  const sections: Section[] = ["staged", "unstaged", "untracked", "conflicted"];
  for (const s of sections) {
    expect(sectionLabel(s).length).toBeGreaterThan(0);
    expect(sectionNote(s).length).toBeGreaterThan(0);
  }
});
