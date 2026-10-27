/**
 * Holding a pull and letting it go (`core/holds.ts`).
 *
 * A person who writes the repository decides. An agent is refused even
 * when it is on the crew: the hold is how a person keeps the crew's rules
 * off one pull, so it is not the crew's to set or to lift. A reader and a
 * stranger are refused as they are everywhere.
 *
 * Holding does not close anything and stops no person: whoever may merge
 * the pull still may. It stops the rules, sending a green pull to the
 * crew's reviewer and landing it, until someone releases it.
 */

import type { App } from "../app.ts";
import {
  cleanWhy,
  CREW_HOLD_MS,
  crewHoldsPlacedBefore,
  getHold,
  releaseGreenHold,
  releaseHold,
  setHold,
  type Hold,
} from "../core/holds.ts";
import { getIssueById, setAssignee } from "../core/issues.ts";
import { getRepoById } from "../core/repos.ts";
import { getUserById } from "../core/users.ts";
import { transact } from "../kernel/db.ts";
import { builderOf } from "./give_back.ts";
import { addComment } from "./issues.ts";
import { getPull, type Pull } from "../core/pulls.ts";
import { checksForHead, type Run } from "../core/runs.ts";
import { canRead, canWrite, type Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import type { AccessError } from "./access.ts";

export type HoldError = AccessError | "not_open" | "empty_why" | "why_too_long";

/** A person, never an agent, who writes the repository the pull is in. */
function requireHolder(
  app: App,
  actor: User | undefined,
  repo: Repo,
  pull: Pull,
): Result<User, AccessError> {
  if (pull.repoId !== repo.id || !canRead(app.db, repo, actor))
    return err("not_found");
  if (!actor) return err("unauthorized");
  if (actor.kind !== "user" || !canWrite(app.db, repo, actor))
    return err("forbidden");
  return ok(actor);
}

/**
 * Hold an open pull, with one line that says why. Holding a held pull
 * changes who and why. `dry` checks everything and answers with the hold
 * that would stand, and writes nothing.
 */
export function holdPull(
  app: App,
  actor: User | undefined,
  repo: Repo,
  pull: Pull,
  why: string,
  dry = false,
  until?: "green",
): Result<Hold, HoldError> {
  const holder = requireHolder(app, actor, repo, pull);
  if (!holder.ok) return holder;
  if (pull.state !== "open" || pull.mergedAt !== null) return err("not_open");
  const reason = cleanWhy(why);
  if (!reason.ok) return reason;
  if (dry)
    return ok({
      pullId: pull.id,
      heldBy: holder.value.id,
      heldByName: holder.value.username,
      why: reason.value,
      heldAt: getHold(app.db, pull.id)?.heldAt ?? new Date().toISOString(),
      ...(until ? { until } : {}),
    });
  const hold = setHold(app.db, pull.id, holder.value.id, reason.value, until);
  app.bus.append({
    kind: "pull.held",
    repoId: repo.id,
    actorId: holder.value.id,
    payload: { number: pull.number, why: hold.why },
  });
  // Held on a head whose latest check is already green: nothing is left to
  // wait for, so it is let go at once, with the same line a later check gives.
  if (until === "green") {
    const latest = checksForHead(app.db, pull.id, pull.headOid).find(
      (r) => r.kind === "check",
    );
    if (latest) releaseOnGreen(app, latest);
  }
  return ok(hold);
}

/**
 * Let a pull go. `false` when nothing held it: releasing twice is not an
 * error. `dry` answers whether a hold stands, and lifts nothing.
 */
export function releasePull(
  app: App,
  actor: User | undefined,
  repo: Repo,
  pull: Pull,
  dry = false,
): Result<boolean, AccessError> {
  const holder = requireHolder(app, actor, repo, pull);
  if (!holder.ok) return holder;
  if (dry) return ok(getHold(app.db, pull.id) !== undefined);
  const released = releaseHold(app.db, pull.id, holder.value.id);
  if (released)
    app.bus.append({
      kind: "pull.released",
      repoId: repo.id,
      actorId: holder.value.id,
      payload: { number: pull.number },
    });
  return ok(released);
}

/**
 * A check finished green: a hold set "until green" on that pull is let go
 * when the check was of the pull's current head. The pull's timeline gets
 * the one line. A plain hold, a red check and a check of an older head
 * change nothing.
 */
export function releaseOnGreen(app: App, run: Run): boolean {
  if (run.kind !== "check" || run.state !== "ok" || run.issueId === null)
    return false;
  const issue = getIssueById(app.db, run.issueId);
  if (!issue || issue.kind !== "pull") return false;
  const pull = getPull(app.db, issue.repoId, issue.number);
  if (!pull || pull.state !== "open" || pull.headOid !== run.commitOid)
    return false;
  if (!releaseGreenHold(app.db, pull.id)) return false;
  app.bus.append({
    kind: "pull.released",
    repoId: pull.repoId,
    payload: {
      number: pull.number,
      note: `hold released: green on ${run.commitOid.slice(0, 7)}`,
    },
  });
  return true;
}

/**
 * The tick's sweep: a hold the crew placed (an agent's) that has stood 24 h
 * is released with a comment that names its reason, and the pull goes back
 * to its builder. A person's hold is never touched. Returns the pulls let go.
 */
export function expireCrewHolds(app: App, now = new Date()): number {
  const before = new Date(now.getTime() - CREW_HOLD_MS).toISOString();
  let released = 0;
  for (const hold of crewHoldsPlacedBefore(app.db, before)) {
    // Foreign keys guarantee the pull's issue, its repository and the holder.
    const issue = getIssueById(app.db, hold.pullId)!;
    const repo = getRepoById(app.db, issue.repoId)!;
    const holder = getUserById(app.db, hold.heldBy)!;
    const pull = issue.kind === "pull" ? getPull(app.db, repo.id, issue.number) : undefined;
    const open = pull !== undefined && pull.state === "open";
    transact(app.db, () => {
      if (!releaseHold(app.db, hold.pullId, hold.heldBy)) return;
      released++;
      app.bus.append({
        kind: "pull.released",
        repoId: repo.id,
        payload: { number: issue.number, note: "hold expired after 24 h" },
      });
      if (!open) return;
      const builder = builderOf(app.db, repo, issue);
      const note = `Hold expired after 24 h: ${hold.why}.${builder ? ` Back to @${builder.username}.` : ""}`;
      // The holder may have left the crew; the builder can still speak.
      let said = addComment(app, holder, repo, issue, note);
      if (!said.ok && builder) said = addComment(app, builder, repo, issue, note);
      if (!said.ok)
        app.log.warn("hold expiry note not posted", { pull: issue.number, repo: repo.id, error: said.error });
      // The assignment event is what starts the builder's run.
      if (builder && setAssignee(app.db, issue.id, builder.id))
        app.bus.append({
          kind: "pull.assigned",
          repoId: repo.id,
          actorId: holder.id,
          payload: { number: issue.number, assignee: builder.username, agent: true },
        });
    });
  }
  return released;
}
