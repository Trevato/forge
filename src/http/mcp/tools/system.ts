import { noteRead, telemetryReader } from "../../../actions/telemetry.ts";
import { systemWithReaders } from "../../../system/telemetry.ts";
import { scriptErrorCounts } from "../../script_errors.ts";
import { violationsByDirective, windowStart } from "../../csp_report.ts";
import { countRead } from "../../../system/telemetry_reads.ts";
import { stallHour, TOP_ROUTES } from "../../../metrics/stalls.ts";
import { lagMinutes, loopWatch, perfRecord } from "../../../perf/live.ts";
import { LAG_BAR_MS, overBar } from "../../../perf/lag_minutes.ts";
import { slowestRoutes } from "../../../perf/watch.ts";
import { footing, riskLines } from "../../../system/footing.ts";
import { laneWords, readOffsiteLane } from "../../../snapshot/offsite_lane.ts";
import { largestDirs } from "../../../system/largest_dirs.ts";
import { good, bad, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "system",
  doc: "the machine the forge runs on, now: CPU, load, memory, disk, network, processes, `largestDirs`: the five largest directories under the forge's data as {at, dirs: [{name, bytes}]} (null while first measured; at most once a minute), `stalls`: the last hour's main-thread stalls by route (`<route> (in flight)` when still running at the wake), or `job:<name>`, as {cause, ms, count}, `readings`: the last 20 minutes' worst loop lag as {at, ms, what} beside `barMs` (100) and `over`, and `readers`: who polls the telemetry and how fast, `{ kind: \"routes\" }`: the 10 slowest budgeted routes as {route, p95Ms, budgetMs, n, slowestPhase}, over budget first; a forge admin, or an agent granted `telemetry:read`. `{ kind: \"csp\" }`: the last 24 h of Content-Security-Policy violations browsers reported, `{ directive, n, newest }` per directive (`newest` the blocked host last counted), most first, counted per UTC hour from `since`, and `scriptErrors` `{ page, where, message, n, last }`, as the security page reads them; a forge admin only. `{ kind: \"footing\" }`: what the forge stands on (#11685), as /system's \"What the forge stands on\": `forgeNode`, and per piece `{ id, need, what, machine, seen, risk, ifDies, issues }` read from the live cluster, with `risks`, one line per piece not on the forge's machine; a forge admin only. `{ kind: \"offsite\" }`: the off-site backup lane (#11805), as /system's \"Off-site backup\" and the terminal's: `{ health, says, where, sealed, lastSuccess, newest, error, drill: { at, verdict, from, offSite, reason } | null }`; a forge admin only",
  description:
    "The forge machine now: CPU, memory, disk, network. Admin or telemetry:read; `kind: csp`: 24 h of CSP violations (admin).",
  inputSchema: { type: "object", properties: { kind: { type: "string", enum: ["csp", "routes", "footing", "offsite"] } } },
  writes: false,
  async run(ctx, user, args) {
    if (args["kind"] !== undefined) {
      if (args["kind"] === "routes") {
        const reader = telemetryReader(ctx.app, user);
        if (!reader) return bad("forbidden", "only an admin of this forge, or an agent granted telemetry:read, reads its route timings");
        noteRead(ctx.app, user, reader, "system");
        return good({ routes: slowestRoutes(perfRecord, Date.now()) });
      }
      if (args["kind"] === "footing") {
        if (!user.isAdmin) return bad("forbidden", "only an admin of this forge reads what it stands on");
        const f = await footing.read();
        return good({ ...f, risks: riskLines(f) });
      }
      if (args["kind"] === "offsite") {
        if (!user.isAdmin) return bad("forbidden", "only an admin of this forge reads its off-site backup lane");
        const lane = readOffsiteLane(ctx.app.config.dataDir, ctx.app.db);
        return good({ ...lane, says: laneWords(lane) });
      }
      if (args["kind"] !== "csp") return bad("invalid", "kind is csp, routes, footing, offsite, or absent for the machine");
      if (!user.isAdmin) return bad("forbidden", "only an admin of this forge reads its CSP violations");
      const now = new Date();
      return good({ hours: 24, since: windowStart(24, now).toISOString(), directives: violationsByDirective(ctx.app.db, 24, now), scriptErrors: scriptErrorCounts(ctx.app.db, 24, now) });
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
    // At most 0.8 s on the walk (#11800); the last measurement, or null, when it is slower.
    const largest = await largestDirs.read(ctx.app.config.dataDir);
    return good({ ...out, largestDirs: largest, stalls, barMs: LAG_BAR_MS, over: overBar(rows), readings });
  },
};
