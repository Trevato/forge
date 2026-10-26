import { noteRead, telemetryReader } from "../../../actions/telemetry.ts";
import { historyOver } from "../../../system/telemetry.ts";
import { good, bad, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "telemetry_history",
  doc: "`{ hours? }` (1–72, default 6): the node's and the forge's CPU cores, memory and load over the window, `{ hours, points: [{ target, at, cpuCores, cpuCoresMax (the bucket's peak), memoryBytes, load }] }`, at most 300 points a series (15-s samples to 24 h, 5-min beyond, averaged down); a forge admin or `telemetry:read`, as `system`; the machine records no disk history",
  description: "Machine CPU, memory, load over `hours` (1–72, default 6).",
  inputSchema: {
    type: "object",
    properties: { hours: { type: "integer", minimum: 1, maximum: 72 } },
  },
  writes: false,
  run(ctx, user, args) {
    const hours = args.hours === undefined ? 6 : args.hours;
    if (typeof hours !== "number" || !Number.isInteger(hours) || hours < 1 || hours > 72)
      return bad("invalid", "hours is a whole number from 1 to 72");
    const reader = telemetryReader(ctx.app, user);
    if (!reader)
      return bad("forbidden", "only an admin of this forge, or an agent granted telemetry:read, reads its machine");
    noteRead(ctx.app, user, reader, "history");
    return good({ hours, points: historyOver(ctx.app, hours) });
  },
};
