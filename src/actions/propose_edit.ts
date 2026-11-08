/**
 * Proposing a change to files: one commit on a new branch, and a pull that
 * asks for it. The shape every person who cannot (or should not) commit to
 * a branch gets, in one call.
 *
 * - A writer — an agent, or a person facing a protected branch — gets the
 *   branch in the repository itself and a pull inside it.
 * - Anyone else who can read the repository gets it on their fork: the fork
 *   they already have, or a new one (`forkRepo`, with its limits), and a
 *   pull from that fork back to the branch they were reading.
 *
 * The commit lands on the fork's copy of `base`, so a fork far behind its
 * parent proposes against its own older snapshot; the pull's mergeability
 * says so, as it does for any fork's pull.
 */

import { GUEST_REFUSALS, isGuestRefusal } from "../core/contribute.ts";
import type { App } from "../app.ts";
import { canWrite, getForkOf, type Repo } from "../core/repos.ts";
import type { Pull } from "../core/pulls.ts";
import type { User } from "../core/users.ts";
import { isSafeRef } from "../git/guard.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { requireParticipant } from "./access.ts";
import { editFiles, type EditFile } from "./contents.ts";
import { openPull } from "./pulls.ts";
import { forkRepo } from "./repos.ts";

export interface ProposeEditInput {
  /** The branch the pull asks to change. */
  readonly base: string;
  readonly files: readonly EditFile[];
  readonly message: string;
  readonly title: string;
  readonly body?: string;
  /** The new branch's name; one is made up (`proposalBranch`) when absent. */
  readonly branch?: string;
}

export interface Proposed {
  readonly pull: Pull;
  /** The repository the commit landed in: `repo` itself, or the actor's fork. */
  readonly head: Repo;
  readonly branch: string;
}

/** A refusal, as the code a page turns into words. */
export type ProposeEditError = { readonly step: "fork" | "commit" | "pull"; readonly reason: string };

/** `alice/edit-settings-lq3k2`: whose, what, and unique enough not to collide. */
export function proposalBranch(username: string, path: string, now = Date.now()): string {
  const name = (path.split("/").pop() ?? "file")
    .replace(/\.[^.]*$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "file";
  return `${username}/edit-${name}-${now.toString(36)}`;
}

const reasonOf = (e: unknown): string =>
  typeof e === "string" ? e : typeof e === "object" && e !== null && "kind" in e ? String((e as { kind: unknown }).kind) : "refused";

export async function proposeEdit(
  app: App,
  actor: User | undefined,
  repo: Repo,
  input: ProposeEditInput,
): Promise<Result<Proposed, ProposeEditError>> {
  const user = requireParticipant(app, actor, repo);
  if (!user.ok) return err({ step: "fork", reason: user.error });
  if (!isSafeRef(input.base)) return err({ step: "commit", reason: "invalid_branch" });

  let head = repo;
  if (!canWrite(app.db, repo, user.value)) {
    const mine = getForkOf(app.db, user.value.id, repo.id);
    if (mine !== undefined) head = mine;
    else {
      const forked = await forkRepo(app, user.value, repo);
      if (!forked.ok) return err({ step: "fork", reason: forked.error });
      head = forked.value;
    }
  }

  const branch = input.branch?.trim() || proposalBranch(user.value.username, input.files[0]?.path ?? "file");
  if (!isSafeRef(branch)) return err({ step: "commit", reason: "invalid_branch" });
  const written = await editFiles(app, user.value, head, {
    base: input.base,
    newBranch: branch,
    message: input.message,
    files: input.files,
  });
  if (!written.ok) return err({ step: "commit", reason: reasonOf(written.error) });

  const pull = await openPull(app, user.value, repo, {
    title: input.title,
    body: input.body ?? "",
    baseBranch: input.base,
    headBranch: branch,
    ...(head.id === repo.id ? {} : { headRepo: head }),
  });
  if (!pull.ok) return err({ step: "pull", reason: reasonOf(pull.error) });
  return ok({ pull: pull.value, head, branch });
}

/** A refused proposal as the sentence the page and the terminal both show. */
export function proposeEditText(error: ProposeEditError): string {
  const { step, reason } = error;
  if (step === "fork") {
    if (reason === "unverified")
      return "Confirm your email first: proposing a change makes a fork, and a fork needs a confirmed address.";
    if (reason === "not_member")
      return "Proposing a change makes a fork, and forks are for members of this forge. Ask its admin to make you one.";
    if (reason === "limit" || reason === "repository_limit" || reason === "storage_limit")
      return "You cannot make another fork right now, so this could not be proposed. Try again later.";
    if (isGuestRefusal(reason)) return GUEST_REFUSALS[reason];
    if (reason === "not_found") return "That repository is not one you can read.";
    return "A fork to carry this change could not be made.";
  }
  if (step === "pull")
    return "The commit landed on a new branch, but the pull request could not be opened. Open it from the branch.";
  if (reason === "invalid_branch") return "That branch name is not one git will take.";
  if (reason === "branch_failed") return "That branch could not be created. It may already exist.";
  return "The change could not be committed, so nothing was proposed.";
}
