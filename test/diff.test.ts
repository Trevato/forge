import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  diffCommit,
  diffRange,
  parseUnifiedDiff,
  type Diff,
  type DiffLine,
  type FileDiff,
  type Hunk,
} from "../src/git/diff.ts";
import { initBareRepo, repoDir } from "../src/git/repos.ts";
import { unwrap } from "../src/kernel/result.ts";
import { anchorKey, type ReviewComment } from "../src/core/reviews.ts";
import {
  MAX_DIFF_FILES,
  MAX_FILE_BYTES,
  MAX_LINE_WIDTH,
  renderDiff,
  stubFor,
  type DiffViewOptions,
} from "../src/web/diff-view.ts";
import { gitClientEnv } from "./helpers/git-client.ts";

const env = gitClientEnv({
  GIT_AUTHOR_NAME: "D",
  GIT_AUTHOR_EMAIL: "d@f.dev",
  GIT_COMMITTER_NAME: "D",
  GIT_COMMITTER_EMAIL: "d@f.dev",
});

async function sh(args: string[], cwd: string): Promise<string> {
  const p = Bun.spawn(args, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [out, errText, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  if (code !== 0) throw new Error(`${args.join(" ")}: ${errText}`);
  return out.trim();
}

describe("parseUnifiedDiff (pure)", () => {
  test("a simple modification with line numbers", () => {
    const raw = `diff --git a/file.txt b/file.txt
index 1111111..2222222 100644
--- a/file.txt
+++ b/file.txt
@@ -1,3 +1,3 @@ fn context
 one
-two
+TWO
 three
`;
    const diff = parseUnifiedDiff(raw);
    expect(diff.files).toHaveLength(1);
    const f = diff.files[0]!;
    expect(f.status).toBe("modified");
    expect(f.path).toBe("file.txt");
    expect(f.additions).toBe(1);
    expect(f.deletions).toBe(1);
    const rows = f.hunks[0]!.lines;
    expect(f.hunks[0]!.section).toBe("fn context");
    expect(rows.map((r) => r.kind)).toEqual([
      "context",
      "del",
      "add",
      "context",
    ]);
    // context "one" is old 1 / new 1; del "two" is old 2 / null; add "TWO" is null / new 2
    expect(rows[0]).toMatchObject({ oldNumber: 1, newNumber: 1 });
    expect(rows[1]).toMatchObject({
      kind: "del",
      oldNumber: 2,
      newNumber: null,
    });
    expect(rows[2]).toMatchObject({
      kind: "add",
      oldNumber: null,
      newNumber: 2,
    });
    expect(rows[3]).toMatchObject({ oldNumber: 3, newNumber: 3 });
  });

  test("added and deleted files", () => {
    const raw = `diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..abcdefg
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+alpha
+beta
diff --git a/gone.txt b/gone.txt
deleted file mode 100644
index abcdefg..0000000
--- a/gone.txt
+++ /dev/null
@@ -1,1 +0,0 @@
-old content
`;
    const diff = parseUnifiedDiff(raw);
    expect(diff.files).toHaveLength(2);
    expect(diff.files[0]).toMatchObject({
      status: "added",
      oldPath: null,
      newPath: "new.txt",
      additions: 2,
    });
    expect(diff.files[1]).toMatchObject({
      status: "deleted",
      newPath: null,
      oldPath: "gone.txt",
      deletions: 1,
    });
  });

  test("rename with similarity, binary, and no-newline marker", () => {
    const raw = `diff --git a/old.txt b/new.txt
similarity index 88%
rename from old.txt
rename to new.txt
index 1111111..2222222 100644
--- a/old.txt
+++ b/new.txt
@@ -1,2 +1,2 @@
 keep
-drop
\\ No newline at end of file
+kept
\\ No newline at end of file
diff --git a/logo.png b/logo.png
index 3333333..4444444 100644
Binary files a/logo.png and b/logo.png differ
`;
    const diff = parseUnifiedDiff(raw);
    const renamed = diff.files[0]!;
    expect(renamed.status).toBe("renamed");
    expect(renamed.oldPath).toBe("old.txt");
    expect(renamed.newPath).toBe("new.txt");
    expect(renamed.similarity).toBe(88);
    expect(renamed.hunks[0]!.lines.some((l) => l.noNewline)).toBe(true);
    expect(diff.files[1]).toMatchObject({ binary: true, path: "logo.png" });
  });

  test("a path with spaces survives the header split", () => {
    const raw = `diff --git a/my file.txt b/my file.txt
index 1111111..2222222 100644
--- a/my file.txt
+++ b/my file.txt
@@ -1 +1 @@
-a
+b
`;
    const diff = parseUnifiedDiff(raw);
    expect(diff.files[0]!.path).toBe("my file.txt");
  });
});

describe("diff against real git", () => {
  let root: string;
  let dir: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "forge-diff-"));
    dir = repoDir(root, "d", "r");
    unwrap(await initBareRepo(dir));
    // Build history in a working clone, push into the bare repo.
    const work = join(root, "work");
    await sh(["git", "clone", dir, work], root);
    await Bun.write(join(work, "a.txt"), "one\ntwo\nthree\n");
    await Bun.write(join(work, "keep.txt"), "static\n");
    await sh(["git", "add", "."], work);
    await sh(["git", "commit", "-m", "first"], work);
    await Bun.write(join(work, "a.txt"), "one\nTWO\nthree\nfour\n");
    await sh(["git", "add", "."], work);
    await sh(["git", "commit", "-m", "second"], work);
    await sh(["git", "push", "origin", "HEAD:refs/heads/main"], work);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("diffCommit on the tip shows the real change", async () => {
    const head = await sh(["git", "rev-parse", "main"], dir);
    const diff = unwrap(await diffCommit(dir, head));
    const a = diff.files.find((f) => f.path === "a.txt")!;
    expect(a.status).toBe("modified");
    expect(a.additions).toBe(2); // TWO + four
    expect(a.deletions).toBe(1); // two
  });

  test("diffRange from root shows the whole tree as added", async () => {
    const head = await sh(["git", "rev-parse", "main"], dir);
    const first = await sh(["git", "rev-parse", "main~1"], dir);
    const diff = unwrap(await diffRange(dir, first, head));
    expect(diff.files.map((f) => f.path).sort()).toEqual(["a.txt"]);
  });

  test("unsafe revs are refused, not executed", async () => {
    // The file git would write if the rev reached it as an option: a path
    // of this test's own, so nothing else can make it exist.
    const canary = join(root, "written-by-git");
    const bad = await diffRange(dir, `--output=${canary}`, "main");
    expect(bad.ok).toBe(false);
    expect(existsSync(canary)).toBe(false);
  });
});

// ---- the diff view's render budget (src/web/diff-view.ts), pure and fast:
// no git, no server, just FileDiff fixtures built by hand.
describe("renderDiff stub budget (the view, not the engine)", () => {
  function row(
    kind: DiffLine["kind"],
    oldNumber: number | null,
    newNumber: number | null,
    content: string,
  ): DiffLine {
    return { kind, oldNumber, newNumber, content, noNewline: false };
  }

  function hunk(lines: DiffLine[]): Hunk {
    return {
      oldStart: 1,
      oldLines: lines.filter((l) => l.kind !== "add").length,
      newStart: 1,
      newLines: lines.filter((l) => l.kind !== "del").length,
      section: "",
      lines,
    };
  }

  function file(path: string, hunks: Hunk[]): FileDiff {
    const lines = hunks.flatMap((h) => h.lines);
    return {
      status: "modified",
      oldPath: path,
      newPath: path,
      path,
      binary: false,
      additions: lines.filter((l) => l.kind === "add").length,
      deletions: lines.filter((l) => l.kind === "del").length,
      similarity: null,
      hunks,
    };
  }

  function oneFile(f: FileDiff): Diff {
    return { files: [f], additions: f.additions, deletions: f.deletions };
  }

  function many(n: number): Diff {
    const files = Array.from({ length: n }, (_, i) => file(`f${i}.txt`, []));
    return { files, additions: 0, deletions: 0 };
  }

  test("a cut diff says so in one muted line, not a card", () => {
    const out = renderDiff(many(MAX_DIFF_FILES + 1200)).toString();
    expect(out).toMatch(
      /<p class="muted small">\s*1,200 more files not\s+shown\./,
    );
    expect(out).not.toContain("card diff-note");
    const one = renderDiff(many(MAX_DIFF_FILES + 1)).toString();
    expect(one).toMatch(/1 more file not\s+shown\./);
  });

  test("a normal small file renders its hunk, not a stub", () => {
    const f = file("small.txt", [
      hunk([
        row("context", 1, 1, "one"),
        row("del", 2, null, "two"),
        row("add", null, 2, "TWO"),
      ]),
    ]);
    expect(stubFor(f)).toBeNull();
    const out = renderDiff(oneFile(f)).toString();
    expect(out).toContain("small.txt");
    expect(out).toContain("diff-table");
    expect(out).not.toContain("Diff not shown");
  });

  test("one line wider than MAX_LINE_WIDTH is stubbed even though the file is tiny", () => {
    const wide = "x".repeat(MAX_LINE_WIDTH + 500);
    const f = file("bundle.min.js", [hunk([row("add", null, 1, wide)])]);
    expect(stubFor(f)?.reason).toContain("characters wide");
    const out = renderDiff(oneFile(f)).toString();
    expect(out).toContain("bundle.min.js"); // path
    expect(out).toContain("Diff not shown"); // why
    expect(out).toContain("characters wide");
    expect(out).toContain("+1"); // the real counts, not hidden
    expect(out).not.toContain(wide); // no hunks in the HTML
  });

  test("a file over MAX_FILE_BYTES is stubbed even with only a handful of lines", () => {
    const lines = Array.from({ length: 10 }, (_, i) =>
      row("add", null, i + 1, "y".repeat(Math.ceil(MAX_FILE_BYTES / 5))),
    );
    const f = file("data.json", [hunk(lines)]);
    expect(stubFor(f)?.reason).toContain("bytes of diff");
    const out = renderDiff(oneFile(f)).toString();
    expect(out).toContain("Diff not shown");
    expect(out).toContain("bytes of diff");
  });

  test("a stubbed file with an existing review comment renders in full instead", () => {
    const wide = "x".repeat(MAX_LINE_WIDTH + 500);
    const f = file("bundle.min.js", [hunk([row("add", null, 1, wide)])]);
    const comments = new Map<string, ReviewComment[]>([
      [anchorKey("bundle.min.js", "new", 1), []],
    ]);
    const opts: DiffViewOptions = { comments };
    const out = renderDiff(oneFile(f), opts).toString();
    expect(out).toContain("diff-table");
    expect(out).not.toContain("Diff not shown");
  });

  test("the stub links to the file at that commit when fileLinkBase is set", () => {
    const wide = "x".repeat(MAX_LINE_WIDTH + 500);
    const f = file("bundle.min.js", [hunk([row("add", null, 1, wide)])]);
    const opts: DiffViewOptions = { fileLinkBase: "/o/r/blob/deadbeef" };
    const out = renderDiff(oneFile(f), opts).toString();
    expect(out).toContain('href="/o/r/blob/deadbeef/bundle.min.js"');
  });

  test("no fileLinkBase means no link, not a crash", () => {
    const wide = "x".repeat(MAX_LINE_WIDTH + 500);
    const f = file("bundle.min.js", [hunk([row("add", null, 1, wide)])]);
    const out = renderDiff(oneFile(f)).toString();
    expect(out).toContain("Diff not shown");
    expect(out).not.toContain("View file");
  });
});

describe("renderDiff with no files", () => {
  test("says No changes. in a plain empty block, not a card", () => {
    const out = renderDiff({
      files: [],
      additions: 0,
      deletions: 0,
    } as Diff).toString();
    expect(out).toContain("No changes.");
    expect(out).toContain('<p class="empty-title">No changes.</p>');
    expect(out).not.toMatch(/class="[^"]*\bcard\b/);
  });
});
