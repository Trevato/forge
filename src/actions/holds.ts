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
  getHold,
  releaseGreenHold,
  releaseHold,
  setHold,
  type Hold,
} from "../core/holds.ts";
import { getIssueById } from "../core/issues.ts";
import { getPull, type Pull } from "../core/pulls.ts";
import type { Run } from "../core/runs.ts";
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
