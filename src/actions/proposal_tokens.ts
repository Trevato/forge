/**
 * Mint, list and revoke proposal tokens (`core/proposal_token.ts`), for every
 * door: `POST /api/v1/repos/:owner/:name/proposal-tokens`, MCP's
 * `proposal_tokens` and the terminal's Proposal tokens screen. A writer of the
 * repository may; anyone else is told what the API says of a repository they
 * cannot see, so the three doors refuse in the same words.
 */

import type { App } from "../app.ts";
import {
  deleteProposalToken,
  listProposalTokens,
  mintProposalToken,
  type ProposalTokenInfo,
} from "../core/proposal_token.ts";
import { canWrite, getRepo, type Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";

export interface ProposalTokenError {
  readonly code: "unauthorized" | "not_found" | "invalid_child" | "invalid_origin";
  readonly message: string;
}

/** The API's own words for a repository that is missing or not yours. */
export const NOT_FOUND_WORDS = "no such resource here, or it is not visible to you";

const fail = (code: ProposalTokenError["code"], message: string) =>
  err<ProposalTokenError>({ code, message });

const INVALID_WORDS = "child is lowercase words and hyphens; origin is an https address";

/** The repository, when the actor writes it. */
function mine(
  app: App,
  actor: User | undefined,
  repo: Repo | undefined,
): Result<{ repo: Repo; actor: User }, ProposalTokenError> {
  if (!actor) return fail("unauthorized", "authenticate with a bearer token or account credentials");
  if (!repo || !canWrite(app.db, repo, actor)) return fail("not_found", NOT_FOUND_WORDS);
  return ok({ repo, actor });
}

/** A repository by `owner/name`, or undefined for anything else. */
export function repoByName(app: App, spec: unknown): Repo | undefined {
  const [owner, name, ...rest] = typeof spec === "string" ? spec.split("/") : [];
  return owner && name && rest.length === 0 ? getRepo(app.db, owner, name) : undefined;
}

/** Mint a token for `child`; the secret comes back once. */
export function mintProposal(
  app: App,
  actor: User | undefined,
  repo: Repo | undefined,
  input: { child: unknown; origin: unknown; childRepo?: unknown },
): Result<{ id: string; token: string }, ProposalTokenError> {
  const found = mine(app, actor, repo);
  if (!found.ok) return found;
  let childRepoId: string | undefined;
  const spec = typeof input.childRepo === "string" ? input.childRepo.trim() : "";
  if (spec !== "") {
    const child = repoByName(app, spec);
    if (!child || child.forkParentId !== found.value.repo.id) return fail("not_found", NOT_FOUND_WORDS);
    childRepoId = child.id;
  }
  const childName = typeof input.child === "string" ? input.child.trim() : "";
  const minted = mintProposalToken(app.db, found.value.actor.id, found.value.repo.id, {
    child: childName,
    origin: typeof input.origin === "string" ? input.origin.trim() : "",
    ...(childRepoId ? { childRepoId } : {}),
  });
  if (!minted.ok) return fail(minted.error, INVALID_WORDS);
  app.bus.append({
    kind: "token.created",
    actorId: found.value.actor.id,
    payload: { tokenId: minted.value.id, name: `proposal:${childName}`, scope: "rw" },
  });
  return ok(minted.value);
}

/** The proposal tokens the actor minted for this repository. */
export function listProposals(
  app: App,
  actor: User | undefined,
  repo: Repo | undefined,
): Result<ProposalTokenInfo[], ProposalTokenError> {
  const found = mine(app, actor, repo);
  if (!found.ok) return found;
  return ok(listProposalTokens(app.db, found.value.actor.id, found.value.repo.id));
}

/** End one of them. */
export function revokeProposal(
  app: App,
  actor: User | undefined,
  repo: Repo | undefined,
  tokenId: unknown,
): Result<null, ProposalTokenError> {
  const found = mine(app, actor, repo);
  if (!found.ok) return found;
  if (
    typeof tokenId !== "string" ||
    !deleteProposalToken(app.db, found.value.actor.id, found.value.repo.id, tokenId)
  )
    return fail("not_found", NOT_FOUND_WORDS);
  app.bus.append({ kind: "token.deleted", actorId: found.value.actor.id, payload: { tokenId } });
  return ok(null);
}
