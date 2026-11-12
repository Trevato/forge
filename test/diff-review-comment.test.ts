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
    expect(out).toContain('class="comment-row"');
    expect(out).not.toContain('class="card comment');
    expect(out).not.toContain('class="card comment-form');
    expect(out).toContain("outdated");
    expect(out).toContain("resolved");
    expect(out).toContain('action="/o/r/pulls/1/review"');
    expect(out).toContain('name="body"');
    expect(out).toContain("data-submit-key"); // Ctrl-Enter sends it
  });
});

describe("a review thread is a card and its resolve control a button", () => {
  const anchor = anchorKey("a.txt", "new", 1);
  const render = (resolvedAt: string | null) =>
    renderDiff(diff, {
      reviewBase: "/o/r/pulls/1",
      comments: new Map([[anchor, [comment(1, "a point", "alpha")]]]),
      threads: new Map([
        [anchor, { anchor: "x", resolvedAt, resolvedBy: resolvedAt ? "bob" : null, mayResolve: true }],
      ]),
    }).toString();

  test("an open thread is prose with a Resolve button", () => {
    const out = render(null);
    expect(out).toContain('action="/o/r/pulls/1/threads/x/resolve"');
    expect(out).toMatch(/<button[^>]*class="btn"[^>]*>\s*Resolve\s*<\/button>/);
    expect(out).toContain('class="dc-thread"');
    expect(out).not.toContain("card-head");
  });

  test("a resolved thread is one line with an Unresolve button", () => {
    const out = render("2026-01-02T00:00:00Z");
    expect(out).toContain("resolved by");
    expect(out).toContain("resolved");
    expect(out).toContain('action="/o/r/pulls/1/threads/x/unresolve"');
    expect(out).toMatch(/<button[^>]*class="btn"[^>]*>\s*Unresolve\s*<\/button>/);
  });

  test("a resolved thread hides its conversation in a small disclosure", () => {
    const out = render("2026-01-02T00:00:00Z");
    expect(out).toContain('<details class="disclosure">');
    expect(out).toMatch(/<summary class="muted small">\s*Show 1\s+comment\s*<\/summary>/);
    expect(render(null)).not.toContain("disclosure");
  });

  test("neither state carries the retired names", () => {
    for (const out of [render(null), render("2026-01-02T00:00:00Z")]) {
      expect(out).not.toContain("dl-review");
      expect(out).not.toContain("rc-resolve");
    }
  });
});
