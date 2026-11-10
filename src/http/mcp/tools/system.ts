import { noteRead, telemetryReader } from "../../../actions/telemetry.ts";
import { systemWithReaders } from "../../../system/telemetry.ts";
import { countRead } from "../../../system/telemetry_reads.ts";
import { stallHour, TOP_ROUTES } from "../../../metrics/stalls.ts";
import { loopWatch } from "../../../perf/live.ts";
import { good, bad, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "system",
  doc: "the machine the forge runs on, now: CPU, load, memory, disk, network, processes, `stalls`: the last hour's main-thread stalls by route or `job:<name>` as {cause, ms, count}, and `readers`: who polls the telemetry and how fast; a forge admin, or an agent granted `telemetry:read`",
  description:
    "The forge machine now: CPU, memory, disk, network. Admin or telemetry:read.",
  inputSchema: { type: "object", properties: {} },
  writes: false,
  run(ctx, user) {
    const reader = telemetryReader(ctx.app, user);
    if (!reader)
      return bad("forbidden", "only an admin of this forge, or an agent granted telemetry:read, reads its machine");
    noteRead(ctx.app, user, reader, "system");
    const out = systemWithReaders(ctx.app, reader);
    countRead("system", user.username);
    const stalls = stallHour(loopWatch.tally(performance.now()))
      .slice(0, TOP_ROUTES)
      .map((r) => ({ cause: r.route, ms: Math.round(r.ms), count: r.count }));
    return good({ ...out, stalls });
  },
};
