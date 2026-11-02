/** `readConflictedFiles` against a real two-sided change in a temp repository. */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConflictedFile, readConflictedFiles } from "../src/git/conflict-file.ts";
import { gitClientEnv } from "./helpers/git-client.ts";

const IDENTITY = {
  GIT_AUTHOR_NAME: "Ada",
  GIT_AUTHOR_EMAIL: "ada@forge.local",
  GIT_COMMITTER_NAME: "Ada",
  GIT_COMMITTER_EMAIL: "ada@forge.local",
};

async function sh(args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    env: gitClientEnv(IDENTITY),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
  return out.trim();
}

let root = "";
let ours = "";
let theirs = "";

async function commit(msg: string, files: Record<string, string>) {
  for (const [name, text] of Object.entries(files)) await writeFile(join(root, name), text);
  await sh(["add", "-A"], root);
  await sh(["commit", "-m", msg], root);
  return sh(["rev-parse", "HEAD"], root);
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "conflict-file-"));
  await sh(["init", "-q", "-b", "main"], root);
  const base = await commit("base", {
    "a.txt": "one\nshared\nthree\n",
    "b.txt": "top\nmiddle\nbottom\n",
    "big.txt": "x\n",
  });
  await sh(["checkout", "-q", "-b", "other", base], root);
  theirs = await commit("theirs", {
    "a.txt": "one\nTHEIRS\nthree\n",
    "b.txt": "top\nmiddle\nbottom\nbottom2\n",
    "big.txt": `${"y".repeat(1_000_001)}\n`,
  });
  await sh(["checkout", "-q", "main"], root);
  ours = await commit("ours", { "a.txt": "one\nOURS\nthree\n" });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

test("a file changed on both sides carries diff3 markers and both sides", async () => {
  const text = await readConflictedFile(root, ours, theirs, "a.txt");
  expect(text).toBeDefined();
  for (const marker of ["<<<<<<<", "|||||||", "=======", ">>>>>>>"]) {
    expect(text).toContain(marker);
  }
  expect(text).toContain("OURS");
  expect(text).toContain("THEIRS");
  expect(text).toContain("shared");
});

test("three paths are answered from one merge: clean merged, missing absent", async () => {
  const got = await readConflictedFiles(root, ours, theirs, ["a.txt", "b.txt", "nope.txt"]);
  expect(got.has("a.txt")).toBe(true);
  expect(got.get("b.txt")).toBe("top\nmiddle\nbottom\nbottom2\n");
  expect(got.has("nope.txt")).toBe(false);
  expect(got.size).toBe(2);
});

test("a file over 1,000,000 bytes is absent, not cut", async () => {
  const got = await readConflictedFiles(root, ours, theirs, ["a.txt", "big.txt"]);
  expect(got.has("big.txt")).toBe(false);
  expect(got.has("a.txt")).toBe(true);
});

test("the merge leaves no ref behind", async () => {
  const before = await sh(["for-each-ref"], root);
  await readConflictedFiles(root, ours, theirs, ["a.txt", "b.txt"]);
  expect(await sh(["for-each-ref"], root)).toBe(before);
});
