import { readReturns } from "../../../actions/returns.ts";
import { good, bad, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "returns",
  doc: "`{ repo?, days? }`: what the crew's tokens bought over the last `days` (1–90, default 7): dollars, runs, changes landed, cost per change; `repo` narrows it to one app of yours",
  description:
    "What crew tokens bought in `days` (1–90, default 7): dollars, runs, landed, cost/change.",
  inputSchema: {
    type: "object",
    properties: {
      repo: { type: "string" },
      days: { type: "integer", minimum: 1, maximum: 90 },
    },
  },
  writes: false,
  run(ctx, user, args) {
    const repo = args["repo"];
    const days = args["days"];
    const read = readReturns(ctx.app, user, {
      ...(typeof repo === "string" ? { repo } : {}),
      ...(typeof days === "number" ? { days } : {}),
    });
    if (read.ok) return good(read.value);
    return read.error === "bad_days"
      ? bad("invalid_days", "days is a whole number from 1 to 90")
      : bad("not_found", "no such app of yours (owner/name)");
  },
};
