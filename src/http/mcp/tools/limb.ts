import { scopeAllows } from "../../../core/tokens.ts";
import { undoFleetOp } from "../../../actions/fleet.ts";
import { applyLimb, isLimbAction, previewLimb } from "../../../actions/limbs.ts";
import { isReplanAction, previewReplan, replanLimb, takeBackLimb } from "../../../actions/limb_replan.ts";
import { good, bad, type Tool, str, APP_ARG, planRepo, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "limb",
  doc: "`{ app, issue?, action, reason?, pillar?, under?, operation?, dryRun? }`: defer, resume or close a whole limb as not doing, or undo an operation; plans unless `dryRun` is false, and applying takes an admin token",
  description:
    "Act on a limb by `action`.",
  inputSchema: {
    type: "object",
    properties: {
      app: APP_ARG,
      issue: {
        type: "integer",
        minimum: 1,
      },
      action: { type: "string", enum: ["defer", "resume", "close", "raise", "lower", "replan", "takeback", "undo"] },
      reason: {
        type: "string",
        description: "Why.",
      },
      pillar: {
        type: "string",
        description:
          "For resume.",
      },
      under: {
        type: "string",
        description:
          "`top` or a milestone number.",
      },
      operation: {
        type: "string",
      },
      dryRun: { type: "boolean" },
    },
    required: ["app", "action"],
  },
  writes: true,
  dryByDefault: true,
  async run(ctx, user, args) {
    const repo = planRepo(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const dry = args["dryRun"] !== false;
    // The fleet's rule: a read credential plans, an admin one applies.
    if (!dry && !scopeAllows(ctx.auth.scope ?? "ro", "admin"))
      return bad("forbidden", "applying a limb action takes an admin token");
    const refused = (e: { code: string; message: string }) =>
      bad(e.code, e.message);
    if (args["action"] === "undo") {
      if (dry) return bad("invalid", "undo is not a dry run: pass dryRun false");
      const undone = await undoFleetOp(ctx.app, user, str(args["operation"]));
      return undone.ok ? good(undone.value) : refused(undone.error);
    }
    const number = args["issue"];
    if (
      isReplanAction(args["action"]) &&
      typeof number === "number" &&
      Number.isInteger(number) &&
      number > 0
    ) {
      if (dry) {
        const plan = previewReplan(ctx.app, user, repo, number);
        return plan.ok ? good({ dryRun: true, ...plan.value }) : refused(plan.error);
      }
      const done =
        args["action"] === "replan"
          ? replanLimb(ctx.app, user, repo, number)
          : takeBackLimb(ctx.app, user, repo, number);
      return done.ok ? good({ dryRun: false, ...done.value }) : refused(done.error);
    }
    if (
      !isLimbAction(args["action"]) ||
      typeof number !== "number" ||
      !Number.isInteger(number) ||
      number < 1
    )
      return bad("invalid", "give the limb's issue number and an action: defer, resume, close, raise, lower, replan, takeback or undo");
    const request = {
      action: args["action"],
      ...(typeof args["reason"] === "string" ? { reason: args["reason"] } : {}),
      ...(typeof args["pillar"] === "string" ? { pillar: args["pillar"] } : {}),
      ...(typeof args["under"] === "string" || typeof args["under"] === "number"
        ? { under: String(args["under"]) }
        : {}),
    };
    if (dry) {
      const plan = previewLimb(ctx.app, user, repo, number, request);
      return plan.ok ? good({ dryRun: true, ...plan.value }) : refused(plan.error);
    }
    const op = await applyLimb(ctx.app, user, repo, number, request);
    return op.ok ? good({ dryRun: false, ...op.value }) : refused(op.error);
  },
};
