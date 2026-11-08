import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeForCheck, NO_MERGE } from "../src/checks/merged.ts";
import { gitClientEnv } from "./helpers/git-client.ts";

const env = gitClientEnv();

async function git(cwd: string, ...args: string[]): Promise<string> {
  const p = Bun.spawn(["git", ...args], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
  return out.trim();
}

const refs = (dir: string) => git(dir, "for-each-ref");

describe("mergeForCheck: the pull as it would land on today's base", () => {
  let root: string;
  let baseDir: string; // the base repository, kept as a work tree
  let pullDir: string; // the pull's own repository (a fork)
  let forkPoint: string;
  let head: string; // the pull's head: edits pull.txt
  let conflicting: string; // edits shared.txt differently from the base
  let baseTip: string; // the base moved ahead: edits base.txt and shared.txt

  async function commit(dir: string, file: string, text: string, msg: string) {
    await writeFile(join(dir, file), text);
    await git(dir, "add", file);
    await git(dir, "commit", "-m", msg);
    return git(dir, "rev-parse", "HEAD");
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "merged-check-"));
    baseDir = join(root, "base");
    pullDir = join(root, "fork");
    await git(root, "init", "-b", "main", baseDir);
    await commit(baseDir, "shared.txt", "one\n", "init");
    await commit(baseDir, "pull.txt", "a\n", "pull file");
    await commit(baseDir, "base.txt", "a\n", "base file");
    forkPoint = await git(baseDir, "rev-parse", "HEAD");

    await git(root, "clone", "--bare", baseDir, pullDir);
    const work = join(root, "work");
    await git(root, "clone", pullDir, work);
    await git(work, "checkout", "-b", "pull");
    head = await commit(work, "pull.txt", "b\n", "pull change\n\nWhy now: the owner asked for it today");
    await git(work, "checkout", "-b", "clash", forkPoint);
    conflicting = await commit(work, "shared.txt", "theirs\n", "clash");
    await git(work, "push", "origin", "pull", "clash");

    await commit(baseDir, "base.txt", "b\n", "base moves");
    baseTip = await commit(baseDir, "shared.txt", "ours\n", "base moves again");
    // The base tip reaches the pull's repository as objects only, no ref.
    await git(pullDir, "fetch", baseDir, baseTip);
  });

  afterAll(() => rm(root, { recursive: true, force: true }));

  test("the merge commit has the base tip and the head as parents and both changes", async () => {
    const before = [await refs(pullDir), await refs(baseDir)];
    const m = await mergeForCheck(pullDir, "main", baseTip, head);
    if (!m.ok) throw new Error(m.error);
    expect((await git(pullDir, "rev-list", "--parents", "-n1", m.commit)).split(" ")).toEqual([
      m.commit,
      baseTip,
      head,
    ]);
    const show = (f: string) => git(pullDir, "show", `${m.commit}:${f}`);
    expect(await show("pull.txt")).toBe("b");
    expect(await show("base.txt")).toBe("b");
    expect(await show("shared.txt")).toBe("ours");
    expect(m.line).toBe(`merge of ${head.slice(0, 7)} into main@${baseTip.slice(0, 7)}`);
    // The commit is a loose object: no branch or ref moved anywhere.
    expect([await refs(pullDir), await refs(baseDir)]).toEqual(before);
  });

  test("the merge commit message carries the pull's own commit messages", async () => {
    const m = await mergeForCheck(pullDir, "main", baseTip, head);
    if (!m.ok) throw new Error(m.error);
    const body = await git(pullDir, "log", "-n1", "--format=%B", m.commit);
    expect(body).toContain(`check of ${head.slice(0, 7)} merged into main`);
    expect(body).toMatch(/^Why now: the owner asked for it today$/m);
  });

  test("the merge commit lives in the pull's repository, not the base's", async () => {
    const m = await mergeForCheck(pullDir, "main", baseTip, head);
    if (!m.ok) throw new Error(m.error);
    expect(await git(pullDir, "cat-file", "-t", m.commit)).toBe("commit");
    await expect(git(baseDir, "cat-file", "-t", m.commit)).rejects.toThrow();
  });

  test("a head already on the base still gets a merge commit with the base's tree", async () => {
    const m = await mergeForCheck(pullDir, "main", baseTip, forkPoint);
    if (!m.ok) throw new Error(m.error);
    expect(m.commit).not.toBe(baseTip);
    expect((await git(pullDir, "rev-list", "--parents", "-n1", m.commit)).split(" ")).toEqual([
      m.commit,
      baseTip,
      forkPoint,
    ]);
    expect(await git(pullDir, "rev-parse", `${m.commit}^{tree}`)).toBe(
      await git(pullDir, "rev-parse", `${baseTip}^{tree}`),
    );
  });

  test("a conflicting head fails as the change's fault and moves no ref", async () => {
    const before = [await refs(pullDir), await refs(baseDir)];
    const m = await mergeForCheck(pullDir, "main", baseTip, conflicting);
    expect(m.ok).toBe(false);
    if (m.ok) return;
    expect(m.error.startsWith(NO_MERGE)).toBe(true);
    expect(m.error).toBe(`${NO_MERGE} main: shared.txt`);
    expect([await refs(pullDir), await refs(baseDir)]).toEqual(before);
  });
});
