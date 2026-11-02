/**
 * The boards the forge offers a new install: Usage, Serving, Crew, Releases, Maintenance, Apps, App restarts, Security, Throughput, Forges and Reach. They are plain
 * boards in `forge/boards` once written, so a person edits or deletes them
 * like any other; `.offered` (a JSON list of slugs, committed with the
 * boards) records what was offered so a deletion sticks and an edit is
 * never overwritten. Each panel uses a source already in `sources.ts`.
 */
import { repoDir } from "../git/repos.ts";
import { readerFor } from "../git/read.ts";
import type { Board, Panel } from "./store.ts";
import { BOARDS_OWNER, BOARDS_REPO } from "./store.ts";

export const OFFERED_FILE = ".offered";

const panel = (title: string, chart: Panel["chart"], query: Record<string, unknown>, w = 1, h = 1): Panel => ({
  title, chart, query, w, h,
});
const MINUTE = { bucket: "minute" };
const HOUR = { bucket: "hour" };
const DAY = { bucket: "day" };
const SPAWNS = { source: "spawns", aggregate: "count" };
const started = { column: "outcome", op: "eq", value: "started" };
const timeToLive = (series: string) => ({
  source: "spawnTime", aggregate: "max", column: "value", groupBy: DAY, series: "metric",
  filter: [{ column: "series", op: "eq", value: series }],
});
const STAGES = { source: "stages", aggregate: "count" };
const machine = (op: "eq" | "starts", value: string, column: string) => ({
  source: "machine", aggregate: "avg", column, groupBy: MINUTE, filter: [{ column: "target", op, value }],
});

// A failed sign-in answers 422 (wrong password) or 429 (rate-limited); the usage count keeps no more.
const failed = {
  source: "usage", aggregate: "sum", column: "n",
  filter: [{ column: "pattern", op: "eq", value: "/signin" }, { column: "method", op: "eq", value: "POST" }, { column: "status", op: "eq", value: "4xx" }],
};

const reach = (metric: string, aggregate: string, groupBy?: Record<string, unknown>) => ({
  source: "reach", aggregate, column: "value", ...(groupBy === undefined ? {} : { groupBy }),
  filter: [{ column: "metric", op: "eq", value: metric }],
});

export const STARTING_BOARDS: Readonly<Record<string, Board>> = {
  usage: {
    title: "Usage",
    range: "24h",
    refresh: "1m",
    panels: [
      panel("Pod CPU (cores)", "line", machine("eq", "forge", "cpu_cores"), 2),
      panel("Pod memory (bytes)", "line", machine("eq", "forge", "memory_bytes"), 2),
      panel("Cells CPU (cores)", "area", { ...machine("starts", "app:", "cpu_cores"), series: "target" }, 2),
      panel("Cells memory (bytes)", "area", { ...machine("starts", "app:", "memory_bytes"), series: "target" }, 2),
      panel("Node CPU (cores)", "line", machine("eq", "node", "cpu_cores")),
      panel("Node load", "line", machine("eq", "node", "load")),
      panel("Requests per hour", "bar", { source: "usage", aggregate: "sum", column: "n", groupBy: "hour", series: "status" }, 2),
    ],
  },
  // Whether the forge still answers while its children work (#3319): the
  // event loop's lateness beside what competes with it for CPU.
  serving: {
    title: "Serving",
    range: "24h",
    refresh: "1m",
    panels: [
      panel("Event-loop lag p99 (ms)", "line", { ...machine("eq", "forge", "lag_ms_max"), aggregate: "max" }, 2),
      panel("Checks running", "line", { ...machine("eq", "forge", "checks"), aggregate: "max" }),
      panel("Crew runs running", "line", { ...machine("eq", "forge", "agents"), aggregate: "max" }),
      panel("Pod CPU (cores)", "line", machine("eq", "forge", "cpu_cores"), 2),
      panel("Checks CPU (cores)", "area", { ...machine("starts", "check:", "cpu_cores"), series: "target" }, 2),
    ],
  },
  releases: {
    title: "Releases",
    range: "30d",
    refresh: "1m",
    panels: [
      panel("Deploys per day", "bar", { source: "deploys", aggregate: "count", groupBy: { bucket: "day" }, series: "state" }, 2),
      panel("Deploys by state", "bar", { source: "deploys", aggregate: "count", groupBy: "state" }),
      panel("Deploys gone live per day", "line", {
        source: "deploys", aggregate: "count", groupBy: { bucket: "day" }, filter: [{ column: "serving_at", op: "gt", value: "" }],
      }),
      panel("Slowest decision per day (ms)", "line", { source: "decisions", aggregate: "max", column: "ms", groupBy: { bucket: "day" } }, 2),
      panel("Decider time per hour (ms)", "line", { source: "decisions", aggregate: "avg", column: "ms", groupBy: HOUR, series: "kind" }, 2),
    ],
  },
  // The release keeper (#7557): every release dark for 0 s is the target.
  maintenance: {
    title: "Maintenance",
    range: "30d",
    refresh: "1m",
    panels: [
      panel("Seconds dark per release", "bar", { source: "keeperReleases", aggregate: "max", column: "seconds_dark", groupBy: "version" }, 2),
      panel("Worst latency per release (ms)", "bar", { source: "keeperReleases", aggregate: "max", column: "worst_ms", groupBy: "version" }, 2),
      panel("Releases by outcome", "bar", { source: "keeperReleases", aggregate: "count", groupBy: "stage" }),
      panel("Seconds dark (30 days)", "number", { source: "keeperReleases", aggregate: "sum", column: "seconds_dark" }),
    ],
  },
  apps: {
    title: "Apps",
    range: "7d",
    refresh: "1m",
    panels: [
      panel("Apps made per day", "bar", { source: "apps", aggregate: "count", groupBy: { bucket: "day" }, series: "access" }),
      panel("Apps by access", "bar", { source: "apps", aggregate: "count", groupBy: "access" }),
      panel("Wakes per app (by repo id)", "bar", { source: "wakes", aggregate: "count", groupBy: "repo_id", series: "placement" }, 2),
      panel("Sleeps per app (by repo id)", "bar", { source: "sleeps", aggregate: "count", groupBy: "repo_id", series: "placement" }, 2),
      panel("Wakes per hour", "line", { source: "wakes", aggregate: "count", groupBy: HOUR }, 2),
      panel("Requests per hour by surface", "bar", { source: "usage", aggregate: "sum", column: "n", groupBy: "hour", series: "surface" }, 2),
    ],
  },
  // Every app restart and its cause (#4496): a forge roll should read zero.
  restarts: {
    title: "App restarts",
    range: "7d",
    refresh: "1m",
    panels: [
      panel("App restarts per day, by cause", "bar", { source: "restarts", aggregate: "count", groupBy: DAY, series: "cause" }, 2),
      panel("Restarts per app (by repo id), by cause", "bar", { source: "restarts", aggregate: "count", groupBy: "repo_id", series: "cause" }, 2),
      panel("Restarts by cause", "bar", { source: "restarts", aggregate: "count", groupBy: "cause" }),
    ],
  },
  crew: {
    title: "Crew",
    range: "7d",
    refresh: "1m",
    panels: [
      panel("Runs by agent and outcome", "bar", { source: "spend", aggregate: "count", groupBy: "agent_id", series: "outcome" }, 2),
      panel("Runs by state", "bar", { source: "runs", aggregate: "count", groupBy: "state" }),
      panel("Review verdicts", "bar", { source: "reviews", aggregate: "count", groupBy: "state" }),
      panel("Spend per hour (USD)", "line", { source: "spend", aggregate: "sum", column: "cost_usd", groupBy: HOUR }, 2),
    ],
  },
  security: {
    title: "Security",
    range: "7d",
    refresh: "1m",
    panels: [
      panel("Sign-ins per hour", "bar", { source: "signins", aggregate: "count", groupBy: HOUR }, 2),
      panel("Failed sign-ins per hour", "bar", { ...failed, groupBy: HOUR, series: "status" }, 2),
      panel("Failed sign-ins (total)", "number", failed),
      panel("Tokens by scope", "bar", { source: "tokens", aggregate: "count", groupBy: "scope" }),
      panel("Tokens made per day", "bar", { source: "tokens", aggregate: "count", groupBy: { bucket: "day" } }),
      panel("Admin actions per hour", "bar", { source: "adminActions", aggregate: "count", groupBy: HOUR }, 2),
      panel("Admin actions by kind", "bar", { source: "adminActions", aggregate: "count", groupBy: "kind" }, 2),
    ],
  },
  throughput: {
    title: "Throughput",
    range: "7d",
    refresh: "1m",
    panels: [
      panel("Items entering each stage per hour", "bar", { ...STAGES, groupBy: HOUR, series: "stage" }, 3),
      panel("Entered each stage", "bar", { ...STAGES, groupBy: "stage" }),
      panel("Stages by hour", "heat", { ...STAGES, groupBy: HOUR, series: "stage" }, 2),
    ],
  },
  reach: {
    title: "Reach",
    range: "30d",
    refresh: "1m",
    panels: [
      panel("Visitors per day", "bar", reach("visitors", "max", DAY), 2),
      panel("Accounts signed in today", "number", reach("accounts_active_1d", "max")),
      panel("All accounts", "number", reach("accounts_total", "max")),
      panel("Page load per day (ms, slowest quarter)", "line", reach("load_p75", "max", DAY), 2),
      panel("Slow to react per day (ms, slowest quarter)", "line", reach("inp_p75", "max", DAY), 2),
    ],
  },
  forges: {
    title: "Forges",
    range: "30d",
    refresh: "1m",
    panels: [
      panel("Forges made per day", "bar", { ...SPAWNS, groupBy: DAY, series: "series", filter: [started] }, 2),
      panel("Forges live per day", "bar", { ...SPAWNS, groupBy: DAY, series: "series", filter: [{ column: "outcome", op: "eq", value: "live" }] }, 2),
      panel("Time to live (ms): p50, p95, budget 3 min", "line", timeToLive("forge"), 2),
      panel("The drill's time to live (ms): p50, p95, budget 3 min", "line", timeToLive("drill"), 2),
      panel("Failures by step", "bar", { ...SPAWNS, groupBy: "step", series: "series", filter: [{ column: "outcome", op: "eq", value: "failed" }] }, 2),
      panel("Failures per day", "bar", { ...SPAWNS, groupBy: DAY, series: "step", filter: [{ column: "outcome", op: "eq", value: "failed" }] }, 2),
    ],
  },
};

/** The slugs already offered, from the repo; none when it has no such file yet. */
export async function readOffered(reposRoot: string): Promise<string[]> {
  const got = await readerFor(repoDir(reposRoot, BOARDS_OWNER, BOARDS_REPO)).object(`main:${OFFERED_FILE}`);
  if (!got.ok || got.value.type !== "blob" || got.value.size > 4096) return [];
  try {
    const list: unknown = JSON.parse(new TextDecoder().decode(got.value.body));
    return Array.isArray(list) ? list.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}
