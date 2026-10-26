import { scopeAllows } from "../../../core/tokens.ts";
import { DIRECTION_NOTE, directionNote, OUTSIDERS_NOTE } from "../../../crew/direct.ts";
import { setCrewOutsiders } from "../../../actions/repos.ts";
import { good, bad, type Tool, REPO_ARG, repoArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "outsiders",
  doc: "`{ repo, on?, dryRun? }`: whether people who cannot write may direct the crew; with `on`, planned first (`dryRun` is true unless `false`); set only by the app's admin with an admin token, never an agent",
  description:
    "Whether non-writers may direct an app's crew (off by default). No `on` reads it.",
  inputSchema: {
    type: "object",
    properties: {
      repo: REPO_ARG,
      on: { type: "boolean" },
      dryRun: { type: "boolean" },
    },
    required: ["repo"],
  },
  writes: true,
  dryByDefault: true,
  async run(ctx, user, args) {
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
    if (typeof args["on"] !== "boolean")
      return good({ on: repo.crewOutsiders, says: directionNote(repo) });
    const dryRun = args["dryRun"] !== false;
    if (!dryRun && !scopeAllows(ctx.auth.scope ?? "ro", "admin"))
      return bad("forbidden", "setting who directs the crew needs an admin token");
    const set = await setCrewOutsiders(ctx.app, user, repo, args["on"], dryRun);
    if (!set.ok)
      return bad("forbidden", "only an admin of this app sets who directs its crew");
    return good({
      ...set.value,
      says: dryRun
        ? `This is the plan; nothing changed. Outsiders ${set.value.was ? "may" : "may not"} trigger the crew now; send dryRun: false to ${set.value.on ? "let them" : "stop them"}.`
        : set.value.on
          ? OUTSIDERS_NOTE
          : DIRECTION_NOTE,
    });
  },
};
