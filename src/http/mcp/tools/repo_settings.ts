import { updateRepoSettings } from "../../../actions/repos.ts";
import { TRANSFER_SAID, transferRepository } from "../../../actions/transfer.ts";
import { good, bad, type Tool, REPO_ARG, repoArg, isAnswer } from "../shared.ts";
import { VISIBILITY_WORDS } from "../../../core/arg_words.ts";

export const tool: Tool = {
  name: "repo_settings",
  doc: "`{ repo, description?, visibility?, newOwner? }` (admin): `newOwner` moves the repository to that account or org as `POST /api/v1/repos/:owner/:name/transfer` does, with its codes and sentences (`name_taken`, `same_owner`, `move_failed`, `forbidden_owner`, `unknown_owner`) and answers `{ repo, description, visibility }` at the new path, and cannot be combined with the others; otherwise change a repository's description and visibility as `PATCH /api/v1/repos/:owner/:name` does, for the same callers (a repository admin); answers `{ repo, description, visibility }` (with none to change it only reads); a visibility other than public or private is `invalid`",
  description:
    "Read, change or move (newOwner) a repo: PATCH /api/v1/repos/:owner/:name (admin).",
  inputSchema: {
    type: "object",
    properties: {
      repo: REPO_ARG,
      description: { type: "string", maxLength: 2000 },
      visibility: { type: "string", enum: ["public", "private"] },
      newOwner: { type: "string", maxLength: 64 },
    },
    required: ["repo"],
  },
  writes: true,
  needsAdminScope: true,
  async run(ctx, user, args) {
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const { description, visibility, newOwner } = args;
    if (newOwner !== undefined) {
      if (typeof newOwner !== "string" || newOwner.length === 0 || newOwner.length > 64)
        return bad("bad_new_owner", "newOwner is an account or organisation name");
      if (description !== undefined || visibility !== undefined)
        return bad("invalid", "newOwner moves the repository; give it alone");
      const moved = await transferRepository(ctx.app, user, repo, newOwner);
      if (!moved.ok)
        return moved.error === "not_found"
          ? bad("not_found", "no such app or repository (owner/name)")
          : bad(moved.error, TRANSFER_SAID[moved.error]);
      return good({
        repo: `${moved.value.ownerName}/${moved.value.name}`,
        description: moved.value.description,
        visibility: moved.value.visibility,
      });
    }
    if (description !== undefined && typeof description !== "string")
      return bad("invalid", "description is text");
    if (visibility !== undefined && visibility !== "public" && visibility !== "private")
      return bad("invalid", VISIBILITY_WORDS);
    const updated = await updateRepoSettings(ctx.app, user, repo, {
      ...(visibility !== undefined ? { visibility } : {}),
      ...(description !== undefined ? { description } : {}),
    });
    if (!updated.ok)
      return bad(updated.error === "not_found" ? "not_found" : "forbidden", updated.error);
    return good({
      repo: `${updated.value.ownerName}/${updated.value.name}`,
      description: updated.value.description,
      visibility: updated.value.visibility,
    });
  },
};
