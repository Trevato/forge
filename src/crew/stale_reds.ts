/**
 * A red pull never sits (#8245). Reworking a red is event-driven
 * (`dispatch.ts`): a missed event, a restart or a roll leaves it red and
 * assigned to a builder with no run, holding its issue. This sweep reads the
 * database each tick, so it needs no memory of what it did:
 *
 * - an open crew pull whose latest check on its head failed, with no run of
 *   its own in the last {@link QUIET_MS} and no person holding it, is checked
 *   again (reason `sweep`); still red, its builder is queued with the failing
 *   test named, within the free slots and {@link PER_TICK} a tick;
 * - past its tries it is parked (`parkPull`): closed with the reason, its
 *   issue unassigned and ready again;
 * - red for over {@link STALE_MS} and conflicting with main, or with no
 *   issue left open to close, it is closed with one line saying why.
 *
 * Left alone: a pull a person holds or is assigned, a person's pull from a
 * branch of the repository, one approved on its head (`red_approved.ts`),
 * a red main shares (`dispatch.ts` waits those out) and a machine failure.
 */

import type { App } from "../app.ts";
import { addComment, assignIssue, setIssueState } from "../actions/issues.ts";
import { checksFor } from "../checks/service.ts";
import { redMain, sharedWithMain } from "../checks/red_main.ts";
import { getHold } from "../core/holds.ts";
import { getIssue, getIssueById } from "../core/issues.ts";
import { closesFromBody, listOpenPulls, pullDir, type Pull } from "../core/pulls.ts";
import type { Repo } from "../core/repos.ts";
import { automaticRunsSince, getRun, INFRA_SUMMARY, type Run } from "../core/runs.ts";
import { getUserById } from "../core/users.ts";
import { QUIET_MS, SWEEP_REASON } from "../flow/stale_reds.ts";
import { mergeable, resolveOid } from "../git/merge.ts";
import { createLog } from "../kernel/log.ts";
import { authorsInRepoPull } from "./authors_pull.ts";
import { agentFor, CHECK_FAILED_LIMIT, lastHumanWord, queueAgentRun } from "./dispatch.ts";
import { approvedOnHead } from "./finishing.ts";
import { parkPullTold } from "./park_pull.ts";
import { failingLine } from "./red_approved.ts";

const log = createLog("stale-reds");

/** How long a pull may stay red before a conflict or a closed issue closes it. */
export const STALE_MS = 24 * 3_600_000;

/** Pulls the sweep re-checks or hands to a builder in one tick: paced, not a burst. */
export const PER_TICK = 3;

/** What the sweep did with one pull. */
export interface StaleMove {
  readonly pull: number;
  readonly did: "re-check queued" | "builder queued" | "parked" | "closed";
}

/** The line a closed stale red carries. */
export const closedLine = (why: string): string =>
  `Closed: red for over 24 h and ${why}; the pull cannot land as it is.`;

interface Row {
  id: string;
  kind: string;
  state: string;
  reason: string;
  created_at: string;
  finished_at: string | null;
  commit_oid: string;
}

/**
 * The red check this head sits on: its latest non-sweep check failed (not a
 * machine failure), and nothing but the sweep has run on the pull since
 * `cutoff`. Undefined for a pull that is not sitting.
 */
function sittingRed(app: App, pull: Pull, now: Date): { run: Run; at: string } | undefined {
  const cutoff = new Date(now.getTime() - QUIET_MS).toISOString();
  const rows = app.db
    .query<Row, [string]>(
      `SELECT id, kind, state, reason, created_at, finished_at, commit_oid FROM run
        WHERE issue_id = ?1 AND kind IN ('agent','check','deploy') AND reason != '${SWEEP_REASON}'
        ORDER BY id DESC LIMIT 20`,
    )
    .all(pull.id);
  for (const r of rows)
    if (r.state === "queued" || r.state === "running" || (r.finished_at ?? r.created_at) > cutoff)
      return undefined;
  const last = rows.find((r) => r.kind === "check" && r.commit_oid === pull.headOid);
  if (last?.state !== "failed" || last.finished_at === null) return undefined;
  const run = getRun(app.db, last.id);
  if (run === undefined || run.summary.startsWith(INFRA_SUMMARY)) return undefined;
  return { run, at: last.finished_at };
}

/** The sweep's own re-check of this head, newest, if one was queued. */
function sweepRun(app: App, pull: Pull): Run | undefined {
  const row = app.db
    .query<{ id: string }, [string, string]>(
      `SELECT id FROM run WHERE kind = 'check' AND issue_id = ?1 AND commit_oid = ?2
          AND reason = '${SWEEP_REASON}' ORDER BY id DESC LIMIT 1`,
    )
    .get(pull.id, pull.headOid);
  return row === null ? undefined : getRun(app.db, row.id);
}

/** Close a stale red with one line; the issue it was for goes back to ready, unassigned. */
function closeRed(app: App, repo: Repo, pull: Pull, why: string): boolean {
  const by = repo.autonomyBy === null ? undefined : getUserById(app.db, repo.autonomyBy);
  const issue = getIssueById(app.db, pull.id);
  if (!by || !issue || issue.state !== "open") return false;
  addComment(app, by, repo, issue, closedLine(why));
  if (!setIssueState(app, by, repo, issue, "closed", { reason: "parked", stale: true }).ok) return false;
  for (const n of closesFromBody(pull.body)) {
    const about = getIssue(app.db, repo.id, n);
    if (about?.state === "open" && about.assigneeId !== null) assignIssue(app, by, repo, about, null);
  }
  log.info("stale red closed", { repo: `${repo.ownerName}/${repo.name}`, pull: pull.number, why });
  return true;
}

/**
 * One pass over a repository's open pulls. `room` is the free builder slots;
 * the re-checks and rework runs together stay within it and {@link PER_TICK}.
 */
export async function sweepStaleReds(
  app: App,
  repo: Repo,
  now: Date,
  room: number,
): Promise<StaleMove[]> {
  const moves: StaleMove[] = [];
  if (repo.autonomy !== "autonomous" || repo.autonomyBy === null) return moves;
  let budget = Math.min(PER_TICK, Math.max(room, 0));
  const main = redMain(app.db, repo.id);
  for (const pull of listOpenPulls(app.db, repo.id)) {
    if (!pull.authorIsAgent || pull.mergedAt !== null || pull.headOid === "") continue;
    if (getHold(app.db, pull.id) !== undefined || authorsInRepoPull(pull)) continue;
    const issue = getIssueById(app.db, pull.id);
    if (!issue || issue.state !== "open") continue;
    const agent = agentFor(app, issue);
    if (!agent) continue;
    if (approvedOnHead(app.db, pull)) continue;
    const red = sittingRed(app, pull, now);
    if (red === undefined || sharedWithMain(main, red.run)) continue;

    // Stale: red over a day and it conflicts, or its issue is gone.
    if (now.getTime() - Date.parse(red.at) >= STALE_MS) {
      const named = closesFromBody(pull.body);
      const live = named.some((n) => getIssue(app.db, repo.id, n)?.state === "open");
      let why: string | undefined =
        named.length > 0 && !live ? "the issue it was for is no longer open" : undefined;
      if (why === undefined) {
        const dir = await pullDir(app.db, app.reposRoot, repo, pull);
        const tip = await resolveOid(dir, `refs/heads/${pull.baseBranch}`);
        if (tip !== undefined && !(await mergeable(dir, tip, pull.headOid)).ok)
          why = "it conflicts with main";
      }
      if (why !== undefined && closeRed(app, repo, pull, why)) {
        moves.push({ pull: pull.number, did: "closed" });
        continue;
      }
    }

    const since = lastHumanWord(app, issue, agent);
    if (automaticRunsSince(app.db, issue.id, since) >= CHECK_FAILED_LIMIT) {
      const why = `the check stayed red through ${CHECK_FAILED_LIMIT} automatic tries: ${failingLine(red.run)}`;
      if (await parkPullTold(app, repo, pull, why, since)) moves.push({ pull: pull.number, did: "parked" });
      continue;
    }

    if (budget <= 0) continue;
    const again = sweepRun(app, pull);
    if (again === undefined) {
      const checks = checksFor(app);
      if (checks === undefined) continue;
      const env = `pull-${pull.number}`;
      const queued = await checks.request(repo, env, pull.headOid, SWEEP_REASON, pull.id);
      if (queued?.reason !== SWEEP_REASON) continue;
      budget--;
      moves.push({ pull: pull.number, did: "re-check queued" });
      continue;
    }
    if (again.state !== "failed" || again.summary.startsWith(INFRA_SUMMARY)) continue;
    // Said as the builder, not as a person: a person's word restarts the tries.
    addComment(
      app,
      agent.user,
      repo,
      issue,
      `Still red on current main: ${failingLine(again)}. Fix it and push.`,
    );
    if (queueAgentRun(app, repo, issue, agent, "check_failed") !== undefined) {
      budget--;
      moves.push({ pull: pull.number, did: "builder queued" });
    }
  }
  return moves;
}
