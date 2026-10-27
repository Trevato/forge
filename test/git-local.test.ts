/**
 * The working-tree plumbing, against real repositories in a temp directory.
 *
 * Nothing is mocked: every assertion here is about what git actually did,
 * because the value of `git/local.ts` is entirely in whether its arguments
 * and its parsing match the real thing. The adversarial cases — a rename, a
 * conflict, a hunk applied and then reversed — are the ones worth having.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as git from "../src/git/local.ts";
import { unwrap } from "../src/kernel/result.ts";
import { gitClientEnv } from "./helpers/git-client.ts";

const IDENTITY = {
  GIT_AUTHOR_NAME: "Ada",
  GIT_AUTHOR_EMAIL: "ada@forge.local",
  GIT_COMMITTER_NAME: "Ada",
  GIT_COMMITTER_EMAIL: "ada@forge.local",
};

/** Drive the git *client* by spawning it, never through a shell. */
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

async function newRepo(root: string, name: string): Promise<string> {
  const dir = join(root, name);
  await sh(["init", "-b", "main", dir], root);
  await sh(["config", "user.name", "Ada"], dir);
  await sh(["config", "user.email", "ada@forge.local"], dir);
  return dir;
}

let root = "";
const ambient: Record<string, string | undefined> = {};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "forge-local-"));
  // `git/local.ts` acts as the person at the keyboard: it inherits their
  // environment on purpose (their identity, their credential helpers — see
  // "the environment", below), so a commit *it* writes is authored by
  // whoever this machine says you are. Here that person is Ada, and a
  // machine whose shell already names an author (a crew run names its
  // agent) must not decide it instead.
  for (const [key, value] of Object.entries(IDENTITY)) {
    ambient[key] = process.env[key];
    process.env[key] = value;
  }
});

afterAll(async () => {
  for (const [key, value] of Object.entries(ambient)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
});

describe("status", () => {
  test("reads the branch, upstream and every kind of change", async () => {
    const dir = await newRepo(root, "status");
    await writeFile(join(dir, "kept.txt"), "one\ntwo\nthree\n");
    await writeFile(join(dir, "moved.txt"), "a\nb\nc\nd\ne\nf\ng\nh\n");
    await sh(["add", "-A"], dir);
    await sh(["commit", "-m", "first"], dir);

    await writeFile(join(dir, "kept.txt"), "one\nTWO\nthree\n");
    await writeFile(join(dir, "fresh.txt"), "new\n");
    await sh(["mv", "moved.txt", "renamed.txt"], dir);

    const status = unwrap(await git.status(dir));
    expect(status.head).toBe("main");
    expect(status.detached).toBe(false);
    expect(status.upstream).toBeNull();
    expect(status.untracked.map((f) => f.path)).toEqual(["fresh.txt"]);
    expect(status.unstaged.map((f) => f.path)).toEqual(["kept.txt"]);

    const rename = status.staged.find((f) => f.path === "renamed.txt");
    expect(rename?.origPath).toBe("moved.txt");
    expect(rename?.index).toBe("R");
    expect(git.isClean(status)).toBe(false);
  });

  test("a path with a space survives the NUL framing", async () => {
    const dir = await newRepo(root, "spaces");
    await writeFile(join(dir, "a file with spaces.txt"), "hello\n");
    const status = unwrap(await git.status(dir));
    expect(status.untracked.map((f) => f.path)).toEqual([
      "a file with spaces.txt",
    ]);
  });

  test("a detached HEAD is reported as detached, not as a branch", async () => {
    const dir = await newRepo(root, "detached");
    await writeFile(join(dir, "a.txt"), "1\n");
    await sh(["add", "-A"], dir);
    await sh(["commit", "-m", "one"], dir);
    const oid = await sh(["rev-parse", "HEAD"], dir);
    await sh(["checkout", "--detach", oid], dir);

    const status = unwrap(await git.status(dir));
    expect(status.detached).toBe(true);
    expect(status.head).toBeNull();
  });
});

describe("hunks", () => {
  const FILE = "lines.txt";
  const base = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");

  async function twoHunkRepo(name: string): Promise<string> {
    const dir = await newRepo(root, name);
    await writeFile(join(dir, FILE), `${base}\n`);
    await sh(["add", "-A"], dir);
    await sh(["commit", "-m", "base"], dir);
    // Two edits, far enough apart that git emits two hunks with -U3.
    const edited = base
      .replace("line 2", "LINE TWO")
      .replace("line 18", "LINE EIGHTEEN");
    await writeFile(join(dir, FILE), `${edited}\n`);
    return dir;
  }

  test("stage one hunk, leaving the other in the work tree", async () => {
    const dir = await twoHunkRepo("hunk-stage");
    const diff = unwrap(await git.diff(dir, { path: FILE }));
    const file = diff.files[0]!;
    expect(file.hunks.length).toBe(2);

    expect((await git.stageHunk(dir, FILE, file.hunks[0]!)).ok).toBe(true);

    const staged = unwrap(await git.diff(dir, { path: FILE, staged: true }));
    expect(text(staged)).toContain("+LINE TWO");
    expect(text(staged)).not.toContain("+LINE EIGHTEEN");

    const rest = unwrap(await git.diff(dir, { path: FILE }));
    expect(text(rest)).toContain("+LINE EIGHTEEN");
    expect(text(rest)).not.toContain("+LINE TWO");
  });

  test("unstaging the same hunk is the reverse of staging it", async () => {
    const dir = await twoHunkRepo("hunk-unstage");
    const first = unwrap(await git.diff(dir, { path: FILE })).files[0]!;
    expect((await git.stageHunk(dir, FILE, first.hunks[0]!)).ok).toBe(true);

    const staged = unwrap(await git.diff(dir, { path: FILE, staged: true }));
    expect(
      (await git.unstageHunk(dir, FILE, staged.files[0]!.hunks[0]!)).ok,
    ).toBe(true);

    const after = unwrap(await git.diff(dir, { path: FILE, staged: true }));
    expect(after.files.length).toBe(0);
    // And the work tree still holds both edits — unstaging is not discarding.
    const work = unwrap(await git.diff(dir, { path: FILE }));
    expect(work.files[0]!.hunks.length).toBe(2);
  });

  test("discarding a hunk removes it from the file", async () => {
    const dir = await twoHunkRepo("hunk-discard");
    const file = unwrap(await git.diff(dir, { path: FILE })).files[0]!;
    expect((await git.discardHunk(dir, FILE, file.hunks[0]!)).ok).toBe(true);

    const content = await Bun.file(join(dir, FILE)).text();
    expect(content).toContain("line 2");
    expect(content).not.toContain("LINE TWO");
    expect(content).toContain("LINE EIGHTEEN");
  });

  test("the rebuilt header counts the body it actually carries", async () => {
    const dir = await twoHunkRepo("hunk-header");
    const file = unwrap(await git.diff(dir, { path: FILE })).files[0]!;
    const patch = git.hunkPatch(FILE, file.hunks[0]!);
    const header = /@@ -(\d+),(\d+) \+(\d+),(\d+) @@/.exec(patch)!;
    const body = patch
      .split("\n")
      .slice(4)
      .filter((l) => l !== "");
    expect(Number(header[2])).toBe(
      body.filter((l) => l.startsWith(" ") || l.startsWith("-")).length,
    );
    expect(Number(header[4])).toBe(
      body.filter((l) => l.startsWith(" ") || l.startsWith("+")).length,
    );
  });

  test("a file with no trailing newline round-trips", async () => {
    const dir = await newRepo(root, "no-newline");
    await writeFile(join(dir, "n.txt"), "one\ntwo\nthree");
    await sh(["add", "-A"], dir);
    await sh(["commit", "-m", "base"], dir);
    await writeFile(join(dir, "n.txt"), "one\ntwo\nTHREE");

    const file = unwrap(await git.diff(dir, { path: "n.txt" })).files[0]!;
    expect(git.hunkPatch("n.txt", file.hunks[0]!)).toContain(
      "\\ No newline at end of file",
    );
    expect((await git.stageHunk(dir, "n.txt", file.hunks[0]!)).ok).toBe(true);
    const staged = unwrap(await git.diff(dir, { path: "n.txt", staged: true }));
    expect(text(staged)).toContain("+THREE");
  });

  test("an untracked file diffs against nothing and can be staged", async () => {
    const dir = await newRepo(root, "untracked-diff");
    await writeFile(join(dir, "a.txt"), "x\n");
    await sh(["add", "-A"], dir);
    await sh(["commit", "-m", "base"], dir);
    await writeFile(join(dir, "brand-new.txt"), "alpha\nbeta\n");

    const diff = unwrap(
      await git.diff(dir, { path: "brand-new.txt", untracked: true }),
    );
    expect(text(diff)).toContain("+alpha");
    expect((await git.stagePath(dir, "brand-new.txt")).ok).toBe(true);
    const status = unwrap(await git.status(dir));
    expect(status.staged.map((f) => f.path)).toEqual(["brand-new.txt"]);
  });
});

describe("commits, branches and the log", () => {
  test("commit, amend, and the message that comes back", async () => {
    const dir = await newRepo(root, "commits");
    await writeFile(join(dir, "a.txt"), "1\n");
    await git.stageAll(dir);
    const first = unwrap(await git.commit(dir, "add a\n\nthe body"));
    expect(first).toMatch(/^[0-9a-f]{40}$/);
    expect(unwrap(await git.headMessage(dir))).toBe("add a\n\nthe body");

    await writeFile(join(dir, "b.txt"), "2\n");
    await git.stageAll(dir);
    const amended = unwrap(
      await git.commit(dir, "add a and b", { amend: true }),
    );
    expect(amended).not.toBe(first);
    expect(unwrap(await git.headMessage(dir))).toBe("add a and b");
    expect(await sh(["rev-list", "--count", "HEAD"], dir)).toBe("1");
  });

  test("a subject that looks like a flag stays a subject", async () => {
    const dir = await newRepo(root, "flaggy-message");
    await writeFile(join(dir, "a.txt"), "1\n");
    await git.stageAll(dir);
    expect((await git.commit(dir, "--amend is not a flag here")).ok).toBe(true);
    expect(unwrap(await git.headMessage(dir))).toBe(
      "--amend is not a flag here",
    );
  });

  test("branches carry upstream, ahead/behind and which one is current", async () => {
    const dir = await newRepo(root, "branches");
    await writeFile(join(dir, "a.txt"), "1\n");
    await git.stageAll(dir);
    await git.commit(dir, "one");
    expect((await git.createBranch(dir, "feature")).ok).toBe(true);
    await writeFile(join(dir, "b.txt"), "2\n");
    await git.stageAll(dir);
    await git.commit(dir, "two");

    const list = unwrap(await git.branches(dir));
    const feature = list.find((b) => b.name === "feature");
    expect(feature?.current).toBe(true);
    expect(feature?.upstream).toBeNull();
    expect(list.map((b) => b.name).sort()).toEqual(["feature", "main"]);

    expect((await git.checkout(dir, "main")).ok).toBe(true);
    expect((await git.renameBranch(dir, "feature", "renamed")).ok).toBe(true);
    expect((await git.deleteBranch(dir, "renamed", true)).ok).toBe(true);
    expect(unwrap(await git.branches(dir)).map((b) => b.name)).toEqual([
      "main",
    ]);
  });

  test("a ref that could be a flag is refused before git sees it", async () => {
    const dir = await newRepo(root, "unsafe-ref");
    const canary = join(root, "touched-by-git");
    const result = await git.checkout(dir, `--upload-pack=touch ${canary}`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.stderr).toContain("unsafe argument");
    expect(existsSync(canary)).toBe(false);
  });

  test("the log parses, and the graph gets a lane per line of history", async () => {
    const dir = await newRepo(root, "log");
    await writeFile(join(dir, "a.txt"), "1\n");
    await git.stageAll(dir);
    await git.commit(dir, "first");
    await git.createBranch(dir, "side");
    await writeFile(join(dir, "side.txt"), "s\n");
    await git.stageAll(dir);
    await git.commit(dir, "on the side");
    await git.checkout(dir, "main");
    await writeFile(join(dir, "main.txt"), "m\n");
    await git.stageAll(dir);
    await git.commit(dir, "on main");
    await git.mergeBranch(dir, "side");

    const log = unwrap(await git.log(dir, { limit: 10 }));
    expect(log.length).toBe(4);
    expect(log[0]!.subject).toMatch(/Merge/);
    expect(log[0]!.parents.length).toBe(2);
    expect(log[0]!.author).toBe("Ada");
    expect(log[0]!.refs).toContain("HEAD");
    // Every row draws its own commit, and the merge opens a second lane that
    // the root closes again — a lane left open past the commit it was waiting
    // for would draw a line of history that does not exist.
    expect(log.every((c) => c.graph.includes("\u25cf"))).toBe(true);
    expect(log.map((c) => c.graph)).toEqual([
      "\u25cf\u256e",
      "\u2502\u25cf",
      "\u25cf\u2502",
      "\u25cf\u256f",
    ]);
  });

  test("the log filtered to one path only mentions that path", async () => {
    const dir = await newRepo(root, "log-path");
    await writeFile(join(dir, "a.txt"), "1\n");
    await git.stageAll(dir);
    await git.commit(dir, "touch a");
    await writeFile(join(dir, "b.txt"), "1\n");
    await git.stageAll(dir);
    await git.commit(dir, "touch b");

    const log = unwrap(await git.log(dir, { path: "a.txt" }));
    expect(log.map((c) => c.subject)).toEqual(["touch a"]);
  });
});

describe("stash", () => {
  test("push, list, apply, drop", async () => {
    const dir = await newRepo(root, "stash");
    await writeFile(join(dir, "a.txt"), "one\n");
    await git.stageAll(dir);
    await git.commit(dir, "base");

    await writeFile(join(dir, "a.txt"), "changed\n");
    expect((await git.stashPush(dir, "work in progress")).ok).toBe(true);
    expect(await Bun.file(join(dir, "a.txt")).text()).toBe("one\n");

    const list = unwrap(await git.stashList(dir));
    expect(list.length).toBe(1);
    expect(list[0]!.subject).toContain("work in progress");
    expect(list[0]!.ref).toBe("stash@{0}");

    expect(text(unwrap(await git.stashDiff(dir, 0)))).toContain("+changed");
    expect((await git.stashApply(dir, 0)).ok).toBe(true);
    expect(await Bun.file(join(dir, "a.txt")).text()).toBe("changed\n");
    expect((await git.stashDrop(dir, 0)).ok).toBe(true);
    expect(unwrap(await git.stashList(dir)).length).toBe(0);
  });
});

describe("the network verbs", () => {
  test("push sets the upstream, pull fast-forwards, ahead/behind agree", async () => {
    const remote = join(root, "origin.git");
    await sh(["init", "--bare", "-b", "main", remote], root);

    const one = await newRepo(root, "clone-one");
    await sh(["remote", "add", "origin", remote], one);
    await writeFile(join(one, "a.txt"), "1\n");
    await git.stageAll(one);
    await git.commit(one, "first");
    expect(
      (await git.push(one, { branch: "main", setUpstream: true })).ok,
    ).toBe(true);

    const two = join(root, "clone-two");
    expect((await git.clone(remote, two, { parent: root })).ok).toBe(true);

    // A second commit from elsewhere makes the first clone behind.
    await writeFile(join(one, "b.txt"), "2\n");
    await git.stageAll(one);
    await git.commit(one, "second");
    expect((await git.push(one, { branch: "main" })).ok).toBe(true);

    expect((await git.fetch(two, {})).ok).toBe(true);
    const status = unwrap(await git.status(two));
    expect(status.upstream).toBe("origin/main");
    expect(status.behind).toBe(1);
    expect(status.ahead).toBe(0);

    // The two readings must agree — they are printed in opposite orders.
    const counted = unwrap(await git.aheadBehind(two, "HEAD", "origin/main"));
    expect(counted).toEqual({ ahead: 0, behind: 1 });

    expect(await git.isAncestor(two, "HEAD", "origin/main")).toBe(true);
    expect((await git.pull(two, {})).ok).toBe(true);
    expect(unwrap(await git.status(two)).behind).toBe(0);
  });

  test("a push that would not fast-forward is refused, not forced", async () => {
    const remote = join(root, "origin2.git");
    await sh(["init", "--bare", "-b", "main", remote], root);
    const one = await newRepo(root, "diverge-one");
    await sh(["remote", "add", "origin", remote], one);
    await writeFile(join(one, "a.txt"), "1\n");
    await git.stageAll(one);
    await git.commit(one, "first");
    await git.push(one, { branch: "main", setUpstream: true });

    const two = join(root, "diverge-two");
    await git.clone(remote, two, { parent: root });
    await sh(["config", "user.email", "ada@forge.local"], two);
    await sh(["config", "user.name", "Ada"], two);

    await writeFile(join(one, "a.txt"), "from one\n");
    await git.stageAll(one);
    await git.commit(one, "one wins");
    await git.push(one, { branch: "main" });

    await writeFile(join(two, "a.txt"), "from two\n");
    await git.stageAll(two);
    await git.commit(two, "two tries");
    const refused = await git.push(two, { branch: "main" });
    expect(refused.ok).toBe(false);

    expect((await git.fetch(two, {})).ok).toBe(true);
    expect(
      (await git.push(two, { branch: "main", forceWithLease: true })).ok,
    ).toBe(true);
  });

  test("progress lines reach the callback", async () => {
    const remote = join(root, "origin3.git");
    await sh(["init", "--bare", "-b", "main", remote], root);
    const one = await newRepo(root, "progress-one");
    await sh(["remote", "add", "origin", remote], one);
    await writeFile(join(one, "a.txt"), "1\n");
    await git.stageAll(one);
    await git.commit(one, "first");

    const lines: string[] = [];
    await git.push(one, {
      branch: "main",
      setUpstream: true,
      onProgress: (line) => lines.push(line),
    });
    expect(lines.length).toBeGreaterThan(0);
  });
});

describe("the sequencer", () => {
  test("a rebase that conflicts is visible, and abort puts it back", async () => {
    const dir = await newRepo(root, "rebase");
    await writeFile(join(dir, "a.txt"), "base\n");
    await git.stageAll(dir);
    await git.commit(dir, "base");

    await git.createBranch(dir, "side");
    await writeFile(join(dir, "a.txt"), "side\n");
    await git.stageAll(dir);
    const sideCommit = unwrap(await git.commit(dir, "side edit"));

    await git.checkout(dir, "main");
    await writeFile(join(dir, "a.txt"), "main\n");
    await git.stageAll(dir);
    await git.commit(dir, "main edit");

    await git.checkout(dir, "side");
    expect(await git.sequence(dir)).toBe("none");
    const attempt = await git.rebase(dir, "main");
    expect(attempt.ok).toBe(false);
    expect(await git.sequence(dir)).toBe("rebase");
    expect(unwrap(await git.conflicts(dir))).toEqual(["a.txt"]);
    expect(unwrap(await git.status(dir)).conflicted.map((f) => f.path)).toEqual(
      ["a.txt"],
    );

    expect((await git.rebaseAbort(dir)).ok).toBe(true);
    expect(await git.sequence(dir)).toBe("none");
    expect(await sh(["rev-parse", "HEAD"], dir)).toBe(sideCommit);
  });

  test("a rebase that resolves continues to the end", async () => {
    const dir = await newRepo(root, "rebase-continue");
    await writeFile(join(dir, "a.txt"), "base\n");
    await git.stageAll(dir);
    await git.commit(dir, "base");
    await git.createBranch(dir, "side");
    await writeFile(join(dir, "a.txt"), "side\n");
    await git.stageAll(dir);
    await git.commit(dir, "side edit");
    await git.checkout(dir, "main");
    await writeFile(join(dir, "a.txt"), "main\n");
    await git.stageAll(dir);
    await git.commit(dir, "main edit");
    await git.checkout(dir, "side");
    await git.rebase(dir, "main");

    await writeFile(join(dir, "a.txt"), "resolved\n");
    expect((await git.stagePath(dir, "a.txt")).ok).toBe(true);
    expect((await git.rebaseContinue(dir)).ok).toBe(true);
    expect(await git.sequence(dir)).toBe("none");
    expect(unwrap(await git.log(dir, { limit: 5 })).length).toBe(3);
  });

  test("cherry-pick and revert land as their own commits", async () => {
    const dir = await newRepo(root, "pick");
    await writeFile(join(dir, "a.txt"), "1\n");
    await git.stageAll(dir);
    await git.commit(dir, "base");
    await git.createBranch(dir, "side");
    await writeFile(join(dir, "side.txt"), "s\n");
    await git.stageAll(dir);
    const picked = unwrap(await git.commit(dir, "add side"));

    await git.checkout(dir, "main");
    expect((await git.cherryPick(dir, picked)).ok).toBe(true);
    expect(await Bun.file(join(dir, "side.txt")).exists()).toBe(true);

    const head = await sh(["rev-parse", "HEAD"], dir);
    expect((await git.revert(dir, head)).ok).toBe(true);
    expect(await Bun.file(join(dir, "side.txt")).exists()).toBe(false);
  });
});

describe("discarding", () => {
  test("a tracked change goes back to HEAD, an untracked file is removed", async () => {
    const dir = await newRepo(root, "discard");
    await writeFile(join(dir, "a.txt"), "one\n");
    await git.stageAll(dir);
    await git.commit(dir, "base");

    await writeFile(join(dir, "a.txt"), "two\n");
    await git.stagePath(dir, "a.txt");
    expect((await git.discardPath(dir, "a.txt")).ok).toBe(true);
    expect(await Bun.file(join(dir, "a.txt")).text()).toBe("one\n");

    await writeFile(join(dir, "junk.txt"), "x\n");
    expect(
      (await git.discardPath(dir, "junk.txt", { untracked: true })).ok,
    ).toBe(true);
    expect(await Bun.file(join(dir, "junk.txt")).exists()).toBe(false);
  });

  test("unstagedOnly puts the file back to the index and leaves the staged half", async () => {
    const dir = await newRepo(root, "discard-half");
    await writeFile(join(dir, "a.txt"), "one\n");
    await git.stageAll(dir);
    await git.commit(dir, "base");
    await writeFile(join(dir, "a.txt"), "two\n");
    await git.stagePath(dir, "a.txt");
    await writeFile(join(dir, "a.txt"), "three\n");
    expect(
      (await git.discardPath(dir, "a.txt", { unstagedOnly: true })).ok,
    ).toBe(true);
    expect(await Bun.file(join(dir, "a.txt")).text()).toBe("two\n");
    const status = await git.status(dir);
    expect(status.ok && status.value.staged.map((f) => f.path)).toEqual([
      "a.txt",
    ]);
  });

  test("unstaging works before there is a HEAD to restore from", async () => {
    const dir = await newRepo(root, "first-file");
    await writeFile(join(dir, "a.txt"), "1\n");
    await git.stageAll(dir);
    expect(unwrap(await git.status(dir)).staged.length).toBe(1);
    expect((await git.unstagePath(dir, "a.txt")).ok).toBe(true);
    const status = unwrap(await git.status(dir));
    expect(status.staged.length).toBe(0);
    expect(status.untracked.map((f) => f.path)).toEqual(["a.txt"]);
  });
});

describe("the environment", () => {
  test("it inherits the user's, and pins only what a TUI must", () => {
    process.env["FORGE_TEST_MARKER"] = "kept";
    const env = git.localGitEnv();
    expect(env["FORGE_TEST_MARKER"]).toBe("kept");
    expect(env["HOME"]).toBe(process.env["HOME"]);
    expect(env["GIT_TERMINAL_PROMPT"]).toBe("0");
    expect(env["GIT_OPTIONAL_LOCKS"]).toBe("0");
    expect(env["LC_ALL"]).toBe("C");
    // The server's scrubbing must not have leaked in: a local commit has to
    // use the user's own identity and credential helpers.
    expect(env["GIT_CONFIG_GLOBAL"]).toBeUndefined();
    delete process.env["FORGE_TEST_MARKER"];
  });
});

function text(diff: {
  files: { hunks: { lines: { kind: string; content: string }[] }[] }[];
}): string {
  return diff.files
    .flatMap((f) => f.hunks)
    .flatMap((h) => h.lines)
    .map(
      (l) =>
        `${l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}${l.content}`,
    )
    .join("\n");
}
