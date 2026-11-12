/**
 * Conflicted approved pulls (#7556): each goes to the builder who can push to its branch
 * (`ownBuilder`, the push check #7006 made), at most `CAP` per run. After `ATTEMPTS` re-assignments
 * with no new head the keeper stops and says so on the pull, once per head.
 */

import type { Database } from "bun:sqlite";
import { listCrewRoles, type Agent } from "../../core/agents.ts";
import { getIssueById, setAssignee } from "../../core/issues.ts";
import { getRepoById } from "../../core/repos.ts";
import { listActive } from "../../core/runs.ts";
import { ownBuilder } from "../../crew/finishing.ts";
import { nameOf, type KPull } from "./pulls.ts";
import { countNotes, note, sayOnce } from "./record.ts";

export const CAP = 6;
export const ATTEMPTS = 2;

export interface Moves {
  readonly reassigned: string[];
  readonly stopped: string[];
  /** Conflicted pulls past the cap, left for the next run. */
  readonly waiting: string[];
}

export function rebasePass(db: Database, pulls: readonly KPull[], conflicted: ReadonlySet<string>): Moves {
  const out: Moves = { reassigned: [], stopped: [], waiting: [] };
  const load = new Map<string, number>();
  for (const run of listActive(db, "agent")) if (run.actorId !== null) load.set(run.actorId, (load.get(run.actorId) ?? 0) + 1);
  const crews = new Map<string, Agent[]>();
  for (const pull of pulls) {
    if (!pull.approved || pull.hold !== undefined || !conflicted.has(nameOf(pull))) continue;
    const issue = getIssueById(db, pull.id);
    const repo = getRepoById(db, pull.repoId);
    if (issue === undefined || repo === undefined) continue;
    let builders = crews.get(pull.repoId);
    if (builders === undefined) {
      builders = listCrewRoles(db, pull.repoId).filter((c) => c.role === "builder").map((c) => c.agent);
      crews.set(pull.repoId, builders);
    }
    // A person's name on it is a person holding it: reported by `handed.ts`, never moved.
    if (issue.assigneeId !== null && !builders.some((b) => b.user.id === issue.assigneeId) && isPerson(db, issue.assigneeId)) continue;
    const tried = countNotes(db, "keeper_rebase", "pull", pull.id, pull.headOid);
    if (tried >= ATTEMPTS) {
      const said = sayOnce(
        db,
        pull,
        `rebase-stop:${pull.id}:${pull.headOid}`,
        `this pull is approved and conflicts with ${repo.defaultBranch}; I assigned it to a builder ${tried} times and the head did not move, so I stop. Merge ${repo.defaultBranch} into it, or push a new head and I will look again.`,
      );
      if (said) out.stopped.push(nameOf(pull));
      continue;
    }
    const builder = ownBuilder(issue, builders, load, pull.headRepoId === null ? undefined : getRepoById(db, pull.headRepoId)?.ownerId);
    if (builder === undefined || builder.user.id === issue.assigneeId) continue;
    if (out.reassigned.length >= CAP) {
      out.waiting.push(nameOf(pull));
      continue;
    }
    setAssignee(db, pull.id, builder.user.id);
    note(db, "keeper_rebase", pull.repoId, { pull: pull.id, number: pull.number, head: pull.headOid, builder: builder.user.username });
    load.set(builder.user.id, (load.get(builder.user.id) ?? 0) + 1);
    out.reassigned.push(`${nameOf(pull)} to ${builder.user.username}`);
  }
  return out;
}

const isPerson = (db: Database, userId: string): boolean =>
  db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM user WHERE id = ?1 AND is_agent = 0").get(userId)!.n > 0;
