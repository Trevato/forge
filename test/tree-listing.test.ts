/** A directory listing is §5's rows and card foot, not page-local markup (#4164). */

import { describe, expect, test } from "bun:test";
import { treeListing } from "../src/web/pages/repo.ts";

const entries = [
  { mode: "040000", type: "tree", sha: "a".repeat(40), size: -1, name: "src" },
  { mode: "100644", type: "blob", sha: "b".repeat(40), size: 2048, name: "a<b>.md" },
  { mode: "100644", type: "blob", sha: "c".repeat(40), size: 100, name: "x.ts" },
] as const;

describe("treeListing", () => {
  const out = treeListing("/o/r", "main", "lib", entries as never).text;

  test("the page-local names are gone", () => {
    expect(out).not.toContain("tree-row");
    expect(out).not.toContain("tree-total");
  });

  test("rows, links, sizes and the total are all there", () => {
    expect(out).toContain('class="row"');
    expect(out).toContain('href="/o/r/tree/main/lib/src"');
    expect(out).toContain('href="/o/r/blob/main/lib/x.ts"');
    expect(out).toContain('href="/o/r/tree/main"'); // ..
    expect(out).toContain("a&lt;b&gt;.md");
    expect(out).toContain("row-trail");
    expect(out).toContain('class="card bare"');
    expect(out).toContain('class="card-foot"');
    expect(out).toMatch(/2 files here/);
  });

  test("no files, no foot", () => {
    const none = treeListing("/o/r", "main", "", [entries[0]] as never).text;
    expect(none).not.toContain("card-foot");
    expect(none).toContain('class="card bare"');
  });
});
