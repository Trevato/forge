import { applyAsksBulk, previewAsksBulk } from "../../../actions/asks_bulk.ts";
import { mutedRepos, removeMutes } from "../../../core/interactions.ts";
import { good, bad, repoArg, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "asks_act",
  description:
    "Decide asks (`items`): dismiss, decline, ship, close (`reason`), mute, replan; `listen` (`repo`) unmutes",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["dismiss", "decline", "mute", "listen", "ship", "close", "replan"] },
      items: { type: "array", items: { type: "string" }, maxItems: 100 },
      repo: { type: "string" },
      reason: { type: "string", maxLength: 300 },
      dryRun: { type: "boolean" },
    },
    required: ["action"],
  },
  doc:
    "`{ action, items?, repo?, reason?, dryRun? }`: decide asks in bulk (up to 100): `dismiss`, `decline`, `mute`, `ship`, `close` (with `reason`) or `replan`, or `listen` with `repo` to unmute one; planned first (`dryRun` is true unless `false`), as `POST /api/v1/asks/bulk`",
  writes: true,
  dryByDefault: true,
  async run(ctx, user, args) {
    if (args["action"] === "listen") {
      if (typeof args["repo"] !== "string" || args["repo"].trim() === "")
        return bad("invalid", "`listen` needs `repo`, owner/name");
      const repo = repoArg(ctx, user, args);
      if ("ok" in repo || !mutedRepos(ctx.app.db, user.id).has(repo.id))
        return bad("not_found", "no such app or repository (owner/name)");
      const name = `${repo.ownerName}/${repo.name}`;
      if (args["dryRun"] !== false) return good({ wouldListen: [name] });
      removeMutes(ctx.app.db, user.id, [`repo:${repo.id}`]);
      return good({ listening: [name] });
    }
    const answer =
      args["dryRun"] === false
        ? await applyAsksBulk(ctx.app, user, args["action"], args["items"], args["reason"])
        : previewAsksBulk(ctx.app, user, args["action"], args["items"], args["reason"]);
    return answer.ok ? good(answer.value) : bad(answer.error.code, answer.error.message);
  },
};
