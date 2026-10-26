/**
 * Branches as a unit: create, delete, and the ahead/behind arithmetic a
 * branch list needs.
 *
 * Creation is `update-ref <ref> <oid> ""` — the empty old value is git's own
 * "this ref must not exist beforehand", so a create is a compare-and-swap
 * against absence rather than a check followed by a write two callers can
 * interleave. Deletion is `update-ref -d <ref> <oid>`, which refuses if the
 * branch moved since we read it. Neither runs hooks (that is `receive-pack`'s
 * job), so the caller announces the change on the event outbox itself.
 *
 * Nothing here knows about repos, actors or origins; `actions/branches.ts`
 * owns that. What lives here is the plumbing and its argument hygiene.
 */

import { err, ok, type Result } from "../kernel/result.ts";
import { runGit, runGitCapture, runGitRaw, type GitFailure } from "./env.ts";
import { isSafeOid, isSafeRef } from "./guard.ts";
import { resolveOid } from "./merge.ts";
import { LOG_FORMAT, listRefs, parseLogRecords, type Commit } from "./read.ts";

/**
 * A branch list stops comparing here. Each comparison is one `rev-list`
 * spawn; a repo with thousands of branches would otherwise turn one page
 * view into thousands of processes. Past the cap the names and tips are
 * still returned — only `ahead`/`behind` go null.
 */
export const MAX_BRANCH_COMPARE = 200;

/** How many `rev-list` comparisons run at once. */
const COMPARE_CONCURRENCY = 8;

export type CreateBranchError =
  | "invalid_name"
  | "invalid_start"
  | "unknown_start"
  | "exists"
  | "git_failed";

export type DeleteBranchError =
  | "invalid_name"
  | "unknown_branch"
  | "branch_moved"
  | "git_failed";

export interface BranchRef {
  readonly name: string;
  readonly oid: string;
}

/**
 * A branch name as a user types it: short (`feat/x`), never a full ref and
 * never a name git reserves. `isSafeRef` already refuses flag injection,
 * `..`, globbing and control bytes; this adds the shape rules that keep
 * `refs/heads/<name>` meaning what the caller thinks it means.
 */
export function isBranchName(name: string): boolean {
  if (!isSafeRef(name)) return false;
  if (name.startsWith("refs/") || name === "HEAD") return false;
  // A 40-hex name would be indistinguishable from an object id everywhere
  // a rev is accepted — git itself warns about this, we simply refuse.
  if (isSafeOid(name)) return false;
  // A loose ref is a file; a component past the filesystem's name limit is
  // an ENAMETOOLONG from git, not a branch. Refuse it as the bad name it is.
  for (const part of name.split("/")) {
    if (Buffer.byteLength(part, "utf8") > MAX_COMPONENT_BYTES) return false;
  }
  return true;
}

/** The longest single path component every filesystem git runs on takes. */
const MAX_COMPONENT_BYTES = 255;

/**
 * Create `refs/heads/<name>` at whatever `from` resolves to. Refuses if the
 * branch already exists — the create-only lease is git's, not ours, so two
 * concurrent creates cannot both win.
 */
export async function createBranch(
  dir: string,
  name: string,
  from: string,
): Promise<Result<BranchRef, CreateBranchError>> {
  if (!isBranchName(name)) return err("invalid_name");
  if (!isSafeRef(from) && !isSafeOid(from)) return err("invalid_start");

  const oid = await startOid(dir, from);
  if (oid === undefined) return err("unknown_start");

  const created = await runGitCapture(
    ["update-ref", `refs/heads/${name}`, oid, ""],
    { cwd: dir },
  );
  if (created.code !== 0) {
    return err(
      /already exists/i.test(created.stderr) ? "exists" : "git_failed",
    );
  }
  return ok({ name, oid });
}

/**
 * Delete `refs/heads/<name>`, asserting the tip we read is the tip we
 * delete. A branch that moved between the read and the delete is refused,
 * so a delete can never silently discard a commit that arrived meanwhile.
 */
export async function deleteBranch(
  dir: string,
  name: string,
): Promise<Result<BranchRef, DeleteBranchError>> {
  if (!isBranchName(name)) return err("invalid_name");
  const oid = await resolveOid(dir, `refs/heads/${name}`);
  if (oid === undefined) return err("unknown_branch");

  const deleted = await runGitCapture(
    ["update-ref", "-d", `refs/heads/${name}`, oid],
    { cwd: dir },
  );
  if (deleted.code !== 0) {
    return err(
      /cannot lock|is at .* but expected/i.test(deleted.stderr)
        ? "branch_moved"
        : "git_failed",
    );
  }
  return ok({ name, oid });
}

export interface BranchInfo extends BranchRef {
  readonly isDefault: boolean;
  /** Commits here that the default branch lacks; null past the cap. */
  readonly ahead: number | null;
  /** Commits on the default branch that this one lacks; null past the cap. */
  readonly behind: number | null;
}

export interface BranchListing {
  readonly branches: readonly BranchInfo[];
  /** False when the repo has more branches than `MAX_BRANCH_COMPARE`. */
  readonly compared: boolean;
}

/**
 * Every branch, with its divergence from the default. One `for-each-ref`
 * for the names and tips, then one `for-each-ref %(ahead-behind:)` for
 * the counts, or, with `bulk: false` or an older git, one `rev-list` per
 * branch (bounded, and capped by `MAX_BRANCH_COMPARE`).
 */
export async function listBranches(
  dir: string,
  defaultBranch: string,
  opts: { readonly bulk?: boolean } = {},
): Promise<Result<BranchListing, GitFailure>> {
  const refs = await listRefs(dir, "refs/heads/");
  if (!refs.ok) return refs;

  const rows = refs.value.map((ref) => ({
    name: ref.name.slice("refs/heads/".length),
    oid: ref.oid,
    isDefault: ref.name === `refs/heads/${defaultBranch}`,
  }));
  rows.sort((a, b) =>
    a.isDefault === b.isDefault
      ? a.name.localeCompare(b.name)
      : a.isDefault
        ? -1
        : 1,
  );

  const compare =
    rows.length <= MAX_BRANCH_COMPARE && isSafeRef(defaultBranch)
      ? await resolveOid(dir, `refs/heads/${defaultBranch}`)
      : undefined;
  if (compare === undefined) {
    return ok({
      branches: rows.map((r) => ({ ...r, ahead: null, behind: null })),
      compared: rows.length <= MAX_BRANCH_COMPARE,
    });
  }

  const counted =
    opts.bulk === false ? undefined : await aheadBehindAll(dir, compare);
  if (counted !== undefined) {
    return ok({
      branches: rows.map((r) => ({
        ...r,
        ...(counted.get(r.name) ?? { ahead: null, behind: null }),
      })),
      compared: true,
    });
  }

  const branches: BranchInfo[] = [];
  for (let i = 0; i < rows.length; i += COMPARE_CONCURRENCY) {
    const slice = rows.slice(i, i + COMPARE_CONCURRENCY);
    const counts = await Promise.all(
      slice.map((row) => divergence(dir, compare, row.oid)),
    );
    for (const [j, row] of slice.entries()) {
      branches.push({
        ...row,
        ...(counts[j] ?? { ahead: null, behind: null }),
      });
    }
  }
  return ok({ branches, compared: true });
}

/**
 * Every branch's divergence from `base` in one `for-each-ref`, which asks
 * git's own `%(ahead-behind:)` (2.41+). Undefined when this git lacks it,
 * and the caller falls back to one `rev-list` per branch.
 */
async function aheadBehindAll(
  dir: string,
  base: string,
): Promise<Map<string, { ahead: number; behind: number }> | undefined> {
  if (!isSafeOid(base)) return undefined;
  const listed = await runGit(
    [
      "for-each-ref",
      `--format=%(refname)%00%(ahead-behind:${base})`,
      "--",
      "refs/heads/",
    ],
    { cwd: dir },
  );
  return listed.ok ? parseAheadBehind(listed.value) : undefined;
}

/**
 * The `refname NUL ahead SP behind` lines of `aheadBehindAll`. A malformed
 * line gives up on the whole list (undefined), so the caller takes the slow
 * per-branch path rather than show a wrong count.
 */
export function parseAheadBehind(
  text: string,
): Map<string, { ahead: number; behind: number }> | undefined {
  const out = new Map<string, { ahead: number; behind: number }>();
  if (text === "") return out;
  for (const line of text.split("\n")) {
    const [ref, pair] = line.split("\0");
    // `%(ahead-behind:B)` prints "<ahead> <behind>" of the ref against B.
    const [ahead, behind] = (pair ?? "").split(" ").map(Number);
    if (!ref || !Number.isSafeInteger(ahead) || !Number.isSafeInteger(behind))
      return undefined;
    out.set(ref.slice("refs/heads/".length), {
      ahead: ahead as number,
      behind: behind as number,
    });
  }
  return out;
}

/**
 * The tip commit of each oid, in one `git log --no-walk`. Oids come from
 * git itself; anything unsafe is skipped, never passed on.
 */
export async function tipCommits(
  dir: string,
  oids: readonly string[],
): Promise<Map<string, Commit>> {
  const safe = [...new Set(oids)].filter(isSafeOid);
  const out = new Map<string, Commit>();
  if (safe.length === 0) return out;
  const result = await runGitRaw(
    [
      "log",
      "--no-walk=unsorted",
      "-z",
      `--format=${LOG_FORMAT}`,
      ...safe,
      "--",
    ],
    { cwd: dir },
  );
  if (!result.ok) return out;
  for (const commit of parseLogRecords(result.value)) out.set(commit.oid, commit);
  return out;
}

/**
 * How far `head` has drifted from `base`. `A...B` counts each side of the
 * merge base: the left number is what B is missing (behind), the right is
 * what B has alone (ahead). Both oids come from git itself, so the range
 * expression can never carry a user string.
 */
export async function divergence(
  dir: string,
  base: string,
  head: string,
): Promise<{ ahead: number | null; behind: number | null }> {
  if (!isSafeOid(base) || !isSafeOid(head))
    return { ahead: null, behind: null };
  if (base === head) return { ahead: 0, behind: 0 };
  const counted = await runGit(
    ["rev-list", "--left-right", "--count", `${base}...${head}`],
    { cwd: dir },
  );
  if (!counted.ok) return { ahead: null, behind: null };
  const [behind, ahead] = counted.value.trim().split(/\s+/).map(Number);
  if (!Number.isSafeInteger(ahead) || !Number.isSafeInteger(behind))
    return { ahead: null, behind: null };
  return { ahead: ahead as number, behind: behind as number };
}

/**
 * Resolve a start point: a branch first, then any rev git will accept.
 * Exported because a mirrored repo has to name the commit it is asking the
 * origin to take before anything moves locally.
 */
export async function startOid(
  dir: string,
  from: string,
): Promise<string | undefined> {
  if (isSafeRef(from) && !from.startsWith("refs/")) {
    const branch = await resolveOid(dir, `refs/heads/${from}`);
    if (branch !== undefined) return branch;
  }
  return await resolveOid(dir, from);
}
