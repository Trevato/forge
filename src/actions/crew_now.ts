/**
 * What the crew is doing right now, as data, for the doors that are not a
 * page (the MCP `now` tool and GET /api/v1/crew/now): who, on what, since
 * when, at what cost. A planner that declined the direction and waits for
 * the reader comes first. The visibility checks live here, not in a caller.
 */
import { mayViewId } from "../core/sealed.ts";
import { getIssueById, listOpenAgentPullsVisibleTo } from "../core/issues.ts";
import { reviewWaitsFor } from "../crew/review.ts";
import { joinMany } from "../core/pulls.ts";
import { ownerFactRepoIds } from "../core/repos.ts";
import { reviewSays } from "../crew/review_says.ts";
import { reviewerPaused } from "../crew/reviewer_paused.ts";
import { plannerDeclines } from "../crew/autonomy.ts";
import { listActiveRuns } from "../core/runs.ts";
import { getUsersByIds } from "../core/users.ts";
import { appsOf } from "../web/studio/asks.ts";
import { mayReadRuns, runForReader } from "./runs.ts";
import { placementWords } from "../checks/placement.ts";
import type { Ctx } from "../http/context.ts";
import type { User } from "../core/users.ts";

/** Rows of the crew's work as `user` may see them (none for no one). */
export function crewNow(ctx: Pick<Ctx, "app">, user: User) {
  const { repos } = appsOf(ctx, user);
  const byId = new Map(repos.map((r) => [r.id, r]));
  // A private app's runs are for those who may enter it (`mayReadRuns`).
  // A run on a sealed report is for those who may see the report.
  const runs = listActiveRuns(
    ctx.app.db,
    repos.filter((r) => mayReadRuns(ctx.app, user, r)).map((r) => r.id),
  ).filter((r) =>
    mayViewId(ctx.app.db, byId.get(r.repoId)!, r.issueId, user),
  );
  const actors = getUsersByIds(
    ctx.app.db,
    runs.map((r) => r.actorId).filter((id): id is string => id !== null),
  );
  // A planner that declined the direction is the crew waiting on you:
  // it rides the same list, as a row with no run.
  // Owner facts only: a stranger's public app never shows its planner here.
  const owned = ownerFactRepoIds(ctx.app.db, repos, user);
  const waiting = plannerDeclines(
    ctx.app.db,
    repos.filter((r) => owned.has(r.id)),
  ).map((d) => ({
    run: null,
    app: `${d.repo.ownerName}/${d.repo.name}`,
    who: "the planner",
    on: `#${d.issue.number} ${d.issue.title}`,
    why: "declined",
    state: "waiting for you",
    says: d.words,
    since: d.at,
    costUsd: 0,
  }));
  // An agent's green pull that waits for a person's review (#597): no
  // reviewer on the crew, or one that lapsed — with its age, never silent.
  // Read for the whole set at once (#11119): the pull rows in one `IN`, and
  // `reviewWaitsFor` reads holds, verdicts, hand-overs and reviewers once
  // for every pull, where one pull at a time was ~11 statements a pull,
  // 2,200 for the 200 this lists, on every forge-view build.
  const pulls = joinMany(
    ctx.app.db,
    listOpenAgentPullsVisibleTo(ctx.app.db, user, 200).filter((i) => owned.has(i.repoId)),
  ).flatMap((pull) => {
    const repo = byId.get(pull.repoId);
    return repo === undefined ? [] : [{ repo, pull }];
  });
  const waits = reviewWaitsFor(ctx.app.db, pulls);
  const reviewWaits = pulls.flatMap(({ repo, pull }) => {
    const wait = waits.get(pull.id)?.person;
    return wait === undefined
      ? []
      : [
          {
            run: null,
            app: `${repo.ownerName}/${repo.name}`,
            who: "you",
            on: `#${pull.number} ${pull.title}`,
            why: "review",
            state: "waiting for your review",
            says: reviewSays(wait, reviewerPaused(repo)),
            since: wait.since,
            costUsd: 0,
          },
        ];
  });
  return [
    ...waiting,
    ...reviewWaits,
    ...runs.map((run) => {
      const repo = byId.get(run.repoId)!;
      // As this caller may read it (`runForReader`): cost and node are
      // the owner's facts.
      const r = runForReader(ctx.app, user, repo)(run);
      const issue =
        r.issueId === null
          ? undefined
          : getIssueById(ctx.app.db, r.issueId);
      return {
        run: r.id,
        app: `${repo.ownerName}/${repo.name}`,
        who: (r.actorId && actors.get(r.actorId)?.username) || "the crew",
        on: issue === undefined ? null : `#${issue.number} ${issue.title}`,
        why: r.reason,
        state: r.state,
        since: r.startedAt ?? r.createdAt,
        costUsd: r.costUsd,
        ...(placementWords(r) === "" ? {} : { ran: placementWords(r) }),
      };
    }),
  ];
}
