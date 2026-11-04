/**
 * Taking a proposal from the week's retrospective (#8704): one tap by a person
 * who writes here, and it is the same move as the Next up page's `Not now`
 * (`actions/next.ts`). Each proposal is taken at most once; nothing else in
 * the retrospective ever changes anything.
 */
import type { App } from "../app.ts";
import { getIssue } from "../core/issues.ts";
import { canWrite, type Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { latestRetro, takenOf } from "../flow/retro.ts";
import { rankIssue, type NextError } from "./next.ts";

export const WEEK_PERSON = "Only a person takes a proposal; an agent proposes and a person lands.";
export const WEEK_FORBIDDEN = "Only someone with write access can take a proposal.";

export function takeProposal(
  app: App,
  actor: User,
  repo: Repo,
  weekEnd: string,
  idx: number,
): Result<string, NextError> {
  // A person's tap, whatever the door: an agent proposes and never takes, a reader cannot.
  if (actor.kind === "agent") return err({ kind: "forbidden", message: WEEK_PERSON });
  if (!canWrite(app.db, repo, actor)) return err({ kind: "forbidden", message: WEEK_FORBIDDEN });
  const retro = latestRetro(app.db, repo.id);
  const proposal = retro?.weekEnd === weekEnd ? retro.proposals[idx] : undefined;
  if (proposal === undefined) return err({ kind: "not_found", message: "No such proposal." });
  if (takenOf(app.db, repo.id, weekEnd).has(idx))
    return err({ kind: "invalid", message: "That proposal was already taken." });
  const issue = getIssue(app.db, repo.id, proposal.number);
  if (issue === undefined) return err({ kind: "not_found", message: "No such issue." });
  const moved = rankIssue(app, actor, repo, proposal.number, { to: "not_now" });
  if (!moved.ok) return moved;
  app.db
    .query("INSERT OR IGNORE INTO week_retro_taken (repo_id, week_end, idx, actor_id, at) VALUES (?1, ?2, ?3, ?4, ?5)")
    .run(repo.id, weekEnd, idx, actor.id, new Date().toISOString());
  return ok(`#${proposal.number} is not now.`);
}
