import { updateRepoSettings } from "../../../actions/repos.ts";
import { good, bad, type Tool, REPO_ARG, repoArg, isAnswer } from "../shared.ts";
import { VISIBILITY_WORDS } from "../../../core/arg_words.ts";

export const tool: Tool = {
  name: "repo_settings",
  doc: "`{ repo, description?, visibility?, flowOnly? }` (admin): change a repository's description, visibility and FLOW ONLY switch as `PATCH /api/v1/repos/:owner/:name` does, for the same callers (a repository admin); answers `{ repo, description, visibility, flowOnly }` (with none to change it only reads); a visibility other than public or private is `invalid`",
  description:
    "Read or change a repo's description, visibility or flowOnly: PATCH /api/v1/repos/:owner/:name (admin).",
  inputSchema: {
    type: "object",
    properties: {
      repo: REPO_ARG,
      description: { type: "string", maxLength: 2000 },
      visibility: { type: "string", enum: ["public", "private"] },
      flowOnly: { type: "boolean" },
    },
    required: ["repo"],
  },
  writes: true,
  needsAdminScope: true,
  async run(ctx, user, args) {
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const { description, visibility, flowOnly } = args;
    if (flowOnly !== undefined && typeof flowOnly !== "boolean")
      return bad("invalid", "flowOnly is true or false");
    if (description !== undefined && typeof description !== "string")
      return bad("invalid", "description is text");
    if (visibility !== undefined && visibility !== "public" && visibility !== "private")
      return bad("invalid", VISIBILITY_WORDS);
    const updated = await updateRepoSettings(ctx.app, user, repo, {
      ...(visibility !== undefined ? { visibility } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(flowOnly !== undefined ? { flowOnly } : {}),
    });
    if (!updated.ok)
      return bad(updated.error === "not_found" ? "not_found" : "forbidden", updated.error);
    return good({
      repo: `${updated.value.ownerName}/${updated.value.name}`,
      description: updated.value.description,
      visibility: updated.value.visibility,
      flowOnly: updated.value.flowOnly,
    });
  },
};
