import { nextStepsFor } from "../../../core/next-steps.ts";
import { good, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "next_steps",
  doc: "on a spawned forge, your first three steps and whether each is done; empty elsewhere or for anyone but its owner",
  description:
    "On a spawned forge, its owner's first three steps and whether each is done. Empty elsewhere.",
  inputSchema: { type: "object", properties: {} },
  writes: false,
  async run(ctx, user) {
    const steps = await nextStepsFor(ctx.app, user);
    return good({ steps: steps ?? [] });
  },
};
