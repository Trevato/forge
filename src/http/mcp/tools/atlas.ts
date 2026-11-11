import {
  ATLAS_BODY_MAX,
  businessItems,
  checkPillar,
  confirmBusinessPlan,
  parseBusinessPlan,
  spawnSeed,
  stampOf,
} from "../../../actions/business_plan.ts";
import { good, bad, type Tool, APP_ARG, planRepo, isAnswer } from "../shared.ts";

/** `POST …/atlas` (#439) as a tool: the same checks, dry run unless `confirm`. */
export const tool: Tool = {
  name: "atlas",
  doc: "`{ app, plan: { description, apps: [{slug,purpose}], adapters: [{system,data}], edges: [{from,waitsFor}] }, pillar?, confirm? }`: a business as issues; dry run unless confirm",
  description: "Atlas business plan: shows the issues it would open; confirm:true opens them once.",
  inputSchema: {
    type: "object",
    properties: {
      app: APP_ARG,
      plan: {
        type: "object",
        description: "description, apps, adapters, edges: see llms.txt",
      },
      pillar: { type: "string", maxLength: 100 },
      confirm: { type: "boolean" },
    },
    required: ["app", "plan"],
  },
  writes: true,
  run(ctx, user, args) {
    const repo = planRepo(ctx, user, args);
    if (isAnswer(repo)) return repo;
    if (JSON.stringify(args["plan"] ?? null).length > ATLAS_BODY_MAX)
      return bad("too_large", `a plan is at most ${ATLAS_BODY_MAX} bytes`);
    const plan = parseBusinessPlan(args["plan"]);
    if (!plan.ok) return bad(plan.error.error, plan.error.message);
    const served = checkPillar(ctx.app, repo, args["pillar"]);
    if (!served.ok) return bad(served.error.error, served.error.message);
    if (args["confirm"] !== undefined && typeof args["confirm"] !== "boolean")
      return bad("invalid", "confirm is true or false");
    if (args["confirm"] !== true) {
      const issues = businessItems(plan.value, served.value);
      return good({
        says: `Dry run: ${issues.length} issues would open. Call again with confirm:true to open them.`,
        status: "dry-run",
        stamp: stampOf(plan.value),
        issues,
        spawn: spawnSeed(plan.value),
      });
    }
    const done = confirmBusinessPlan(ctx.app, user, repo, plan.value, served.value);
    if (!done.ok) return bad(done.error.error, done.error.message);
    const r = done.value;
    const says =
      r.status === "opened"
        ? `Opened ${r.opened.map((o) => `#${o.number}`).join(", ")}.`
        : r.status === "already"
          ? `Already opened: ${r.numbers.map((n) => `#${n}`).join(", ")}; nothing more opened.`
          : `Proposed: nothing opens until a person nods.`;
    return good({ says, ...r });
  },
};
