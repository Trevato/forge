import { readHealth } from "../../../actions/health.ts";
import { good, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "health",
  doc: "how this forge is: the version and commit it runs, draining or not, the rollout and its incidents",
  description:
    "How this forge is: version, commit, draining or not, rollout, incidents.",
  inputSchema: { type: "object", properties: {} },
  writes: false,
  run: (ctx, user) => good(readHealth(ctx.app, user)),
};
