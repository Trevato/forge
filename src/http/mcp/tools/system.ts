import { noteRead, telemetryReader } from "../../../actions/telemetry.ts";
import { systemWithReaders } from "../../../system/telemetry.ts";
import { violationsByDirective, windowStart } from "../../csp_report.ts";
import { countRead } from "../../../system/telemetry_reads.ts";
import { stallHour, TOP_ROUTES } from "../../../metrics/stalls.ts";
import { lagMinutes, loopWatch } from "../../../perf/live.ts";
import { LAG_BAR_MS, overBar } from "../../../perf/lag_minutes.ts";
import { good, bad, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "system",
  doc: "the machine the forge runs on, now: CPU, load, memory, disk, network, processes, `stalls`: the last hour's main-thread stalls by route or `job:<name>` as {cause, ms, count}, `readings`: the last 20 minutes' worst loop lag as {at, ms, what} beside `barMs` (100) and `over`, and `readers`: who polls the telemetry and how fast; a forge admin, or an agent granted `telemetry:read`. `{ kind: \"csp\" }`: the last 24 h of Content-Security-Policy violations browsers reported, `{ directive, n, newest }` per directive (`newest` the blocked host last counted), most first, counted per UTC hour from `since`, as the security page reads them; a forge admin only",
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
    // The same 20 minutes /system draws (#11220); `what` is null when no stall past 200 ms was named.
    const rows = lagMinutes.readings();
    const readings = rows.map((r) => ({ at: new Date(r.at).toISOString(), ms: Math.round(r.ms * 10) / 10, what: r.what }));
    return good({ ...out, stalls, barMs: LAG_BAR_MS, over: overBar(rows), readings });
  },
};
