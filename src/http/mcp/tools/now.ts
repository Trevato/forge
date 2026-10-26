import { mayViewId } from "../../../core/sealed.ts";
import { getIssueById, listOpenAgentPullsVisibleTo } from "../../../core/issues.ts";
import { waitsForPerson } from "../../../crew/review.ts";
import { getPull } from "../../../core/pulls.ts";
import { ownerFactRepoIds } from "../../../core/repos.ts";
import { plannerDeclines } from "../../../crew/autonomy.ts";
import { listActiveRuns } from "../../../core/runs.ts";
import { getUsersByIds } from "../../../core/users.ts";
import { appsOf } from "../../../web/studio/asks.ts";
import { mayReadRuns, runForReader } from "../../../actions/runs.ts";
import { placementWords } from "../../../checks/placement.ts";
import { good, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "now",
  doc: "what the crew is doing right now: who, on what, since when, at what cost; a planner that declined the direction and waits for you comes first (`run: null`, its words in `says`)",
  description:
    "What the crew is doing across your apps: who, on what, since when, cost; what awaits review.",
  inputSchema: { type: "object", properties: {} },
  writes: false,
  run(ctx, user) {
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
    const ownRepos = repos.filter((r) => owned.has(r.id));
    const reviewWaits = listOpenAgentPullsVisibleTo(ctx.app.db, user, 200)
      .filter((i) => ownRepos.some((r) => r.id === i.repoId))
      .flatMap((issue) => {
        const pull = getPull(ctx.app.db, issue.repoId, issue.number);
        const repo = byId.get(issue.repoId);
        const wait = pull && repo ? waitsForPerson(ctx.app.db, repo.id, pull) : undefined;
        return wait === undefined || repo === undefined
          ? []
          : [
              {
                run: null,
                app: `${repo.ownerName}/${repo.name}`,
                who: "you",
                on: `#${issue.number} ${issue.title}`,
                why: "review",
                state: "waiting for your review",
                says: wait.why === "lapsed" ? "the reviewer did not answer" : "no reviewer on the crew",
                since: wait.since,
                costUsd: 0,
              },
            ];
      });
    return good([
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
    ]);
  },
};
