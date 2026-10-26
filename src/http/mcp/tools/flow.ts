import { noteRead, telemetryReader } from "../../../actions/telemetry.ts";
import { flowFor } from "../../../system/telemetry.ts";
import { good, bad, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "flow",
  doc: "the forge's pipeline (a forge admin's, or an agent the owner granted `telemetry:read`; private repositories cut out): per stage counts, `oldestWaiting`, `capacity`, the bottleneck, the merge `queue` and what each reviewer has `reviewing`",
  description:
    "Pipeline (forge admin): stage counts, `oldestWaiting`, `capacity`, `queue`.",
  inputSchema: { type: "object", properties: {} },
  writes: false,
  run(ctx, user) {
    const reader = telemetryReader(ctx.app, user);
    if (!reader)
      return bad("forbidden", "only an admin of this forge, or an agent granted telemetry:read, reads its pipeline");
    noteRead(ctx.app, user, reader, "flow");
    return good(flowFor(ctx.app, reader));
  },
};
