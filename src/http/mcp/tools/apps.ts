import { appsRuntime, envsFor } from "../../../apps/runtime.ts";
import { listActiveRuns } from "../../../core/runs.ts";
import { appsOf } from "../../../web/studio/asks.ts";
import { bad, good, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "apps",
  doc: "`{ archived? }`: the apps you can see: live or not, where served, how each runs itself, what is working",
  description:
    "Apps you can see: live or not, where served, how each runs, what works.",
  inputSchema: { type: "object", properties: { archived: { type: "boolean" } } },
  writes: false,
  async run(ctx, user, args) {
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
