/**
 * The boards the forge offers a new install: Usage and Crew. They are plain
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
const machine = (op: "eq" | "starts", value: string, column: string) => ({
  source: "machine", aggregate: "avg", column, groupBy: MINUTE, filter: [{ column: "target", op, value }],
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
