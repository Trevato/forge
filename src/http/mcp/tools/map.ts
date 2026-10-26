import { sealedScope } from "../../../core/sealed.ts";
import { repoGraph } from "../../../core/dependencies.ts";
import { pillarView } from "../../../core/pillars.ts";
import { askToLiveFor } from "../../../web/ask_to_live.ts";
import { listActiveRuns } from "../../../core/runs.ts";
import { mapJson, marksFor } from "../../../web/pages/map.ts";
import { good, type Tool, APP_ARG, planRepo, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "map",
  doc: "an app's plan: ready now, waiting on what, the critical path, where the crew is, parked twice and why (`app`); draws the `ui://forge/map` card",
  description:
    "An app's plan: open issues ready or waiting, critical path, edges, where the crew is, `parkedTwice`.",
  inputSchema: {
    type: "object",
    properties: { app: APP_ARG },
    required: ["app"],
  },
  writes: false,
  async run(ctx, user, args) {
    const repo = planRepo(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const graph = repoGraph(ctx.app.db, repo.id, {
      ...sealedScope(ctx.app.db, repo, user),
    });
    const pillars = pillarView(ctx.app.db, repo);
    return good(
      mapJson(
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
      ),
    );
  },
};
