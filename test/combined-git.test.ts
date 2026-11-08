/** The combined branch, in git alone (#9012): what a recombine keeps, what it leaves open, whose approval it runs under. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { combine, headUnder, parseCombined, readCombined } from "../src/git/combined.ts";
import { gitClientEnv } from "./helpers/git-client.ts";

const env = gitClientEnv({
  GIT_AUTHOR_NAME: "Jay Moran",
  GIT_AUTHOR_EMAIL: "jay@f.dev",
  GIT_COMMITTER_NAME: "Jay Moran",
  GIT_COMMITTER_EMAIL: "jay@f.dev",
});
let dir = "";
/** The repository itself, as the forge holds it: refs read from files, as in a bare one. */
const gitDir = (): string => join(dir, ".git");

function git(...args: string[]): string {
  const p = Bun.spawnSync(["git", ...args], { cwd: dir, env, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}
function commitOn(branch: string, files: Record<string, string | null>, message: string): string {
  if (git("symbolic-ref", "--short", "HEAD") !== branch) git("checkout", "-q", branch);
  for (const [path, text] of Object.entries(files))
    if (text === null) git("rm", "-q", path);
    else {
      Bun.spawnSync(["sh", "-c", 'printf "%s" "$1" > "$2"', "_", text, path], { cwd: dir });
      git("add", path);
    }
  git("commit", "-q", "-m", message);
  return git("rev-parse", "HEAD");
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-combined-git-"));
  git("init", "-q", "-b", "main");
  commitOn("main", { "one.txt": "one\n", "gone.txt": "gone\n" }, "seed");
  git("branch", "fork");
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("a modify/delete conflict is left open, a line conflict keeps main's side", async () => {
  const head = commitOn("fork", { "one.txt": "fork\n", "gone.txt": "changed\n" }, "fork edits");
  const base = commitOn("main", { "one.txt": "main\n", "gone.txt": null }, "main deletes");
  const made = await combine(gitDir(), { number: 7, baseOid: base, headOid: head });
  expect(made).toBeDefined();
  const files = [...(made!.files ?? [])].sort((a, b) => a.path.localeCompare(b.path));
  expect(files).toEqual([
    { path: "gone.txt", blocks: 0, kept: "open" },
    { path: "one.txt", blocks: 1, kept: "main" },
  ]);
  expect(git("show", `${made!.oid}:one.txt`)).toBe("main");
  // The page and the terminal read the same facts back, from trailers.
  const read = await readCombined(gitDir(), 7, head);
  expect(read?.baseOid).toBe(base);
  expect([...read!.files].sort((a, b) => a.path.localeCompare(b.path))).toEqual(files);
  const note = git("log", "-1", "--format=%B", made!.oid);
  expect(note).toContain("your side was dropped from the landed tree");
  expect(note).toContain("gone.txt: left open");
});

test("a writer's commit on the combined branch survives main moving on", async () => {
  const head = git("rev-parse", "fork");
  const tip = git("rev-parse", "combined/7");
  const fixed = commitOn("combined/7", { "one.txt": "both\n", "gone.txt": "changed\n" }, "a writer resolves");
  expect(git("rev-parse", "combined/7")).not.toBe(tip);
  const base = commitOn("main", { "two.txt": "two\n" }, "main moves");
  const again = await combine(gitDir(), { number: 7, baseOid: base, headOid: head });
  expect(git("log", "-1", "--format=%P", again!.oid).split(" ")).toEqual([fixed, base]);
  expect(git("show", `${again!.oid}:one.txt`)).toBe("both");
  expect(git("show", `${again!.oid}:two.txt`)).toBe("two");
});

test("a combined preview runs under the head it carries, and nothing else does", () => {
  const head = git("rev-parse", "fork");
  const tip = git("rev-parse", "combined/7");
  const pull = { crossRepo: true, number: 7, headOid: head };
  expect(headUnder(gitDir(), pull, tip)).toBe(head);
  // Not the combined tip: it answers for itself, so its own approval is asked.
  const main = git("rev-parse", "main");
  expect(headUnder(gitDir(), pull, main)).toBe(main);
  // A pull whose head the branch no longer carries: the tip answers for itself.
  const elsewhere = git("commit-tree", "4b825dc642cb6eb9a060e54bf8d69288fbee4904", "-m", "elsewhere");
  expect(headUnder(gitDir(), { ...pull, headOid: elsewhere }, tip)).toBe(tip);
  // A branch pull is never combined.
  expect(headUnder(gitDir(), { ...pull, crossRepo: false }, tip)).toBe(tip);
});

test("trailers that are not ours are not read as facts", () => {
  expect(parseCombined("Combined-Base: nope\nCombined-Kept: maybe 1 x\nCombined-Kept: main 2 ../x")).toEqual({
    baseOid: "",
    files: [],
  });
});
