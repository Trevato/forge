/**
 * A pull red only on tests its diff does not reach is checked once more on
 * the same head before one of its builder's tries is spent on it (#7630).
 * An order-dependent test the change never touched parked #7552 twice, a
 * day of the owner's ask each time. So when every failing test file is one
 * the impact map (`impact.ts`) says executes none of the pull's changed
 * files, the check runs again; a second red on that head goes back to the
 * builder as any red does.
 *
 * One fresh re-check per head, recorded: the re-check is a check run with
 * the reason {@link OUTSIDE_DIFF} on that head, so a red on it — or any
 * later red on the head, after a restart too — is never re-checked again.
 *
 * Plain data in, a verdict out ({@link redOutsideDiff}); the forge's reads
 * (the kept map, the run's log, the diff) are {@link outsideDiffCandidate}
 * and {@link pullChanged}.
 */

import type { Database } from "bun:sqlite";
import type { Pull } from "../core/pulls.ts";
import type { Run } from "../core/runs.ts";
import { runGitCapture } from "../git/env.ts";
import { resolveOid } from "../git/merge.ts";
import { readRunLog } from "../runs/log.ts";
import { failuresOf } from "./failures.ts";
import { keptImpact } from "./impact-store.ts";
import { needsFull, reach, type Impact } from "./impact.ts";
import { RULE_TESTS } from "./tiers.ts";

/** The re-check's run reason, which is also its record. */
export const OUTSIDE_DIFF = "outside_diff";

/** What the re-check's log says first. */
export const recheckLine = (files: readonly string[]): string =>
  `re-checked: red outside the diff (${files.join(", ")})`;

/** Files that shape every test: a pull changing one owns any red. */
const SHAPING = /(^|\/)(bun\.lockb?|bunfig\.toml|tsconfig[^/]*\.json|\.env[^/]*)$/;

/**
 * The failing test files when each is outside what the diff reaches, by
 * the map; `undefined` when any may be the change's. Conservative: a test
 * the map has never measured, a repo-wide rule test, a changed test, a
 * changed test helper (the map is of `src/**` only), or a diff the map
 * cannot bound at all, and the red is the pull's.
 */
export function redOutsideDiff(
  failing: readonly string[],
  changed: readonly string[],
  impact: Impact,
): string[] | undefined {
  if (failing.length === 0 || changed.length === 0) return undefined;
  if (needsFull(changed) !== undefined || changed.some((f) => SHAPING.test(f))) return undefined;
  if (changed.some((f) => f.startsWith("test/") && !/\.test\.[cm]?[jt]sx?$/.test(f))) return undefined;
  const reached = reach(changed, impact).tests;
  const inside = (file: string): boolean =>
    !impact.has(file) || RULE_TESTS.includes(file) || changed.includes(file) || reached.has(file);
  return failing.some(inside) ? undefined : [...failing].sort();
}

/** Whether this head of the pull already had its re-check. */
export function recheckedHead(db: Database, issueId: string, commitOid: string): boolean {
  return (
    db
      .query<{ n: number }, [string, string, string]>(
        `SELECT 1 AS n FROM run WHERE kind = 'check' AND issue_id = ?1 AND commit_oid = ?2 AND reason = ?3 LIMIT 1`,
      )
      .get(issueId, commitOid, OUTSIDE_DIFF) !== null
  );
}

/**
 * What can be known without git, in the event's own tick: a failed pull
 * check not yet re-checked on its head, whose log names failing test files
 * that the repository's kept map has all measured. The answer is the map
 * and the files; `undefined` is today's path at once.
 */
export function outsideDiffCandidate(
  db: Database,
  dataDir: string,
  run: Run | undefined,
): { impact: Impact; failing: string[] } | undefined {
  if (run === undefined || run.kind !== "check" || run.state !== "failed") return undefined;
  if (run.issueId === null || run.commitOid === "") return undefined;
  if (run.reason === OUTSIDE_DIFF || recheckedHead(db, run.issueId, run.commitOid)) return undefined;
  const impact = keptImpact(dataDir, run.repoId);
  if (impact === undefined) return undefined;
  const { files } = failuresOf(readRunLog(dataDir, run.id).lines);
  if (files.length === 0 || !files.every((f) => impact.has(f))) return undefined;
  return { impact, failing: files };
}

/** The files the pull's head changes from its base; `undefined` when git cannot say. */
export async function pullChanged(dir: string, pull: Pull, head: string): Promise<string[] | undefined> {
  const base = await resolveOid(dir, `refs/heads/${pull.baseBranch}`);
  if (base === undefined) return undefined;
  const out = await runGitCapture(
    ["diff", "--name-only", "-z", "--no-renames", `${base}...${head}`, "--"],
    { cwd: dir },
  );
  return out.code === 0 ? out.stdout.split("\0").filter((f) => f !== "") : undefined;
}
