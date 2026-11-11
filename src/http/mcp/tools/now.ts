import { crewNow } from "../../../actions/crew_now.ts";
import { good, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "now",
  doc: "what the crew is doing right now: who, on what, since when, at what cost; a planner that declined the direction and waits for you comes first (`run: null`, its words in `says`); the `ui://forge/crew` card",
  description:
    "What the crew does across your apps: who, on what, since when, cost; what awaits review.",
  inputSchema: { type: "object", properties: {} },
  writes: false,
  run(ctx, user) {
    return good(crewNow(ctx, user));
  },
};
