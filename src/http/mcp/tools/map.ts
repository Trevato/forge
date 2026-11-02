import { sealedScope } from "../../../core/sealed.ts";
import { repoGraph } from "../../../core/dependencies.ts";
import { mapHeldFor } from "../../../crew/held.ts";
import { pillarView } from "../../../core/pillars.ts";
import { askToLiveFor } from "../../../web/ask_to_live.ts";
import { listActiveRuns } from "../../../core/runs.ts";
import { mapJson, marksFor, withoutDone } from "../../../web/pages/map.ts";
import { good, type Tool, APP_ARG, planRepo, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "map",
  doc: "an app's plan: ready now, waiting on what, the critical path, where the crew is, parked twice and why (`app`, `done` to list closed issues too); draws the `ui://forge/map` card",
  description:
    "An app's plan: open issues ready or waiting, critical path, edges, crew, `parkedTwice`; `done: true` adds closed issues.",
  inputSchema: {
    type: "object",
    properties: { app: APP_ARG, done: { type: "boolean" } },
    required: ["app"],
  },
  writes: false,
  async run(ctx, user, args) {
    const repo = planRepo(ctx, user, args);
    if (isAnswer(repo)) return repo;
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
