import { applyAsksBulk, ownAsksOperation, previewAsksBulk, receiptOf, undoAsksBulk } from "../../../actions/asks_bulk.ts";
import { NO_SUCH_OPERATION } from "../../../actions/asks_words.ts";
import { mutedRepos, removeMutes } from "../../../core/interactions.ts";
import { good, bad, repoArg, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "asks_act",
  description:
    "Decide asks (`items`): dismiss, ship, close (`reason`), mute, replan; `listen` (`repo`) unmutes; `undo` (`operation`)",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["dismiss", "decline", "mute", "listen", "undo", "ship", "close", "replan"] },
      items: { type: "array", items: { type: "string" }, maxItems: 100 },
      repo: { type: "string" },
      operation: { type: "string" },
      reason: { type: "string", maxLength: 300 },
      dryRun: { type: "boolean" },
    },
    required: ["action"],
  },
  doc:
    "`{ action, items?, repo?, reason?, dryRun? }`: decide asks in bulk (up to 100): `dismiss`, `decline`, `mute`, `ship`, `close` (with `reason`) or `replan`, `listen` with `repo` to unmute one, or `undo` with `operation` to reverse one of your own within a day; planned first (`dryRun` is true unless `false`), as `POST /api/v1/asks/bulk`",
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
    if (args["action"] === "undo") {
      if (typeof args["operation"] !== "string" || args["operation"] === "")
        return bad("invalid", "`undo` needs `operation`, the id of a bulk action");
      if (args["dryRun"] !== false) {
        const own = ownAsksOperation(ctx.app, user, args["operation"]);
        return own === undefined ? bad("not_found", NO_SUCH_OPERATION) : good({ wouldUndo: own.id });
      }
      const undone = await undoAsksBulk(ctx.app, user, args["operation"]);
      return undone.ok
        ? good({ ...undone.value, receipt: receiptOf(undone.value) })
        : bad(undone.error.code, undone.error.message);
    }
    if (args["dryRun"] !== false) {
      const plan = previewAsksBulk(ctx.app, user, args["action"], args["items"], args["reason"]);
      return plan.ok ? good(plan.value) : bad(plan.error.code, plan.error.message);
    }
    const done = await applyAsksBulk(ctx.app, user, args["action"], args["items"], args["reason"]);
    return done.ok ? good({ ...done.value, receipt: receiptOf(done.value) }) : bad(done.error.code, done.error.message);
  },
};
