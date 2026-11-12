import { openPlan, parsePlan, PLAN_MAX, proposePlan } from "../../../actions/plan.ts";
import { good, bad, type Tool, APP_ARG, planRepo, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "plan",
  doc: "`{ app, issues, title?, why? }`: open up to 12 linked issues, all or none (see below)",
  description: `Open linked issues, all or none (max ${PLAN_MAX}); each: \`pillar\` or \`later\`+\`why\`.`,
  inputSchema: {
    type: "object",
    properties: {
      app: APP_ARG,
      title: { type: "string", maxLength: 256 },
      why: { type: "string", maxLength: 65536 },
      issues: {
        type: "array",
        minItems: 1,
        maxItems: PLAN_MAX,
        items: {
          type: "object",
          properties: {
            key: {
              type: "string",
            },
            title: { type: "string" },
            body: { type: "string" },
            blockedBy: {
              type: "array",
              items: { type: ["string", "integer"] },
            },
            pillar: {
              type: "string",
              description: "e.g. P0",
            },
            later: {
              type: "boolean",
              description: "Needs why.",
            },
            why: {
              type: "string",
              description: "For later.",
            },
          },
          required: ["key", "title"],
        },
      },
    },
    required: ["app", "issues"],
  },
  writes: true,
  run(ctx, user, args) {
    const repo = planRepo(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const items = parsePlan(args["issues"]);
    if (!items.ok) return bad(items.error.error, items.error.message);
    if (repo.plansNeedNod) {
      const proposed = proposePlan(ctx.app, user, repo, items.value, {
        title: args["title"],
        why: args["why"],
      });
      if (!proposed.ok)
        return bad(proposed.error.error, proposed.error.message);
      return good({
        says: `Proposed plan ${proposed.value.id}: nothing is opened until a person nods.`,
        ...proposed.value,
      });
    }
    const planned = openPlan(ctx.app, user, repo, items.value);
    if (!planned.ok) return bad(planned.error.error, planned.error.message);
    const { opened, ready, held, later, gate } = planned.value;
    const waits =
      gate === undefined
        ? ""
        : ` ${later.map((n) => `#${n}`).join(", ")} wait${later.length === 1 ? "s" : ""} behind the Later gate #${gate}.`;
    return good({
      says: `Opened ${opened.length} issue${opened.length === 1 ? "" : "s"}: ${opened.map((o) => `${o.key} is #${o.number}`).join(", ")}.${waits}`,
      opened,
      ready,
      held,
      later,
    });
  },
};
