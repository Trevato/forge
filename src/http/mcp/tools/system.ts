import { noteRead, telemetryReader } from "../../../actions/telemetry.ts";
import { systemWithReaders } from "../../../system/telemetry.ts";
import { violationsByDirective, windowStart } from "../../csp_report.ts";
import { countRead } from "../../../system/telemetry_reads.ts";
import { stallHour, TOP_ROUTES } from "../../../metrics/stalls.ts";
import { loopWatch } from "../../../perf/live.ts";
import { good, bad, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "system",
  doc: "the machine the forge runs on, now: CPU, load, memory, disk, network, processes, `stalls`: the last hour's main-thread stalls by route or `job:<name>` as {cause, ms, count}, and `readers`: who polls the telemetry and how fast; a forge admin, or an agent granted `telemetry:read`. `{ kind: \"csp\" }`: the last 24 h of Content-Security-Policy violations browsers reported, `{ directive, n, newest }` per directive (`newest` the blocked host last counted), most first, counted per UTC hour from `since`, as the security page reads them; a forge admin only",
  description:
    "The forge machine now: CPU, memory, disk, network. Admin or telemetry:read; `kind: csp`: 24 h of CSP violations (admin).",
  inputSchema: { type: "object", properties: { kind: { type: "string", enum: ["csp"] } } },
  writes: false,
  run(ctx, user, args) {
    if (args["kind"] !== undefined) {
      if (args["kind"] !== "csp") return bad("invalid", "kind is csp, or absent for the machine");
      if (!user.isAdmin) return bad("forbidden", "only an admin of this forge reads its CSP violations");
      const now = new Date();
      return good({ hours: 24, since: windowStart(24, now).toISOString(), directives: violationsByDirective(ctx.app.db, 24, now) });
    }
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
