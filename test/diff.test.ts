import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diffCommit, diffRange, parseUnifiedDiff } from "../src/git/diff.ts";
import { initBareRepo, repoDir } from "../src/git/repos.ts";
import { unwrap } from "../src/kernel/result.ts";

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "D",
  GIT_AUTHOR_EMAIL: "d@f.dev",
  GIT_COMMITTER_NAME: "D",
  GIT_COMMITTER_EMAIL: "d@f.dev",
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

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
    const bad = await diffRange(dir, "--output=/tmp/x", "main");
    expect(bad.ok).toBe(false);
  });
});
