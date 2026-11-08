/**
 * revertCommit undoes one shipped commit with a three-way merge: later work
 * stays, a real conflict is named, and the new commit sits on `ontoOid`.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitParents, revertCommit } from "../src/git/revert.ts";
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
  const [out, e, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${e}`);
  return out.trim();
}

async function init(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "forge-revert-"));
  dirs.push(dir);
  await git(["init", "-q", "-b", "main", dir], dir);
  return dir;
}

/** Write `text` to `file` and commit it; returns the new commit's oid. */
async function commit(dir: string, file: string, text: string, msg: string): Promise<string> {
  await writeFile(join(dir, file), text);
  await git(["add", file], dir);
  await git(["commit", "-q", "-m", msg], dir);
  return git(["rev-parse", "HEAD"], dir);
}

const author = { name: "Rev", email: "rev@forge.local" };
const lines = (...n: string[]) => n.join("\n") + "\n";
const base = lines("a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9");

test("reverting B with C on top undoes only B and keeps C", async () => {
  const dir = await init();
  await commit(dir, "f.txt", base, "A");
  const b = await commit(dir, "f.txt", base.replace("a2", "B2"), "B");
  const c = await commit(dir, "f.txt", base.replace("a2", "B2").replace("a8", "C8"), "C");
  const r = await revertCommit(dir, { commitOid: b, ontoOid: c, message: "Revert B", author });
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  const out = await git(["show", `${r.value.commitOid}:f.txt`], dir);
  expect(out + "\n").toBe(base.replace("a8", "C8"));
});

test("the new commit has ontoOid as its only parent, the message and the author", async () => {
  const dir = await init();
  await commit(dir, "f.txt", base, "A");
  const b = await commit(dir, "f.txt", base.replace("a2", "B2"), "B");
  const r = await revertCommit(dir, { commitOid: b, ontoOid: b, message: "Revert B\n\nwhy", author });
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  const o = r.value.commitOid;
  expect(await commitParents(dir, o)).toEqual([b]);
  expect(await git(["log", "-1", "--format=%B", o], dir)).toBe("Revert B\n\nwhy");
  expect(await git(["log", "-1", "--format=%an <%ae>|%cn <%ce>", o], dir)).toBe(
    "Rev <rev@forge.local>|Rev <rev@forge.local>",
  );
});

test("a later rewrite of B's lines is a conflict naming the file, and no ref moves", async () => {
  const dir = await init();
  await commit(dir, "f.txt", base, "A");
  const b = await commit(dir, "f.txt", base.replace("a2", "B2"), "B");
  const c = await commit(dir, "f.txt", base.replace("a2", "C2"), "C");
  const refs = () => git(["for-each-ref", "--format=%(refname) %(objectname)"], dir);
  const before = await refs();
  const r = await revertCommit(dir, { commitOid: b, ontoOid: c, message: "Revert B", author });
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error).toEqual({ kind: "conflict", files: ["f.txt"] });
  expect(await refs()).toBe(before);
});

test("commitParents: one for a squash, two for a merge, none for a root", async () => {
  const dir = await init();
  const root = await commit(dir, "f.txt", base, "root");
  const second = await commit(dir, "f.txt", base.replace("a2", "B2"), "second");
  await git(["checkout", "-q", "-b", "side", root], dir);
  const side = await commit(dir, "g.txt", "g\n", "side");
  await git(["checkout", "-q", "main"], dir);
  await git(["merge", "-q", "--no-ff", "-m", "merge", "side"], dir);
  const merge = await git(["rev-parse", "HEAD"], dir);

  expect(await commitParents(dir, root)).toEqual([]);
  expect(await commitParents(dir, second)).toEqual([root]);
  expect(await commitParents(dir, merge)).toEqual([second, side]);
  expect(await commitParents(dir, "not-an-oid")).toBeUndefined();
});

test("revertCommit refuses a root commit, undoes a merge against its first parent", async () => {
  const dir = await init();
  const root = await commit(dir, "f.txt", base, "root");
  const second = await commit(dir, "f.txt", base.replace("a2", "B2"), "second");
  const rootRevert = await revertCommit(dir, { commitOid: root, ontoOid: second, message: "r", author });
  expect(rootRevert.ok).toBe(false);
  if (!rootRevert.ok) expect(rootRevert.error.kind).toBe("git");

  await git(["checkout", "-q", "-b", "side", root], dir);
  await commit(dir, "g.txt", "g\n", "side");
  await git(["checkout", "-q", "main"], dir);
  await git(["merge", "-q", "--no-ff", "-m", "merge", "side"], dir);
  const merge = await git(["rev-parse", "HEAD"], dir);
  const r = await revertCommit(dir, { commitOid: merge, ontoOid: merge, message: "Revert merge", author });
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  // mainline is the first parent: the side branch's file goes, main's edit stays.
  expect(await git(["ls-tree", "--name-only", r.value.commitOid], dir)).toBe("f.txt");
  expect(await git(["show", `${r.value.commitOid}:f.txt`], dir) + "\n").toBe(base.replace("a2", "B2"));
});

test("revertCommit refuses an octopus merge and an unsafe oid", async () => {
  const dir = await init();
  const root = await commit(dir, "f.txt", base, "root");
  const branches: string[] = [];
  for (const n of ["x", "y", "z"]) {
    await git(["checkout", "-q", "-b", n, root], dir);
    await commit(dir, `${n}.txt`, n, n);
    branches.push(n);
  }
  await git(["checkout", "-q", "main"], dir);
  await git(["merge", "-q", "-m", "octopus", ...branches], dir);
  const oct = await git(["rev-parse", "HEAD"], dir);
  expect((await commitParents(dir, oct))?.length).toBe(3);
  const r = await revertCommit(dir, { commitOid: oct, ontoOid: oct, message: "r", author });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toEqual({ kind: "octopus", parents: 3 });

  const bad = await revertCommit(dir, { commitOid: "--bad", ontoOid: oct, message: "r", author });
  expect(bad.ok).toBe(false);
  if (!bad.ok) expect(bad.error.kind).toBe("unsafe");
});
