import { appsRuntime, envsFor } from "../../../apps/runtime.ts";
import { listActiveRuns } from "../../../core/runs.ts";
import { appsOf } from "../../../web/studio/asks.ts";
import { PULL_RUNS_DEFAULT, PULL_RUNS_MAX, pullRunLines } from "../../../apps/pull.ts";
import { getAppByRepo } from "../../../core/apps.ts";
import { bad, good, isAnswer, repoArg, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "apps",
  doc: "`{ archived? }`: the apps you can see: live or not, where served, how each runs itself, what is working. `{ repo, pulls: true, limit? }`: an adapter's recorded pull runs, newest first, as `GET …/app/pulls` (`limit` 1-100); a reader's",
  description:
    "Apps you can see: live or not, where served, how each runs, what works.",
  inputSchema: {
    type: "object",
    properties: {
      archived: { type: "boolean" },
      repo: { type: "string" },
      pulls: { type: "boolean" },
      limit: { type: "integer" },
    },
  },
  writes: false,
  async run(ctx, user, args) {
    if (args["pulls"] !== undefined) {
      if (args["pulls"] !== true) return bad("invalid", "`pulls` is true");
      const repo = repoArg(ctx, user, args);
      if (isAnswer(repo)) return repo;
      const raw = args["limit"];
      if (
        raw !== undefined &&
        !(typeof raw === "number" && Number.isInteger(raw) && raw >= 1 && raw <= PULL_RUNS_MAX)
      )
        return bad("invalid", `limit is a whole number from 1 to ${PULL_RUNS_MAX}`);
      const record = getAppByRepo(ctx.app.db, repo.id);
      if (record === undefined) return bad("not_found", "no such app or repository (owner/name)");
      return good({
        items: pullRunLines(ctx.app.db, record.id, typeof raw === "number" ? raw : PULL_RUNS_DEFAULT),
        next_cursor: null,
      });
    }
    const flag = args["archived"];
    if (flag !== undefined && typeof flag !== "boolean")
      return bad("invalid", "`archived` is true or false");
    const archived = flag === true;
    const { repos, records } = appsOf(ctx, user, archived);
    const runtime = appsRuntime(ctx.app);
    const active = listActiveRuns(
      ctx.app.db,
      repos.map((r) => r.id),
    );
    return good(
      repos.map((repo) => {
        const record = records.get(repo.id)!;
        const production = envsFor(ctx.app, user, record).find(
          (e) => e.env === "production",
        );
        return {
          app: `${repo.ownerName}/${repo.name}`,
          description: repo.description,
          live: production?.state ?? "stopped",
          url: runtime?.urlFor(record, "production") ?? null,
          autonomy: repo.autonomy,
          working: active.filter((r) => r.repoId === repo.id).length,
          ...(archived ? { archivedAt: repo.archivedAt } : {}),
        };
      }),
    );
  },
};
