import { sealedScope } from "../../../core/sealed.ts";
import { repoGraph } from "../../../core/dependencies.ts";
import { mapHeldFor } from "../../../crew/held.ts";
import { pillarView } from "../../../core/pillars.ts";
import { askToLiveFor } from "../../../web/ask_to_live.ts";
import { listActiveRuns } from "../../../core/runs.ts";
import { mapJson, marksFor, withoutDone } from "../../../web/pages/map.ts";
import { putIssueFirst } from "../../../actions/first.ts";
import { bad, good, type Tool, APP_ARG, planRepo, isAnswer, issueArg } from "../shared.ts";

export const tool: Tool = {
  name: "map",
  doc: "an app's plan: ready now, waiting on what, the critical path, where the crew is, parked twice and why (`app`, `done` to list closed issues too; `first: <number>` puts that ready issue first, for writers: a reader is forbidden, a closed or blocked issue invalid); draws the `ui://forge/map` card",
  description:
    "An app's plan: ready or waiting, critical path, crew, parkedTwice; `done` adds closed; `first: N` ranks N first.",
  inputSchema: {
    type: "object",
    properties: { app: APP_ARG, done: { type: "boolean" }, first: { type: "integer", minimum: 1 } },
    required: ["app"],
  },
  writes: true,
  readsWithout: "first",
  async run(ctx, user, args) {
    const repo = planRepo(ctx, user, args);
    if (isAnswer(repo)) return repo;
    if (args["first"] !== undefined) {
      const issue = issueArg(ctx, repo, args, "first");
      if ("ok" in issue) return issue;
      const put = putIssueFirst(ctx.app, user, repo, issue.number);
      if (!put.ok) return bad(put.error.kind === "not_found" ? "no_such_issue" : put.error.kind, put.error.message);
    }
    const scope = sealedScope(ctx.app.db, repo, user);
    const graph = repoGraph(ctx.app.db, repo.id, { ...scope });
    const pillars = pillarView(ctx.app.db, repo);
    const map = mapJson(
        repo,
        graph,
        marksFor(
          ctx.app.db,
          repo.id,
          graph,
          listActiveRuns(ctx.app.db, [repo.id]),
        ),
        pillars,
        askToLiveFor(ctx.app, repo, pillars, user),
        mapHeldFor(ctx.app, repo, graph, scope),
    );
    return good(args.done === true ? map : withoutDone(map));
  },
};
