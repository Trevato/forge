/** The check's clone holds every commit of the pull, so the gate reads a `Try:` line written before a main merge. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { giveHistory } from "../src/checks/history.ts";
import { gitClientEnv } from "./helpers/git-client.ts";

const env = gitClientEnv({
  GIT_AUTHOR_NAME: "Jay Moran",
  GIT_AUTHOR_EMAIL: "jay@f.dev",
  GIT_COMMITTER_NAME: "Jay Moran",
  GIT_COMMITTER_EMAIL: "jay@f.dev",
});
let root = "";
let repo = "";

function git(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}
function commit(path: string, text: string, message: string): string {
  Bun.spawnSync(["sh", "-c", 'printf "%s" "$1" > "$2"', "_", text, path], { cwd: repo });
  git(repo, "add", path);
  git(repo, "commit", "-q", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "forge-check-history-"));
  repo = join(root, "repo");
  git(root, "init", "-q", "-b", "main", repo);
  commit("seed.txt", "seed\n", "seed");
  git(repo, "checkout", "-q", "-b", "pull");
  commit("page.ts", "export {};\n", "A page\n\nTry: open /page on the preview and press Save");
  commit("page.ts", "export const x = 1;\n", "Tidy the page");
  git(repo, "checkout", "-q", "main");
  commit("other.txt", "other\n", "main moves on");
  git(repo, "checkout", "-q", "pull");
  git(repo, "merge", "-q", "--no-edit", "main");
});
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

test("every commit the pull adds is in the check's clone, not just the head's", async () => {
  const base = git(repo, "rev-parse", "main");
  const head = git(repo, "rev-parse", "pull");
  const dir = join(root, "check");
  git(root, "init", "-q", dir);
  const given = await giveHistory(join(repo, ".git"), dir, base, head);
  expect(given).toEqual({ ok: true });
  const messages = git(dir, "log", "--format=%s", `${base}..HEAD`).split("\n");
  expect(messages).toEqual(["Merge branch 'main' into pull", "Tidy the page", "A page"]);
  expect(git(dir, "log", "--format=%B", `${base}..HEAD`)).toContain("Try: open /page on the preview");
  expect(git(dir, "diff", "--name-only", `${base}..HEAD`)).toBe("page.ts");
});

test("a commit id that is not one is refused before git runs", async () => {
  expect(await giveHistory(join(repo, ".git"), join(root, "nope"), "main", "HEAD")).toEqual({
    ok: false,
    error: "not a commit id",
  });
});
