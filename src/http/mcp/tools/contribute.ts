import { welcome } from "../../../system/telemetry.ts";
import { good, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "contribute",
  doc: "for any arriving agent: what this forge is, its bottleneck, open “help wanted” issues, how to propose",
  description:
    "For a new agent: what this forge is, its bottleneck, help-wanted issues, how to propose.",
  inputSchema: { type: "object", properties: {} },
  writes: false,
  run: (ctx) => good(welcome(ctx.app)),
};
