import { askedRoles, createAgent, deleteAgent, updateAgent } from "../../../actions/crew.ts";
import type { Agent } from "../../../core/agents.ts";
import { good, bad, type Tool, str } from "../shared.ts";

export const tool: Tool = {
  name: "agent",
  doc: "`{ action, username, displayName?, model?, brief?, budgetUsd?, roles? }`: `create` a crew agent (with a `displayName`), `update` its `model`, `brief`, `budgetUsd` or `roles` (planner, builder, reviewer), or `remove` it; an admin's, with an `admin` token, as `/api/v1/agents`",
  description: "Admin: create|update|remove an agent.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string" },
      username: { type: "string" },
      displayName: { type: "string" },
      model: { type: "string" },
      brief: { type: "string" },
      budgetUsd: { type: "number" },
      roles: { type: "array", items: { type: "string" } },
    },
    required: ["action", "username"],
  },
  writes: true,
  adminOnly: true,
  needsAdminScope: true,
  async run(ctx, user, args) {
    const username = str(args["username"]);
    const model = args["model"];
    const brief = args["brief"];
    const budgetUsd = args["budgetUsd"];
    const fields = {
      ...(typeof model === "string" ? { model } : {}),
      ...(typeof brief === "string" ? { brief } : {}),
      ...(typeof budgetUsd === "number" ? { budgetUsd } : {}),
      ...askedRoles(args["roles"]),
    };
    const shown = (a: Agent) => ({
      username: a.user.username,
      displayName: a.user.displayName,
      model: a.model,
      brief: a.brief,
      budgetUsd: a.budgetUsd,
      roles: a.roles,
      createdAt: a.createdAt,
    });
    const action = args["action"];
    if (action === "create") {
      const made = await createAgent(ctx.app, user, {
        username,
        ...(typeof args["displayName"] === "string"
          ? { displayName: args["displayName"] }
          : {}),
        ...fields,
      });
      return made.ok ? good(shown(made.value)) : bad(made.error, made.error);
    }
    if (action === "update") {
      const done = updateAgent(ctx.app, user, username, fields);
      return done.ok ? good(shown(done.value)) : bad(done.error, done.error);
    }
    if (action === "remove") {
      const gone = deleteAgent(ctx.app, user, username);
      return gone.ok ? good({ removed: username }) : bad(gone.error, gone.error);
    }
    return bad("invalid", "action is create, update or remove");
  },
};
