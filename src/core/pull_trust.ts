/**
 * Whose code the forge runs. A check and a preview execute what a pull
 * proposes; a pull from someone who cannot write the repository runs
 * nothing until a person who can write it approves that exact head. A new
 * push is a new head and waits for a new approval. Pure data, no events.
 *
 * Trusted without asking: a pull whose branch lives in the repository
 * itself (only a writer could push it there), and a fork's pull opened by a
 * writer or the crew from a fork that same person owns. A pull whose head
 * lives in a fork on another forge (a mirror's) is someone else's code and
 * waits like a reader's. So does a proposal (`core/proposal_token.ts`): its
 * branch is in the repository itself, but the one who pushed it holds a
 * child's token, not a writer's hand — a pull with a proposal row, or any
 * head under `child/`, waits for approval whoever opened it. (The head test
 * covers the moment before the row is written.) A push to such a branch
 * with no pull starts nothing: only the default branch and an open pull's
 * branch are ever checked or previewed.
 */
import type { Database } from "bun:sqlite";
import { pullProposalOf } from "./proposal_token.ts";
import { getIssueById, getPull, type Pull } from "./pulls.ts";
import { canWrite, getRepoById, onCrew, type Repo } from "./repos.ts";
import { listReviews } from "./reviews.ts";
import { runGrantedAt } from "./run_grant.ts";
import { foldsIn } from "./trusted_sources.ts";
import { getUserById, type User } from "./users.ts";

const trusted = (db: Database, repo: Repo, user: User | undefined): boolean =>
  canWrite(db, repo, user) || onCrew(db, repo, user);

/** Whether `pull` came in through a child's proposal. */
export const isProposed = (db: Database, pull: Pull): boolean =>
  pull.headBranch.startsWith("child/") ||
  pullProposalOf(db, pull.id) !== undefined;

/** Whether `pull`'s code at `headOid` may run here. */
export function pullMayRun(
  db: Database,
  repo: Repo,
  pull: Pull,
  headOid: string,
): boolean {
  const proposed = isProposed(db, pull);
  // A trusted source's code runs its checks like the crew's (#8937).
  if (foldsIn(db, pull.id)) return true;
  if (!proposed && !pull.crossRepo && pull.originHeadRepo === null) return true;
  if (!proposed && pull.crossRepo && pull.originHeadRepo === null) {
    const author = getUserById(db, pull.authorId);
    const head = getRepoById(db, pull.headRepoId);
    if (
      author !== undefined &&
      head !== undefined &&
      head.ownerId === author.id &&
      trusted(db, repo, author)
    )
      return true;
  }
  if (proposed && grantStands(db, repo, pull, headOid)) return true;
  return approvedAt(db, repo, pull, headOid);
}

/**
 * A grant stands until a person who can write the repository asks for
 * changes to that head after it: the latest word on the head decides, as it
 * does for an approval. A grant again, later, stands again.
 */
function grantStands(
  db: Database,
  repo: Repo,
  pull: Pull,
  headOid: string,
): boolean {
  const at = runGrantedAt(db, pull.id, headOid);
  if (at === undefined) return false;
  return !listReviews(db, pull.id).some((review) => {
    if (
      review.commitOid !== headOid ||
      review.state !== "changes_requested" ||
      review.originAuthor !== null ||
      review.createdAt < at
    )
      return false;
    const reviewer = getUserById(db, review.authorId);
    return (
      reviewer !== undefined &&
      reviewer.kind === "user" &&
      canWrite(db, repo, reviewer)
    );
  });
}

/**
 * A person — never an agent — who can write the repository approved this
 * head, and no such person asked for changes to it since: the latest of
 * their verdicts on this exact head decides.
 */
function approvedAt(
  db: Database,
  repo: Repo,
  pull: Pull,
  headOid: string,
): boolean {
  if (headOid === "") return false;
  let verdict: "approved" | "changes_requested" | undefined;
  for (const review of listReviews(db, pull.id)) {
    if (review.commitOid !== headOid || review.state === "commented") continue;
    if (review.originAuthor !== null) continue;
    const reviewer = getUserById(db, review.authorId);
    if (
      reviewer === undefined ||
      reviewer.kind !== "user" ||
      !canWrite(db, repo, reviewer)
    )
      continue;
    verdict = review.state;
  }
  return verdict === "approved";
}

/**
 * The same question for a run that names its pull by issue id (a check's
 * `issueId`): a run tied to no pull is the repository's own, and runs.
 */
export function issueMayRun(
  db: Database,
  repo: Repo,
  issueId: string | undefined | null,
  headOid: string,
): boolean {
  if (issueId === undefined || issueId === null) return true;
  const issue = getIssueById(db, issueId);
  if (issue === undefined || issue.kind !== "pull") return true;
  const pull = getPull(db, repo.id, issue.number);
  return pull === undefined ? false : pullMayRun(db, repo, pull, headOid);
}
