/**
 * A kept fork's pull, combined on our side (#9012): main merged into the
 * author's head, in a branch of the base repository (`combined/N`). The
 * author's branch is never written. Each conflicting block keeps main's
 * side, and the combined commit's message is the note the author reads:
 * every conflicted file and what was kept. The preview builds this commit
 * and the landing merges it, so the author's head stays an ancestor of main.
 *
 * Commits pushed on top of the combined branch (a resolution done by hand)
 * are kept: the next combining starts from the branch's tip as long as it
 * still carries the author's head.
 */

import { gitEnv, runGit, runGitCapture } from "./env.ts";
import { isSafeOid, isSafeTreePath } from "./guard.ts";
import { refTip } from "./read.ts";
import { mergeBase, resolveOid } from "./merge.ts";
import { parseConflicts } from "./conflicts.ts";

/** The branch a pull's combined tree lives on, in the base repository. */
export const combinedBranch = (number: number): string => `combined/${number}`;
const combinedRef = (number: number): string => `refs/heads/${combinedBranch(number)}`;

/** One conflicted file and what the combining kept of it. */
export interface Kept {
  readonly path: string;
  /** Conflicting blocks in the file; 0 when it is not a text conflict. */
  readonly blocks: number;
  /** "main": main's side of every block; "open": git could not pick, it awaits a hand. */
  readonly kept: "main" | "open";
}

const IDENTITY = {
  GIT_AUTHOR_NAME: "forge",
  GIT_AUTHOR_EMAIL: "forge@localhost",
  GIT_COMMITTER_NAME: "forge",
  GIT_COMMITTER_EMAIL: "forge@localhost",
};

const isAncestor = async (dir: string, a: string, b: string): Promise<boolean> =>
  a === b || (await mergeBase(dir, a, b)) === a;

/** The note the author reads: what was combined and what was kept, file by file. */
export function combinedNote(number: number, baseOid: string, files: readonly Kept[]): string {
  const lines = [
    `Main merged into #${number}'s head on our side (${combinedBranch(number)})`,
    "",
    "Your branch is untouched. The preview builds this combined tree, and landing merges it, so your head stays an ancestor of main.",
    "",
  ];
  if (files.length === 0) lines.push("No file conflicted: this is a clean merge of main into your head.");
  else {
    lines.push("Conflicted files, and what was kept:");
    for (const f of files) lines.push(`- ${keptLine(f, number)}`);
    if (files.some((f) => f.kept === "main")) lines.push("", TAKE_BACK);
  }
  // The same facts as trailers: what readers render from, not the words above.
  lines.push("", `${BASE_TRAILER}: ${baseOid}`);
  for (const f of files) lines.push(`${KEPT_TRAILER}: ${f.kept} ${f.blocks} ${f.path}`);
  return lines.join("\n");
}

/** One conflicted file, said to its author. */
export const keptLine = (f: Kept, number: number): string =>
  f.kept === "main"
    ? `${f.path}: ${f.blocks} block${f.blocks === 1 ? "" : "s"}, main's side kept; your side was dropped from the landed tree.`
    : `${f.path}: left open (not a line conflict); it is resolved by hand on ${combinedBranch(number)}.`;

/** How the author gets a dropped side back. */
export const TAKE_BACK =
  "To get your side back: merge main into your branch, resolve these files as you want them, and push. A head that already has main is its own combined build, so what you resolved is what lands.";

const BASE_TRAILER = "Combined-Base";
const KEPT_TRAILER = "Combined-Kept";

/** The trailers of a combining commit, read back as data. */
export function parseCombined(message: string): { baseOid: string; files: Kept[] } {
  let baseOid = "";
  const files: Kept[] = [];
  for (const line of message.split("\n")) {
    const base = line.startsWith(`${BASE_TRAILER}: `) ? line.slice(BASE_TRAILER.length + 2).trim() : "";
    if (isSafeOid(base)) baseOid = base;
    const kept = /^Combined-Kept: (main|open) (\d{1,6}) (.+)$/.exec(line);
    if (kept !== null && isSafeTreePath(kept[3]!))
      files.push({ kept: kept[1] as Kept["kept"], blocks: Number(kept[2]), path: kept[3]! });
  }
  return { baseOid, files };
}

/** `merge-tree --write-tree --name-only`: the tree, and the paths still in conflict. */
async function mergeTree(
  dir: string,
  ours: string,
  theirs: string,
  options: readonly string[],
): Promise<{ tree: string; files: string[] } | undefined> {
  const out = await runGitCapture(
    ["merge-tree", "--write-tree", "--name-only", ...options, ours, theirs],
    { cwd: dir, timeoutMs: 60_000 },
  );
  if (out.code !== 0 && out.code !== 1) return undefined;
  const [first, ...rest] = out.stdout.split("\n");
  const tree = (first ?? "").trim();
  if (!isSafeOid(tree)) return undefined;
  const files: string[] = [];
  if (out.code === 1)
    for (const line of rest) {
      if (line.trim() === "") break;
      if (isSafeTreePath(line)) files.push(line);
    }
  return { tree, files };
}

/**
 * Write (or bring up to date) the combined branch of pull `number`: main at
 * `baseOid` merged into `headOid`. Answers the combined tip, and the files
 * this combining resolved (null when the branch already carried both).
 */
export async function combine(
  dir: string,
  input: { readonly number: number; readonly baseOid: string; readonly headOid: string },
): Promise<{ oid: string; files: Kept[] | null } | undefined> {
  const made = await build(dir, input);
  // A rebuild that worked ends any earlier failure's sentence, whoever asked for it.
  if (made !== undefined) await setFailure(dir, input.number, undefined);
  return made;
}

async function build(
  dir: string,
  input: { readonly number: number; readonly baseOid: string; readonly headOid: string },
): Promise<{ oid: string; files: Kept[] | null } | undefined> {
  const { number, baseOid, headOid } = input;
  if (!Number.isInteger(number) || number < 1 || !isSafeOid(baseOid) || !isSafeOid(headOid))
    return undefined;
  const ref = combinedRef(number);
  const prior = await resolveOid(dir, ref);
  const from = prior !== undefined && (await isAncestor(dir, headOid, prior)) ? prior : headOid;
  if (from === prior && (await isAncestor(dir, baseOid, from))) return { oid: from, files: null };

  const update = async (oid: string): Promise<boolean> =>
    oid === prior ||
    (await runGit(["update-ref", ref, oid, ...(prior === undefined ? [] : [prior])], { cwd: dir })).ok;
  // Main is already in it: the head (or the branch) is the combined build.
  if (await isAncestor(dir, baseOid, from)) return (await update(from)) ? { oid: from, files: [] } : undefined;

  const plain = await mergeTree(dir, baseOid, from, []);
  if (plain === undefined) return undefined;
  let tree = plain.tree;
  const files: Kept[] = [];
  if (plain.files.length > 0) {
    // Main's side of each block; what git still cannot pick stays open.
    const picked = await mergeTree(dir, baseOid, from, ["-X", "ours"]);
    const open = new Set(picked?.files ?? plain.files);
    if (picked !== undefined) tree = picked.tree;
    for (const path of plain.files) {
      const text = await runGit(["cat-file", "blob", `${plain.tree}:${path}`], { cwd: dir });
      const blocks = text.ok ? parseConflicts(text.value).blocks.length : 0;
      files.push({ path, blocks, kept: open.has(path) || blocks === 0 ? "open" : "main" });
    }
  }
  const commit = await runGit(
    ["commit-tree", tree, "-p", from, "-p", baseOid, "-m", combinedNote(number, baseOid, files)],
    { cwd: dir, env: IDENTITY },
  );
  if (!commit.ok) return undefined;
  const oid = commit.value.trim();
  return (await update(oid)) ? { oid, files } : undefined;
}

/** The combined tip for this head, when the branch exists and still carries it. */
export async function combinedTip(
  dir: string,
  number: number,
  headOid: string,
): Promise<string | undefined> {
  if (!Number.isInteger(number) || number < 1 || !isSafeOid(headOid)) return undefined;
  const tip = await refTip(dir, combinedRef(number));
  if (tip === undefined || !(await isAncestor(dir, headOid, tip))) return undefined;
  return tip;
}

/** The combined tip, the base it was built on, and what its combining kept. */
export async function readCombined(
  dir: string,
  number: number,
  headOid: string,
): Promise<{ oid: string; branch: string; baseOid: string; files: Kept[] } | undefined> {
  const oid = await combinedTip(dir, number, headOid);
  if (oid === undefined) return undefined;
  // The newest combining commit of those the head lacks says what was kept.
  const log = await runGit(
    ["log", "-1", "--author=forge@localhost", "--format=%B", oid, `^${headOid}`],
    { cwd: dir },
  );
  return { oid, branch: combinedBranch(number), ...parseCombined(log.ok ? log.value : "") };
}

/**
 * The head a preview commit runs under, read from git as it stands: the
 * pull's head when `commit` is its combined tip and still carries it, the
 * commit itself otherwise. Synchronous, for the runtime's approval gate.
 */
export function headUnder(
  dir: string,
  pull: { readonly crossRepo: boolean; readonly number: number; readonly headOid: string },
  commit: string,
): string {
  if (!pull.crossRepo || commit === pull.headOid || !isSafeOid(commit) || !isSafeOid(pull.headOid))
    return commit;
  const git = (args: string[]) =>
    Bun.spawnSync(["git", ...args], { cwd: dir, env: gitEnv(), stdout: "pipe", stderr: "ignore" });
  const tip = git(["rev-parse", "--verify", "--quiet", combinedRef(pull.number)]);
  if (tip.exitCode !== 0 || tip.stdout.toString().trim() !== commit) return commit;
  return git(["merge-base", "--is-ancestor", pull.headOid, commit]).exitCode === 0 ? pull.headOid : commit;
}

/**
 * The commit a pull's preview builds: the head (the branch, or a fork's
 * snapshot), or the combined tip when a fork's pull has one that carries it.
 */
export async function previewCommit(
  dir: string,
  pull: { readonly crossRepo: boolean; readonly number: number; readonly headBranch: string; readonly headOid: string },
): Promise<string | undefined> {
  return (await previewHead(dir, pull))?.commit;
}

/** The head a preview commit stands for: a combined tip answers as the head it carries. */
export async function previewHead(
  dir: string,
  pull: { readonly crossRepo: boolean; readonly number: number; readonly headBranch: string; readonly headOid: string },
): Promise<{ commit: string; head: string } | undefined> {
  const ref = pull.crossRepo ? `refs/pull/${pull.number}/head` : `refs/heads/${pull.headBranch}`;
  const head = (await resolveOid(dir, ref)) ?? (pull.headOid || undefined);
  if (head === undefined) return undefined;
  const combined = pull.crossRepo ? await combinedTip(dir, pull.number, head) : undefined;
  return { commit: combined ?? head, head };
}

const failureKey = (number: number): string => `recombine.failed${number}`;

/** Remember (or, with undefined, forget) why the last rebuild of this pull failed: one line, in the repository's own config. */
export async function setFailure(dir: string, number: number, sentence: string | undefined): Promise<void> {
  if (!Number.isInteger(number) || number < 1) return;
  if (sentence === undefined) await runGit(["config", "--local", "--unset-all", failureKey(number)], { cwd: dir });
  else {
    const one = sentence.replace(/\s+/g, " ").trim().slice(0, 300);
    await runGit(["config", "--local", failureKey(number), one], { cwd: dir });
  }
}

/** Why the last rebuild of this pull failed, when it did and nothing has rebuilt since. */
export async function readFailure(dir: string, number: number): Promise<string | undefined> {
  if (!Number.isInteger(number) || number < 1) return undefined;
  const out = await runGit(["config", "--local", "--get", failureKey(number)], { cwd: dir });
  const line = out.ok ? out.value.trim() : "";
  return line === "" ? undefined : line;
}
