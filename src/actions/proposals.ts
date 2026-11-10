/**
 * The four things a person does with a wave proposal (`core/proposals.ts`),
 * for every door (the web form, `POST /api/v1/asks/proposal/:id/<verb>`,
 * MCP's `asks_proposal` and the terminal): approve opens its issues exactly
 * as an unheld plan would,
 * redirect hands the owner's words to the planner as a new run, later puts
 * it aside, and again brings it back. Each takes the actor and the id,
 * checks the actor is who the card asks (the same predicate as the asks
 * list) and hands back plain data.
 */

import type { App } from "../app.ts";
import { listCrewRoles } from "../core/agents.ts";
import { getProposal, moveProposal, type Proposal, type ProposalState } from "../core/proposals.ts";
import { ARCHIVED_WHY, getRepoById, ownerFactRepoIds, canRead, type Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { ensureDirectionIssue } from "../crew/autonomy.ts";
import { queueAgentRun } from "../crew/dispatch.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { MAX_BODY } from "../core/issues.ts";
import { NOT_A_MEMBER } from "../core/roles.ts";
import { requireAbility } from "./roles.ts";
import { assignIssue, addComment } from "./issues.ts";
import { openPlan, parsePlan, type Planned } from "./plan.ts";
import { SIGN_IN_TO_ACT } from "./asks_words.ts";

export interface ProposalError {
  readonly code: "unauthorized" | "not_found" | "forbidden" | "invalid" | "conflict";
  readonly message: string;
}

const fail = (code: ProposalError["code"], message: string) =>
  err<ProposalError>({ code, message });

/** An error from another action as a sentence, never "[object Object]". */
function errorWords(e: unknown): string {
  if (typeof e === "string") return e;
  const m = e !== null && typeof e === "object" ? (e as { message?: unknown }).message : undefined;
  return typeof m === "string" ? m : "it was refused";
}

/** The proposal and its repository, when this person is who it asks and it is in one of `states`. */
function mine(
  app: App,
  actor: User | undefined,
  id: unknown,
  states: readonly ProposalState[],
): Result<{ proposal: Proposal; repo: Repo; actor: User }, ProposalError> {
  if (!actor) return fail("unauthorized", SIGN_IN_TO_ACT);
  const proposal = typeof id === "string" ? getProposal(app.db, id) : undefined;
  const repo = proposal ? getRepoById(app.db, proposal.repoId) : undefined;
  if (!proposal || !repo || !canRead(app.db, repo, actor))
    return fail("not_found", "no such proposal");
  if (!ownerFactRepoIds(app.db, [repo], actor).has(repo.id))
    return fail("forbidden", "a proposal is the owner's to decide");
  if (!states.includes(proposal.state))
    return fail("conflict", "it was already decided");
  return ok({ proposal, repo, actor });
}

/** Open the proposal's issues with their links, as `openPlan` does for a plan nobody held. */
export function approveProposal(
  app: App,
  actor: User | undefined,
  id: unknown,
): Result<Planned, ProposalError> {
  const found = mine(app, actor, id, ["pending", "later"]);
  if (!found.ok) return found;
  const { proposal, repo } = found.value;
  const items = parsePlan(proposal.issues);
  if (!items.ok) return fail("invalid", items.error.message);
  // Taken first, so two taps open the issues once.
  if (!moveProposal(app.db, proposal.id, ["pending", "later"], "approved"))
    return fail("conflict", "it was already decided");
  const opened = openPlan(app, found.value.actor, repo, items.value);
  if (!opened.ok) {
    moveProposal(app.db, proposal.id, ["approved"], proposal.state);
    return fail("invalid", opened.error.message);
  }
  return ok(opened.value);
}

/** Hand the owner's words to the planner as a new run on the direction issue. */
export function redirectProposal(
  app: App,
  actor: User | undefined,
  id: unknown,
  words: unknown,
): Result<{ issue: number }, ProposalError> {
  const said = typeof words === "string" ? words.trim() : "";
  if (said === "") return fail("invalid", "say what the planner should do instead");
  if (said.length > MAX_BODY) return fail("invalid", `the words are over ${MAX_BODY} characters`);
  const found = mine(app, actor, id, ["pending", "later"]);
  if (!found.ok) return found;
  const { proposal, repo } = found.value;
  // The run it starts is a member's: refused before anything is written.
  if (!requireAbility(app, found.value.actor, "run_crew").ok) return fail("forbidden", NOT_A_MEMBER);
  if (repo.archivedAt !== null) return fail("invalid", ARCHIVED_WHY);
  const planner = listCrewRoles(app.db, repo.id).find((c) => c.role === "planner")?.agent;
  if (planner === undefined) return fail("invalid", "no planner on this crew to hand it to");
  const direction = ensureDirectionIssue(app, found.value.actor, repo);
  if (!direction) return fail("invalid", "this app has no direction issue to plan from");
  if (!moveProposal(app.db, proposal.id, ["pending", "later"], "redirected"))
    return fail("conflict", "it was already decided");
  const wrote = addComment(
    app,
    found.value.actor,
    repo,
    direction,
    `Redirect: not the wave "${proposal.title}" as proposed.\n\n${said}`,
  );
  if (!wrote.ok) {
    moveProposal(app.db, proposal.id, ["redirected"], proposal.state);
    return fail("invalid", `could not write to the direction issue: ${errorWords(wrote.error)}`);
  }
  if (direction.assigneeId === planner.user.id) {
    queueAgentRun(app, repo, direction, planner, "feedback", found.value.actor.id);
  } else {
    if (direction.assigneeId !== null) assignIssue(app, found.value.actor, repo, direction, null);
    assignIssue(app, found.value.actor, repo, direction, planner.user);
  }
  return ok({ issue: direction.number });
}

/** Hide the proposal until the owner brings it back. */
export function laterProposal(
  app: App,
  actor: User | undefined,
  id: unknown,
): Result<null, ProposalError> {
  const found = mine(app, actor, id, ["pending"]);
  if (!found.ok) return found;
  return moveProposal(app.db, found.value.proposal.id, ["pending"], "later")
    ? ok(null)
    : fail("conflict", "it was already decided");
}

/** Bring a proposal put aside back among the asks. */
export function againProposal(
  app: App,
  actor: User | undefined,
  id: unknown,
): Result<null, ProposalError> {
  const found = mine(app, actor, id, ["later"]);
  if (!found.ok) return found;
  return moveProposal(app.db, found.value.proposal.id, ["later"], "pending")
    ? ok(null)
    : fail("conflict", "it was already decided");
}

export const PROPOSAL_VERBS = ["approve", "redirect", "later", "again"] as const;
export type ProposalVerb = (typeof PROPOSAL_VERBS)[number];

/** Whether a door's word names one of the four verbs. */
export const isProposalVerb = (v: unknown): v is ProposalVerb =>
  typeof v === "string" && (PROPOSAL_VERBS as readonly string[]).includes(v);

/** One verb on one proposal: what every door calls, so each does the same thing. */
export function actOnProposal(
  app: App,
  actor: User | undefined,
  verb: ProposalVerb,
  id: unknown,
  words?: unknown,
): Result<unknown, ProposalError> {
  if (verb === "approve") return approveProposal(app, actor, id);
  if (verb === "redirect") return redirectProposal(app, actor, id, words);
  if (verb === "later") return laterProposal(app, actor, id);
  return againProposal(app, actor, id);
}
