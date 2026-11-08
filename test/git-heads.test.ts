/**
 * headsState reads where every branch points from the repository's files,
 * the same answer git gives, and gives up on anything it does not understand.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { headsState } from "../src/git/heads.ts";
import { gitClientEnv } from "./helpers/git-client.ts";

const env = gitClientEnv({
  GIT_AUTHOR_NAME: "A",
  GIT_AUTHOR_EMAIL: "a@forge.local",
  GIT_COMMITTER_NAME: "A",
  GIT_COMMITTER_EMAIL: "a@forge.local",
});
const dirs: string[] = [];
afterAll(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

async function git(args: string[], cwd: string): Promise<string> {
  const p = Bun.spawn(["git", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
  return out;
}

async function repo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "forge-heads-"));
  dirs.push(dir);
  await git(["init", "-q", "-b", "main", dir], dir);
  await git(["commit", "-q", "--allow-empty", "-m", "one"], dir);
  await git(["branch", "feat/a"], dir);
  await git(["commit", "-q", "--allow-empty", "-m", "two"], dir);
  return dir;
}

const fromGit = async (dir: string) =>
  (await git(["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/"], dir)).trim();

test("loose, packed and mixed refs read the same as for-each-ref", async () => {
  const dir = await repo();
  const gitDir = join(dir, ".git");
  expect(headsState(gitDir)).toBe(await fromGit(dir));
  await git(["pack-refs", "--all"], dir);
  expect(headsState(gitDir)).toBe(await fromGit(dir));
  // A loose ref written after packing wins over its packed line.
  await git(["commit", "-q", "--allow-empty", "-m", "three"], dir);
  await git(["branch", "z"], dir);
  expect(headsState(gitDir)).toBe(await fromGit(dir));
});

test("a moved branch changes the state", async () => {
  const dir = await repo();
  const before = headsState(join(dir, ".git"));
  await git(["branch", "-f", "feat/a", "main"], dir);
  expect(headsState(join(dir, ".git"))).not.toBe(before);
});

test("a symbolic ref, a lock file or no refs directory gives up", async () => {
  const dir = await repo();
  const gitDir = join(dir, ".git");
  await writeFile(join(gitDir, "refs/heads/feat/a.lock"), "");
  expect(headsState(gitDir)).toBeUndefined();
  await rm(join(gitDir, "refs/heads/feat/a.lock"));
  await writeFile(join(gitDir, "refs/heads/alias"), "ref: refs/heads/main\n");
  expect(headsState(gitDir)).toBeUndefined();
  expect(headsState(join(dir, "nowhere"))).toBeUndefined();
});
