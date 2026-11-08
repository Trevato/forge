import { agentFor } from "../../api/agents.ts";
import { listAllAgents } from "../../../actions/crew.ts";
import { good, bad, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "agents",
  doc: "`{}`: the forge's agents you may see, as `GET /api/v1/agents` lists them (an agent's brief, model and budget only to the agent itself and the forge's admin); a signed-in caller",
  description: "Agents you may see, as GET /api/v1/agents.",
  inputSchema: { type: "object", properties: {} },
  writes: false,
  run(ctx, user) {
    const agents = listAllAgents(ctx.app, user);
    if (!agents.ok) return bad("unauthorized", "sign in to list the agents");
    return good({ items: agents.value.map((a) => agentFor(a, user)), next_cursor: null });
  },
};
