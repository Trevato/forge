import { holdPull, releasePull } from "../../../actions/holds.ts";
import { getPull } from "../../../core/pulls.ts";
import { good, bad, type Tool, str, APP_ARG, planRepo, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "hold",
  doc: "`{ app, pull, why?, release?, dryRun? }`: hold a pull so no rule reviews or lands it, or let it go; a person who can write, never an agent; plans unless `dryRun: false`",
  description:
    "Hold a pull (`why`) or release it (`release: true`): held, nothing reviews or lands it. Writers.",
  inputSchema: {
    type: "object",
    properties: {
      app: APP_ARG,
      pull: { type: "integer" },
      why: {
        type: "string",
        description: "Why, one line.",
      },
      release: {
        type: "boolean",
      },
      dryRun: {
        type: "boolean",
        description: "false to apply",
      },
    },
    required: ["app", "pull"],
  },
  writes: true,
  dryByDefault: true,
  run(ctx, user, args) {
    const repo = planRepo(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const n = args["pull"];
    const pull =
      typeof n === "number" && Number.isInteger(n) && n > 0
        ? getPull(ctx.app.db, repo.id, n)
        : undefined;
    if (pull === undefined)
      return bad("no_such_pull", `no pull #${String(n)}`);
    const dry = args["dryRun"] !== false;
    const name = `${repo.ownerName}/${repo.name}#${pull.number}`;
    const hint = "Nothing changed; send dryRun: false to do it.";
    if (args["release"] === true) {
      const released = releasePull(ctx.app, user, repo, pull, dry);
      if (!released.ok)
        return bad(
          released.error,
          "holding and releasing are for a person who can write this app",
        );
      return good({
        says: !released.value
          ? `Nothing holds ${name}.`
          : dry
            ? `Would release ${name}. ${hint}`
            : `Released ${name}. The rules take it from here.`,
        held: dry ? released.value : false,
        dryRun: dry,
      });
    }
    const held = holdPull(ctx.app, user, repo, pull, str(args["why"]), dry);
    if (!held.ok)
      return bad(
        held.error,
        held.error === "not_open"
          ? "only an open pull can be held"
          : held.error === "empty_why" || held.error === "why_too_long"
            ? "say why in one line, at most 200 characters (why)"
            : "holding and releasing are for a person who can write this app",
      );
    return good({
      says: dry
        ? `Would hold ${name}: "${held.value.why}". ${hint}`
        : `Held ${name}. No rule reviews or lands it until it is released.`,
      held: !dry,
      hold: { by: held.value.heldByName, why: held.value.why },
      dryRun: dry,
    });
  },
};
