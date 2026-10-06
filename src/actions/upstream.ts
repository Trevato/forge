/**
 * Propose upstream: a fork's own work, offered to the parent as one pull.
 *
 * The words are assembled, not asked for: every change that landed on the
 * fork since it last proposed is a line in the body, its title the pull's
 * title when there is one and a count when there are several. A person
 * presses one button and lands on the pull; nothing waits on the crew. A
 * proposal already open is returned rather than doubled.
 */

import type { App } from "../app.ts";
import { forkRelation } from "../core/following.ts";
import {
  forkParentFor,
  type Repo,
} from "../core/repos.ts";
import { listPulls, mergedPullsForRepos, type Pull } from "../core/pulls.ts";
import type { User } from "../core/users.ts";
import { aheadOids } from "../git/merge.ts";
import { repoDir } from "../git/repos.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { requireWriter, type AccessError } from "./access.ts";
import { openPull } from "./pulls.ts";

export interface Proposal {
  readonly pull: Pull;
  /** False when a proposal was already open and is returned as it stands. */
  readonly opened: boolean;
  /** How many of the fork's landed changes the proposal names. */
  readonly changes: number;
}

export type ProposeUpstreamError =
  | AccessError
  | "not_a_fork"
  | "nothing_to_propose"
  | { readonly kind: "refused"; readonly reason: string };

/** The open proposal from this fork's default branch, if one is. */
export function openProposal(
  app: App,
  fork: Repo,
  parent: Repo,
): Pull | undefined {
  return listPulls(app.db, parent.id, { sealed: true, state: "open", limit: 200 }).find(
    (p) => p.headRepoId === fork.id && p.headBranch === fork.defaultBranch,
  );
}

export async function proposeUpstream(
  app: App,
  actor: User | undefined,
  fork: Repo,
): Promise<Result<Proposal, ProposeUpstreamError>> {
  const writer = requireWriter(app, actor, fork);
  if (!writer.ok) return writer;
  const parent = forkParentFor(app.db, fork, actor);
  if (parent === undefined) return err("not_a_fork");
  const already = openProposal(app, fork, parent);
  if (already !== undefined)
    return ok({ pull: already, opened: false, changes: 0 });
  const relation = await forkRelation(app, fork, parent);
  if (relation === undefined || relation.ahead === 0)
    return err("nothing_to_propose");

  // What landed on the fork since it last proposed: the pulls, newest last,
  // so the body reads in the order the work happened — and only the pulls
  // whose landing commit is actually ahead of the parent. A fork whose work
  // reached upstream some other way (a push, a release) does not propose it
  // twice; without this, a first proposal once listed forty changes for one
  // commit ahead.
  const lastProposal = listPulls(app.db, parent.id, { sealed: true,
    state: "closed",
    limit: 200,
  })
    .filter((p) => p.headRepoId === fork.id)
    .map((p) => p.createdAt)
    .sort()
    .at(-1);
  const ahead = await aheadOids(
    repoDir(app.reposRoot, fork.ownerName, fork.name),
    relation.parentTip,
    relation.forkTip,
  );
  const landed = mergedPullsForRepos(app.db, [fork.id], 40)
    .filter(
      (p) =>
        p.mergedAt !== null &&
        p.mergedOid !== null &&
        ahead.has(p.mergedOid) &&
        (lastProposal === undefined || p.mergedAt > lastProposal),
    )
    .reverse();
  const name = `${fork.ownerName}/${fork.name}`;
  const title =
    landed.length === 1
      ? landed[0]!.title
      : landed.length > 1
        ? `${landed.length} changes from ${name}`
        : `${relation.ahead} commit${relation.ahead === 1 ? "" : "s"} from ${name}`;
  const lines = landed.map((p) => `- ${p.title} (${name}#${p.number})`);
  const body = [
    ...(lines.length > 0 ? [lines.join("\n")] : []),
    `${relation.ahead} commit${relation.ahead === 1 ? "" : "s"} ahead of ${parent.ownerName}/${parent.name}, proposed from ${name}'s following card.`,
  ].join("\n\n");
  const opened = await openPull(app, actor, parent, {
    title,
    body,
    baseBranch: parent.defaultBranch,
    headBranch: fork.defaultBranch,
    headRepo: fork,
  });
  if (!opened.ok)
    return err({
      kind: "refused",
      reason:
        typeof opened.error === "string"
          ? opened.error
          : ((opened.error as { kind?: string }).kind ?? "refused"),
    });
  return ok({ pull: opened.value, opened: true, changes: landed.length });
}
