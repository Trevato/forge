/**
 * Main-thread stalls by route for `GET /metrics` (#9016), from the loop
 * watch's tally (`perf/loop.ts`): milliseconds and counts since the process
 * started as counters, and the top routes of the last hour as gauges. The
 * telemetry flow route is always in the hour, at zero when it stalled
 * nothing, so its before and after (#8978: 69.6 s in 6 minutes) reads from
 * one series. `stallHour` is the selection the families, `/system` and the
 * terminal's Stalls screen all read.
 */

import type { RouteStall, StallTally } from "../perf/loop.ts";
import type { Family } from "./openmetrics.ts";

/** Routes the hour lists, most milliseconds first; the rest are in the totals. */
export const TOP_ROUTES = 10;
/** Routes always in the hour, whatever their place. */
export const WATCHED_ROUTES: readonly string[] = ["/api/v1/telemetry/flow"];

/** The last hour's top routes, most milliseconds first, then each watched route not among them (at zero when it stalled nothing). */
export function stallHour(tally: StallTally): RouteStall[] {
  const hour = tally.hour.slice(0, TOP_ROUTES);
  for (const route of WATCHED_ROUTES)
    if (!hour.some((r) => r.route === route)) hour.push(tally.hour.find((r) => r.route === route) ?? { route, ms: 0, count: 0 });
  return hour;
}

export function stallFamilies(tally: StallTally): Family[] {
  const hour = stallHour(tally);
  return [
    {
      type: "counter",
      name: "forge_loop_stall_milliseconds_total",
      help: "Milliseconds the main thread stalled past 200 ms, by the route running across the stall (\"<route> (in flight)\" when still running at the wake, route=\"none\" when none), since the process started.",
      samples: tally.total.map((r) => ({ labels: { route: r.route }, value: Math.round(r.ms) })),
    },
    {
      type: "counter",
      name: "forge_loop_stalls_total",
      help: "Main-thread stalls past 200 ms, by the route running across the stall, since the process started.",
      samples: tally.total.map((r) => ({ labels: { route: r.route }, value: r.count })),
    },
    {
      type: "gauge",
      name: "forge_loop_stall_hour_milliseconds",
      help: `Milliseconds the main thread stalled in the last hour, the top ${TOP_ROUTES} routes plus ${WATCHED_ROUTES.join(", ")}.`,
      samples: hour.map((r) => ({ labels: { route: r.route }, value: Math.round(r.ms) })),
    },
    {
      type: "gauge",
      name: "forge_loop_stall_hour_count",
      help: "Main-thread stalls in the last hour, for the routes forge_loop_stall_hour_milliseconds lists.",
      samples: hour.map((r) => ({ labels: { route: r.route }, value: r.count })),
    },
  ];
}
