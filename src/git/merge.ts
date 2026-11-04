/**
 * Merging, done as plumbing in the bare repo — no work tree, no temp clone.
 * `git merge-tree --write-tree` computes the merged tree (and reports
 * conflicts) without touching a checkout; `commit-tree` seals it; a CAS
 * `update-ref` lands it only if the base hasn't moved under us.
 */

import { err, ok, type Result } from "../kernel/result.ts";
import { diffMemoryKey, recalledBase, rememberBase } from "./diff-memory.ts";
import { runGit, runGitCapture } from "./env.ts";
import { isSafeOid, isSafeRef, isSafeTreePath } from "./guard.ts";

export type MergeStrategy = "merge" | "squash";

export interface MergeIdentity {
  name: string;
  email: string;
}

export type MergeError =
  | { kind: "conflict"; files: string[] }
  | { kind: "unsafe" }
  | { kind: "base_moved" }
  | { kind: "git"; message: string };

export interface MergeResult {
  /** The commit now at the tip of the base branch. */
  readonly mergeOid: string;
  /** The base tip before the merge landed. */
  readonly previousOid: string;
}

/**
 * The plumbing both `mergeable` and a revert's three-way merge share: run
 * `merge-tree --write-tree` over two sides and report the merged tree oid or
 * the conflicted paths. `base` overrides the merge base git would otherwise
 * compute from history — a revert needs the commit being undone as the base,
 * not whatever `ours`/`theirs` share an ancestor with.
 */
/**
 * Whether this git's `merge-tree --write-tree` accepts `--merge-base=`
 * (added in git 2.40). Isolated Actions runners may ship 2.38/2.39, which
 * have `--write-tree` but reject the flag. Lazily cleared to false after the
 * first "unknown option" so later reverts skip the doomed spawn.
 */
let mergeTreeAcceptsMergeBase = true;

/** Parse merge-tree --write-tree stdout/stderr into a tree oid or conflict. */
function parseWriteTree(
  out: { code: number; stdout: string; stderr: string },
): Result<{ treeOid: string }, MergeError> {
  if (out.code === 0) {
    const treeOid = out.stdout.split("\n")[0]!.trim();
    if (!isSafeOid(treeOid))
      return err({ kind: "git", message: "merge-tree gave no tree" });
    return ok({ treeOid });
  }
  if (out.code === 1) {
    const files: string[] = [];
    for (const line of out.stdout.split("\n").slice(1)) {
      if (line.trim() === "") break; // blank line ends the conflict-file block
      if (isSafeTreePath(line)) files.push(line);
    }
    return err({ kind: "conflict", files });
  }
  return err({
    kind: "git",
    message: out.stderr.trim() || `merge-tree exited ${out.code}`,
  });
}

function isUnknownMergeBaseOption(stderr: string): boolean {
  // git prints: error: unknown option `merge-base=…'
  return /unknown option [`']merge-base/.test(stderr);
}

/**
 * On git < 2.40, `--merge-base=` is missing. Synthesize two commits that
 * share `base` as their only parent so `merge-tree --write-tree A B` finds
 * that parent as the merge base — same three-way as the modern flag.
 */
async function writeMergeTreeWithLegacyBase(
  dir: string,
  ours: string,
  theirs: string,
  base: string,
): Promise<Result<{ treeOid: string }, MergeError>> {
  const oursTree = await runGit(["rev-parse", `${ours}^{tree}`], { cwd: dir });
  if (!oursTree.ok)
    return err({ kind: "git", message: oursTree.error.stderr });
  const theirsTree = await runGit(["rev-parse", `${theirs}^{tree}`], {
    cwd: dir,
  });
  if (!theirsTree.ok)
    return err({ kind: "git", message: theirsTree.error.stderr });

  const env = {
    GIT_AUTHOR_NAME: "forge",
    GIT_AUTHOR_EMAIL: "forge@localhost",
    GIT_COMMITTER_NAME: "forge",
    GIT_COMMITTER_EMAIL: "forge@localhost",
  };
  const fakeOurs = await runGit(
    ["commit-tree", oursTree.value, "-p", base, "-m", "merge-tree ours"],
    { cwd: dir, env },
  );
  if (!fakeOurs.ok)
    return err({ kind: "git", message: fakeOurs.error.stderr });
  const fakeTheirs = await runGit(
    ["commit-tree", theirsTree.value, "-p", base, "-m", "merge-tree theirs"],
    { cwd: dir, env },
  );
  if (!fakeTheirs.ok)
    return err({ kind: "git", message: fakeTheirs.error.stderr });

  return parseWriteTree(
    await runGitCapture(
      [
        "merge-tree",
        "--write-tree",
        "--name-only",
        fakeOurs.value,
        fakeTheirs.value,
      ],
      { cwd: dir, timeoutMs: 60_000 },
    ),
  );
}

/**
 * Args for the modern `merge-tree --write-tree` form. Exported so a unit
 * test can lock the flag shape without spawning git.
 */
export function mergeTreeWriteArgs(
  ours: string,
  theirs: string,
  base?: string,
): string[] {
  return [
    "merge-tree",
    "--write-tree",
    "--name-only",
    ...(base === undefined ? [] : [`--merge-base=${base}`]),
    ours,
    theirs,
  ];
}

/** Test-only: force the next writeMergeTree(base) onto the legacy path. */
export function setMergeTreeAcceptsMergeBaseForTest(value: boolean): void {
  mergeTreeAcceptsMergeBase = value;
}

export async function writeMergeTree(
  dir: string,
  ours: string,
  theirs: string,
  base?: string,
): Promise<Result<{ treeOid: string }, MergeError>> {
  if (
    !isSafeOid(ours) ||
    !isSafeOid(theirs) ||
    (base !== undefined && !isSafeOid(base))
  ) {
    return err({ kind: "unsafe" });
  }

  // merge-tree exits 0 on a clean merge (stdout = tree oid) and 1 on conflict
  // (stdout = tree oid, blank line, then conflicted file names). Both outcomes
  // are data on stdout, so capture regardless of exit code.
  if (base === undefined) {
    return parseWriteTree(
      await runGitCapture(mergeTreeWriteArgs(ours, theirs), {
        cwd: dir,
        timeoutMs: 60_000,
      }),
    );
  }

  if (mergeTreeAcceptsMergeBase) {
    const out = await runGitCapture(mergeTreeWriteArgs(ours, theirs, base), {
      cwd: dir,
      timeoutMs: 60_000,
    });
    if (!isUnknownMergeBaseOption(out.stderr)) return parseWriteTree(out);
    // git < 2.40: remember and fall through to the shared-parent workaround.
    mergeTreeAcceptsMergeBase = false;
  }

  return writeMergeTreeWithLegacyBase(dir, ours, theirs, base);
}

/**
 * Can head be merged into base, and if so what would the tree be? Pure
 * computation — writes nothing. Returns the merged tree oid or the conflicted
 * paths. Used both to show mergeability and as the first half of a merge.
 */
export async function mergeable(
  dir: string,
  baseOid: string,
  headOid: string,
): Promise<Result<{ treeOid: string }, MergeError>> {
  return writeMergeTree(dir, baseOid, headOid);
}

/** Land head onto base with the chosen strategy, only if base is unmoved. */
export async function merge(
  dir: string,
  input: {
    baseBranch: string;
    baseOid: string;
    headOid: string;
    strategy: MergeStrategy;
    message: string;
    author: MergeIdentity;
    /** Who commits it, when that is not the author. */
    committer?: MergeIdentity;
    /**
     * The tree the merge must write, when one was already judged (the merge
     * queue's gated candidate, #2036): any other tree is `base_moved`, and
     * nothing is committed.
     */
    treeOid?: string;
  },
): Promise<Result<MergeResult, MergeError>> {
  if (
    !isSafeRef(input.baseBranch) ||
    !isSafeOid(input.baseOid) ||
    !isSafeOid(input.headOid)
  ) {
    return err({ kind: "unsafe" });
  }

  const tree = await mergeable(dir, input.baseOid, input.headOid);
  if (!tree.ok) return tree;
  if (input.treeOid !== undefined && tree.value.treeOid !== input.treeOid)
    return err({ kind: "base_moved" });

  // A squash keeps only the base as parent; a merge records both.
  const parents =
    input.strategy === "squash"
      ? ["-p", input.baseOid]
      : ["-p", input.baseOid, "-p", input.headOid];

  const env = {
    GIT_AUTHOR_NAME: input.author.name,
    GIT_AUTHOR_EMAIL: input.author.email,
    GIT_COMMITTER_NAME: (input.committer ?? input.author).name,
    GIT_COMMITTER_EMAIL: (input.committer ?? input.author).email,
  };
  const commit = await runGit(
    ["commit-tree", tree.value.treeOid, ...parents, "-m", input.message],
    { cwd: dir, env },
  );
  if (!commit.ok) return err({ kind: "git", message: commit.error.stderr });
  const mergeOid = commit.value.trim();

  // CAS the branch forward: fails if someone pushed between our read and now.
  const update = await runGit(
    ["update-ref", `refs/heads/${input.baseBranch}`, mergeOid, input.baseOid],
    { cwd: dir },
  );
  if (!update.ok) return err({ kind: "base_moved" });

  return ok({ mergeOid, previousOid: input.baseOid });
}

/** Resolve a ref or rev to its full object id. */
export async function resolveOid(
  dir: string,
  rev: string,
): Promise<string | undefined> {
  if (!isSafeRef(rev) && !isSafeOid(rev)) return undefined;
  const result = await runGit(["rev-parse", "--verify", `${rev}^{commit}`], {
    cwd: dir,
  });
  return result.ok ? result.value.trim() : undefined;
}

/** The tree a commit records: two commits with one tree change nothing. */
export async function treeOf(
  dir: string,
  oid: string,
): Promise<string | undefined> {
  if (!isSafeOid(oid)) return undefined;
  const result = await runGit(["rev-parse", "--verify", `${oid}^{tree}`], {
    cwd: dir,
  });
  return result.ok ? result.value.trim() : undefined;
}

/** The merge base of two commits — the fork point a PR diff is measured from. */
export async function mergeBase(
  dir: string,
  a: string,
  b: string,
): Promise<string | undefined> {
  if (!isSafeOid(a) || !isSafeOid(b)) return undefined;
  // Two commits' merge base never changes: the next asker reads it from memory.
  const key = diffMemoryKey(dir, a, b);
  const known = recalledBase(key);
  if (known !== undefined) return known;
  const result = await runGit(["merge-base", a, b], { cwd: dir });
  if (!result.ok) return undefined;
  const base = result.value.trim();
  rememberBase(key, base);
  return base;
}

/**
 * Every commit reachable from `oid`, itself included — the whole ancestry in
 * one spawn, so a page asking "is this at or behind that" of many commits
 * reads a set instead of running `mergeBase` once per commit.
 */
export async function ancestorsOf(
  dir: string,
  oid: string,
): Promise<ReadonlySet<string> | undefined> {
  if (!isSafeOid(oid)) return undefined;
  const result = await runGit(["rev-list", oid], { cwd: dir });
  return result.ok ? new Set(result.value.split("\n")) : undefined;
}

/**
 * The commits reachable from `oid` but not from `base`, and whether `base`
 * is itself an ancestor of `oid` — one spawn whose cost is the commits
 * between them, not the whole history. `base` is an ancestor exactly when
 * one of the listed commits names it as a parent (or it is `oid`).
 */
export async function ancestorsSince(
  dir: string,
  oid: string,
  base: string,
): Promise<{ added: ReadonlySet<string>; reaches: boolean } | undefined> {
  if (!isSafeOid(oid) || !isSafeOid(base)) return undefined;
  if (oid === base) return { added: new Set(), reaches: true };
  const result = await runGit(["rev-list", "--parents", oid, `^${base}`], {
    cwd: dir,
  });
  if (!result.ok) return undefined;
  const added = new Set<string>();
  let reaches = false;
  for (const line of result.value.split("\n")) {
    if (line === "") continue;
    const [commit, ...parents] = line.split(" ");
    added.add(commit!);
    if (parents.includes(base)) reaches = true;
  }
  return { added, reaches };
}

/** The commits reachable from head but not base — what a proposal carries. */
export async function aheadOids(
  dir: string,
  baseOid: string,
  headOid: string,
): Promise<ReadonlySet<string>> {
  if (!isSafeOid(baseOid) || !isSafeOid(headOid)) return new Set();
  const result = await runGit(["rev-list", `${baseOid}..${headOid}`], {
    cwd: dir,
  });
  return new Set(result.ok ? result.value.split("\n").filter(Boolean) : []);
}

/** Count commits reachable from head but not base (the PR's commit count). */
export async function aheadCount(
  dir: string,
  baseOid: string,
  headOid: string,
): Promise<number> {
  if (!isSafeOid(baseOid) || !isSafeOid(headOid)) return 0;
  const result = await runGit(
    ["rev-list", "--count", `${baseOid}..${headOid}`],
    { cwd: dir },
  );
  return result.ok ? Number(result.value.trim()) || 0 : 0;
}

/**
 * The head is ahead of the base by commit count while merging it onto the
 * base would write the base's own tree: its content is already there (a
 * squash landed it), so there is nothing to propose. The one test `watchForPull`,
 * `landWork` and the autonomy's carried check share.
 */
export async function contentOnBase(
  dir: string,
  baseOid: string,
  headOid: string,
): Promise<boolean> {
  const merged = await mergeable(dir, baseOid, headOid);
  return merged.ok && merged.value.treeOid === (await treeOf(dir, baseOid));
}

/**
 * Fetch a ref from another local repo (a fork) into this one, bringing its
 * objects across, and return the fetched tip. Used to pull a fork's head into
 * the base repo so a cross-repo PR can be diffed and merged entirely in the
 * base. `sourceDir` is a forge-computed path, never user input.
 */
export async function fetchInto(
  baseDir: string,
  sourceDir: string,
  srcRef: string,
): Promise<string | undefined> {
  if (!isSafeRef(srcRef)) return undefined;
  const fetched = await runGit(
    ["fetch", "--no-tags", "--quiet", sourceDir, srcRef],
    { cwd: baseDir, timeoutMs: 120_000 },
  );
  if (!fetched.ok) return undefined;
  const tip = await runGit(["rev-parse", "FETCH_HEAD"], { cwd: baseDir });
  return tip.ok ? tip.value.trim() : undefined;
}

/** Write a ref to an oid unconditionally (for refs/pull/N/*). */
export async function writeRef(
  dir: string,
  ref: string,
  oid: string,
): Promise<boolean> {
  if (!isSafeRef(ref) || !isSafeOid(oid)) return false;
  const result = await runGit(["update-ref", ref, oid], { cwd: dir });
  return result.ok;
}

/** Who wrote the commits a pull carries, and how many files they touch — for the note an author is sent. */
export async function carriedSummary(
  dir: string,
  baseOid: string,
  headOid: string,
): Promise<{ commits: number; authors: string[]; files: number }> {
  if (!isSafeOid(baseOid) || !isSafeOid(headOid))
    return { commits: 0, authors: [], files: 0 };
  const log = await runGit(
    ["log", "--format=%an", `${baseOid}..${headOid}`],
    { cwd: dir },
  );
  const names = log.ok ? log.value.split("\n").filter(Boolean) : [];
  const diff = await runGit(
    ["diff", "--name-only", `${baseOid}...${headOid}`],
    { cwd: dir },
  );
  const files = diff.ok ? diff.value.split("\n").filter(Boolean).length : 0;
  return { commits: names.length, authors: [...new Set(names)].slice(0, 10), files };
}
