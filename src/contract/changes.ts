/**
 * What changed: the audit's third lens. Policy is decided up front and
 * then left to hold, so the question a review asks is not "what is the
 * policy" (the table) or "is it so" (the probe) but "what moved since I
 * last looked": contracts that changed and how, pulls waiting at the wall,
 * and apps whose doors started or stopped agreeing with their table.
 *
 * All of it is read from what already exists — git, the ledger, the probe
 * rows — so there is nothing to keep in step and nothing to forget.
 */

import type { Database } from "bun:sqlite";
import { readFileAt } from "../apps/checkout.ts";
import { listDecisionsForRepos, type Decision } from "../core/decisions.ts";
import { getIssueById } from "../core/issues.ts";
import type { Repo } from "../core/repos.ts";
import { commitLog } from "../git/read.ts";
import { repoDir } from "../git/repos.ts";
import { readContract, type Contract } from "./can.ts";
import { loosened, wallSentence, type Loosened } from "./policy.ts";
import { listProbes, type ProbeRow } from "./probes.ts";

/** One commit that changed a contract, and what it did to the cells. */
export interface ContractChange {
  readonly repo: Repo;
  readonly oid: string;
  readonly date: string;
  readonly author: string;
  readonly subject: string;
  /** Cells that let more through than before. */
  readonly loosened: readonly Loosened[];
  /** Cells that let less through than before. */
  readonly tightened: readonly Loosened[];
  /** The contract at this commit does not read. */
  readonly unsound: boolean;
  /** The contract was removed at this commit. */
  readonly removed: boolean;
}

const CHANGES_PER_APP = 10;

async function contractAt(
  dir: string,
  oid: string,
): Promise<Contract | "unsound" | undefined> {
  const text = await readFileAt(dir, oid, "contract.json");
  if (text === undefined) return undefined;
  const read = readContract(text);
  return read.ok ? read.contract : "unsound";
}

/** The commits on the default branch that touched `contract.json`, newest first. */
export async function contractChanges(
  reposRoot: string,
  repo: Repo,
  limit = CHANGES_PER_APP,
): Promise<ContractChange[]> {
  const dir = repoDir(reposRoot, repo.ownerName, repo.name);
  const log = await commitLog(dir, `refs/heads/${repo.defaultBranch}`, {
    path: "contract.json",
    limit,
  });
  if (!log.ok) return [];
  const out: ContractChange[] = [];
  for (const commit of log.value) {
    const after = await contractAt(dir, commit.oid);
    const parent = commit.parents[0];
    const before =
      parent === undefined ? undefined : await contractAt(dir, parent);
    const sound = (
      c: Contract | "unsound" | undefined,
    ): Contract | undefined => (c === "unsound" ? undefined : c);
    const a = sound(after);
    const b = sound(before);
    out.push({
      repo,
      oid: commit.oid,
      date: commit.date,
      author: commit.author,
      subject: commit.subject,
      loosened: a === undefined ? [] : loosened(b, a),
      // Tightened is loosened the other way, against what is there now.
      tightened: a === undefined || b === undefined ? [] : loosened(a, b),
      unsound: after === "unsound",
      removed: after === undefined,
    });
  }
  return out;
}

/** A pull waiting at the wall: the ledger row and the pull it is about. */
export interface Crossing {
  readonly decision: Decision;
  readonly repo: Repo;
  readonly pull: { readonly number: number; readonly title: string };
  readonly cells: readonly string[];
  /** The same, in plain words: "anyone signed out could read pack records" (#7847). */
  readonly plain: readonly string[];
}

/** Every wall crossing not yet answered, across the repositories given. */
export function crossingsWaiting(
  db: Database,
  repos: readonly Repo[],
): Crossing[] {
  const byId = new Map(repos.map((r) => [r.id, r]));
  const out: Crossing[] = [];
  for (const d of listDecisionsForRepos(db, [...byId.keys()], 500)) {
    if (d.kind !== "land" || d.answer !== "wall" || d.outcome !== null)
      continue;
    if (d.issueId === null) continue;
    const issue = getIssueById(db, d.issueId);
    const repo = byId.get(d.repoId);
    if (issue === undefined || repo === undefined) continue;
    if (issue.state !== "open") continue;
    const state = d.state as { cells?: unknown; plain?: unknown } | null;
    const strings = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((c): c is string => typeof c === "string") : [];
    const cells = strings(state?.cells);
    const plain = strings(state?.plain);
    out.push({
      decision: d,
      repo,
      pull: { number: issue.number, title: issue.title },
      cells,
      plain: plain.length > 0 ? plain : cells,
    });
  }
  return out;
}

/** A probe whose verdict differs from the one before it. */
export interface VerdictChange {
  readonly repo: Repo;
  readonly from: ProbeRow["verdict"] | undefined;
  readonly to: ProbeRow["verdict"];
  readonly at: string;
  readonly commitOid: string;
  readonly said: readonly string[];
}

/** Where an app's doors started or stopped agreeing with its table. */
export function verdictChanges(
  db: Database,
  apps: readonly { readonly repo: Repo; readonly appId: string }[],
  limit = 20,
): VerdictChange[] {
  const out: VerdictChange[] = [];
  for (const { repo, appId } of apps) {
    const rows = listProbes(db, appId, 60);
    // Newest first; compare each with the one before it in time.
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const earlier = rows[i + 1];
      if (earlier !== undefined && earlier.verdict === row.verdict) continue;
      out.push({
        repo,
        from: earlier?.verdict,
        to: row.verdict,
        at: row.createdAt,
        commitOid: row.commitOid,
        said: row.said,
      });
    }
  }
  return out
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, limit);
}

export { wallSentence };
