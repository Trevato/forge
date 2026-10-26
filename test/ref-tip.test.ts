import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refTip } from "../src/git/read.ts";
import { gitClientEnv } from "./helpers/git-client.ts";

const env = gitClientEnv({
  GIT_AUTHOR_NAME: "X",
  GIT_AUTHOR_EMAIL: "x@f.dev",
  GIT_COMMITTER_NAME: "X",
  GIT_COMMITTER_EMAIL: "x@f.dev",
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const p = Bun.spawn(["git", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  expect(await p.exited).toBe(0);
  return out.trim();
}

test("refTip reads loose and packed refs without git, and refuses what it cannot read", async () => {
  const dir = await mkdtemp(join(tmpdir(), "reftip-"));
  try {
    await git(dir, "init", "-q", "-b", "main");
    const gd = join(dir, ".git");
    await git(dir, "commit", "-q", "--allow-empty", "-m", "one");
    const one = await git(dir, "rev-parse", "HEAD");
    await git(dir, "branch", "feature");
    expect(await refTip(gd, "refs/heads/main")).toBe(one);
    await git(dir, "pack-refs", "--all");
    expect(await refTip(gd, "refs/heads/feature")).toBe(one);
    await git(dir, "commit", "-q", "--allow-empty", "-m", "two");
    const two = await git(dir, "rev-parse", "HEAD");
    // a loose ref shadows the packed one
    expect(await refTip(gd, "refs/heads/main")).toBe(two);
    expect(await refTip(gd, "refs/heads/nope")).toBeUndefined();
    expect(await refTip(gd, "refs/heads/../../x")).toBeUndefined();
    expect(await refTip(gd, "HEAD")).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("refTip answers undefined for a symbolic or garbled loose ref, so the caller asks git", async () => {
  const dir = await mkdtemp(join(tmpdir(), "reftip-"));
  try {
    await git(dir, "init", "-q", "-b", "main");
    await git(dir, "commit", "-q", "--allow-empty", "-m", "one");
    const gd = join(dir, ".git");
    await Bun.write(join(gd, "refs/heads/sym"), "ref: refs/heads/main\n");
    await Bun.write(join(gd, "refs/heads/junk"), "not an oid\n");
    expect(await refTip(gd, "refs/heads/sym")).toBeUndefined();
    expect(await refTip(gd, "refs/heads/junk")).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
