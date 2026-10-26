import { appsRuntime, envsFor } from "../../../apps/runtime.ts";
import { listActiveRuns } from "../../../core/runs.ts";
import { appsOf } from "../../../web/studio/asks.ts";
import { good, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "apps",
  doc: "the apps you can see: live or not, where served, how each runs itself, what is working",
  description:
    "The apps here you can see: live or not, where served, how each runs, what is working.",
  inputSchema: { type: "object", properties: {} },
  writes: false,
  async run(ctx, user) {
    const { repos, records } = appsOf(ctx, user);
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
        };
      }),
    );
  },
};
