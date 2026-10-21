import { describe, expect, test } from "bun:test";
import { anchorKey, hashLine, type ReviewComment } from "../src/core/reviews.ts";
import type { Diff } from "../src/git/diff.ts";
import { renderDiff } from "../src/web/diff-view.ts";

const OLD_NAMES = ["rc-body", "rc-form", "rc-head", "rc-outdated", "rc-resolved-line"];

const diff: Diff = {
  files: [
    {
      status: "modified", oldPath: "a.txt", newPath: "a.txt", path: "a.txt",
      binary: false, additions: 2, deletions: 0, similarity: null,
      hunks: [
        {
          oldStart: 1, oldLines: 0, newStart: 1, newLines: 2, section: "",
          lines: [
            { kind: "add", oldNumber: null, newNumber: 1, content: "alpha", noNewline: false },
            { kind: "add", oldNumber: null, newNumber: 2, content: "beta", noNewline: false },
          ],
        },
      ],
    },
  ],
  additions: 2,
  deletions: 0,
};

const comment = (line: number, body: string, content: string): ReviewComment => ({
  id: `c${line}`, authorName: "alice", body, createdAt: "2026-01-01T00:00:00Z",
  path: "a.txt", line, side: "new", commitOid: "abc", lineHash: hashLine(content),
  originAuthor: null,
});

describe("inline review comments use the comment component", () => {
  const out = renderDiff(diff, {
    reviewBase: "/o/r/pulls/1",
    comments: new Map([
      [anchorKey("a.txt", "new", 1), [comment(1, "open **question**", "alpha")]],
      [anchorKey("a.txt", "new", 2), [comment(2, "stale remark", "changed")]],
    ]),
    threads: new Map([
      [anchorKey("a.txt", "new", 2), { anchor: "x", resolvedAt: "2026-01-02T00:00:00Z", resolvedBy: "bob", mayResolve: false }],
    ]),
    active: { path: "a.txt", side: "new", line: 1 },
  }).toString();

  test("none of the retired rc-* names is in the page", () => {
    for (const n of OLD_NAMES) expect(out).not.toContain(n);
  });

  test("no element carries the bare `rc` class", () => {
    const classes = [...out.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1]!.split(/\s+/));
    expect(classes).not.toContain("rc");
  });

  test("the text, the outdated mark, the resolved line and the reply form are", () => {
    expect(out).toContain("<strong>question</strong>");
    expect(out).toContain("stale remark");
    expect(out).toContain('class="card comment');
    expect(out).toContain("outdated");
    expect(out).toContain("resolved");
    expect(out).toContain('action="/o/r/pulls/1/review"');
    expect(out).toContain('name="body"');
    expect(out).toContain("data-submit-key"); // Ctrl-Enter sends it
  });
});
