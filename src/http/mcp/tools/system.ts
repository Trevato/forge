import { noteRead, telemetryReader } from "../../../actions/telemetry.ts";
import { systemFor } from "../../../system/telemetry.ts";
import { good, bad, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "system",
  doc: "the machine the forge runs on, now: CPU, load, memory, disk, network, processes; a forge admin, or an agent granted `telemetry:read`",
  description:
    "The forge's machine now: CPU, load, memory, disk, network, processes. Forge admin or telemetry:read.",
  inputSchema: { type: "object", properties: {} },
  writes: false,
  run(ctx, user) {
    const reader = telemetryReader(ctx.app, user);
    if (!reader)
      return bad("forbidden", "only an admin of this forge, or an agent granted telemetry:read, reads its machine");
    noteRead(ctx.app, user, reader, "system");
    return good(systemFor(ctx.app, reader));
  },
};
