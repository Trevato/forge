import { appsRuntime } from "../../../apps/runtime.ts";
import { getAppByRepo } from "../../../core/apps.ts";
import { canWrite } from "../../../core/repos.ts";
import { probeApp } from "../../../contract/probes.ts";
import { good, bad, type Tool, REPO_ARG, repoArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "probe",
  doc: "`{ repo }`: knock on a running app's doors as nobody, a user and an admin; the ones that disobey its contract",
  description:
    "Try every door of a running app as nobody, a user and an admin; read-only.",
  inputSchema: {
    type: "object",
    properties: { repo: REPO_ARG },
    required: ["repo"],
  },
  writes: false,
  async run(ctx, user, args) {
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
    if (!canWrite(ctx.app.db, repo, user))
      return bad("forbidden", "you need write access to knock");
    const record = getAppByRepo(ctx.app.db, repo.id);
    const runtime = appsRuntime(ctx.app);
    if (record === undefined || runtime === undefined)
      return bad("not_an_app", "nothing is serving that app here");
    const row = await probeApp(ctx.app, runtime, record);
    if (row === undefined)
      return bad(
        "no_contract",
        "that app has no sound contract to compare with",
      );
    return good({
      verdict: row.verdict,
      commit: row.commitOid,
      said: row.said,
      asked: row.knocks.filter((k) => k.verdict !== "unprobed").length,
      unprobed: row.knocks.filter((k) => k.verdict === "unprobed").length,
    });
  },
};
