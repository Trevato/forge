import { appsRuntime, envsFor } from "../../../apps/runtime.ts";
import { listActiveRuns } from "../../../core/runs.ts";
import { appsOf } from "../../../web/studio/asks.ts";
import { PULL_RUNS_DEFAULT, PULL_RUNS_MAX, pullRunLines } from "../../../apps/pull.ts";
import { envPull } from "../../../apps/data.ts";
import { getUserById } from "../../../core/users.ts";
import { getAppByRepo } from "../../../core/apps.ts";
import { bad, good, isAnswer, repoArg, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "apps",
    doc: "`{ archived? }`: your apps (`ui://forge/app` card): live or not, what is working, running `previews`, `crew` with a run now. `{ repo, pulls: true, limit? }`: an adapter's pull runs, as `GET …/app/pulls` (`limit`); a reader's",
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
    // One read per actor, not per run per repo.
    const names = new Map<string, string>();
    for (const r of active)
      if (r.actorId !== null && !names.has(r.actorId)) names.set(r.actorId, getUserById(ctx.app.db, r.actorId)?.username ?? "");
    return good(
      repos.map((repo) => {
        const record = records.get(repo.id)!;
        const envs = envsFor(ctx.app, user, record);
        const production = envs.find((e) => e.env === "production");
        const previews = envs.flatMap((e) =>
          e.state === "running" && envPull(e.env) !== undefined ? [{ pull: envPull(e.env)!, url: e.url }] : [],
        );
        const mine = active.filter((r) => r.repoId === repo.id);
        const crew = [...new Set(mine.flatMap((r) => (r.actorId === null ? [] : [names.get(r.actorId) ?? ""])))].filter((n) => n !== "");
        return {
          app: `${repo.ownerName}/${repo.name}`,
          description: repo.description,
          live: production?.state ?? "stopped",
          url: runtime?.urlFor(record, "production") ?? null,
          autonomy: repo.autonomy,
          working: mine.length,
          previews,
          crew,
          ...(archived ? { archivedAt: repo.archivedAt } : {}),
        };
      }),
    );
  },
};
