/**
 * The drill's verdict, told: kept in one small file under the data
 * directory (`drill/last.json`), so the inbox card (`kernel/vitals.ts`)
 * stands for as long as the last drill was red and goes when the next one
 * passes; and posted as one comment on the recovery issue
 * (`FORGE_RECOVERY_REPO`, `FORGE_RECOVERY_ISSUE`, through `FORGE_URL` and
 * `FORGE_TOKEN`). Plain data in, plain data out.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describeTimes, formatMinutes, formatSpan, timeByPart, type DrillResult, type DrillStep } from "./drill.ts";

const STEPS: readonly DrillStep[] = ["fetch", "restore", "open", "count", "unseal", "health"];

const lastFile = (dataDir: string): string => join(dataDir, "drill", "last.json");

export function recordVerdict(dataDir: string, result: DrillResult): void {
  mkdirSync(join(dataDir, "drill"), { recursive: true });
  const tmp = `${lastFile(dataDir)}.tmp`;
  writeFileSync(tmp, JSON.stringify(result));
  renameSync(tmp, lastFile(dataDir));
}

/** The last drill's verdict, or undefined when none was recorded or the file is not one. */
export function lastVerdict(dataDir: string): DrillResult | undefined {
  try {
    const r = JSON.parse(readFileSync(lastFile(dataDir), "utf8")) as DrillResult;
    if (r.verdict !== "green" && r.verdict !== "red") return undefined;
    if (r.failedStep !== null && !STEPS.includes(r.failedStep)) return undefined;
    if (typeof r.at !== "string") return undefined;
    return r;
  } catch {
    return undefined;
  }
}

/** The inbox card's sentence for a red drill; undefined for a green one. */
export function failedSentence(r: DrillResult | undefined): string | undefined {
  if (r === undefined || r.verdict !== "red") return undefined;
  const times = describeTimes(r.phases);
  // An older drill kept no budget; it says none.
  const budget = r.budgetMs > 0 ? ` It had ${formatMinutes(r.budgetMs)}.` : "";
  return `The restore drill failed at ${r.failedStep ?? "an unknown step"}${r.reason ? `: ${r.reason}` : ""}${times ? ` (${times})` : ""}.${budget} Snapshot ${r.snapshotId ?? "none"}; docs/RECOVERY.md says what to do.`;
}

/** A green drill that used more than this share of its budget is a warning. */
export const DRILL_SLOW_SHARE = 0.8;

/**
 * The board's line for a green drill that came close to its budget, naming
 * the slowest phase; undefined for a red drill, one under 80%, or an older
 * drill that kept no budget.
 */
export function slowSentence(r: DrillResult | undefined): string | undefined {
  if (r === undefined || r.verdict !== "green") return undefined;
  if (!(r.budgetMs > 0) || !(r.ms > r.budgetMs * DRILL_SLOW_SHARE)) return undefined;
  const slowest = timeByPart(r.phases)[0];
  const spare = `${formatSpan(Math.max(0, r.budgetMs - r.ms))} to spare`;
  return `The last restore drill passed with ${spare}${slowest ? `; ${slowest.part} took ${formatSpan(slowest.ms)} of it` : ""}.`;
}

const firstFile =(dataDir: string): string => join(dataDir, "drill", "first-seen");

/**
 * Written once at boot (`seedFirstSeen`): when this forge first ran with a
 * drill to owe. A forge younger than eight days has missed none. A pure
 * read; undefined when never seeded, which is no line.
 */
export function firstSeen(dataDir: string): string | undefined {
  try {
    const at = readFileSync(firstFile(dataDir), "utf8").trim();
    return Number.isFinite(Date.parse(at)) ? at : undefined;
  } catch {
    return undefined;
  }
}

/** Keep the first boot's time if none is kept; throws when the disk will not take it. */
export function seedFirstSeen(dataDir: string, now: number = Date.now()): void {
  if (firstSeen(dataDir) !== undefined) return;
  mkdirSync(join(dataDir, "drill"), { recursive: true });
  writeFileSync(firstFile(dataDir), new Date(now).toISOString());
}

/** A drill older than this, or none at all, is one line on the board. */
export const DRILL_STALE_MS = 8 * 24 * 3_600_000;

export interface DrillNeed {
  /** Holds as long as the same drill is the reason: a new red or a new silence is a new key. */
  readonly key: string;
  readonly sentence: string;
  readonly since: string | undefined;
}

/**
 * The one line a drill owes the board: the red drill's sentence, or the
 * silence of eight days. `forgeSince` is when the forge began (a forge
 * younger than eight days has not missed a drill). Green and recent: none.
 */
export function drillNeed(
  r: DrillResult | undefined,
  now: number,
  forgeSince?: () => string | undefined,
): DrillNeed | undefined {
  const red = failedSentence(r);
  if (r !== undefined && red !== undefined) return { key: `red:${r.at}`, sentence: red, since: r.at };
  const days = Math.floor(DRILL_STALE_MS / 86_400_000);
  if (r === undefined) {
    const began = Date.parse(forgeSince?.() ?? "");
    if (!(now - began > DRILL_STALE_MS)) return undefined;
    return {
      key: "stale:none",
      sentence: `No restore drill has run in ${days} days; none has ever been recorded. docs/RECOVERY.md says how to run one.`,
      since: new Date(began + DRILL_STALE_MS).toISOString(),
    };
  }
  const at = Date.parse(r.at);
  if (!(now - at > DRILL_STALE_MS)) {
    const slow = slowSentence(r);
    return slow === undefined ? undefined : { key: `slow:${r.at}`, sentence: slow, since: r.at };
  }
  return {
    key: `stale:${r.at}`,
    sentence: `No restore drill has run in ${days} days; the last one passed on ${r.at.slice(0, 10)}. docs/RECOVERY.md says how to run one.`,
    since: new Date(at + DRILL_STALE_MS).toISOString(),
  };
}

/** The comment: snapshot, time taken, health, counts, pass or fail. */
export function verdictComment(r: DrillResult): string {
  const pass = r.verdict === "green";
  return [
    `Restore drill ${pass ? "PASSED" : `FAILED at ${r.failedStep}`} (${r.at}).`,
    "",
    `- snapshot: ${r.snapshotId ?? "none"}`,
    `- restore took: ${(r.ms / 1000).toFixed(1)} s`,
    `- health: ${r.health}`,
    `- repositories: ${r.counts.repositories}`,
    `- issues: ${r.counts.issues}`,
    `- users: ${r.counts.users}`,
    `- pulls: ${r.counts.pulls}`,
    `- apps: ${r.counts.apps}`,
    ...(pass || !r.reason ? [] : [`- why: ${r.reason}`]),
  ].join("\n");
}

export type Poster = (body: string) => Promise<string>;

/** Post on the recovery issue named by the environment; says what it did. */
export const postToRecoveryIssue: Poster = async (body) => {
  const url = process.env["FORGE_URL"];
  const token = process.env["FORGE_TOKEN"];
  const repo = process.env["FORGE_RECOVERY_REPO"] ?? "trevato/forge";
  const issue = Number(process.env["FORGE_RECOVERY_ISSUE"]);
  if (!url || !token || !Number.isInteger(issue) || issue < 1)
    return "no FORGE_URL, FORGE_TOKEN and FORGE_RECOVERY_ISSUE; not posted";
  const res = await fetch(`${url}/api/v1/repos/${repo}/issues/${issue}/comments`, {
    method: "POST",
    // An unresponsive forge must not hold the shared drill open.
    signal: AbortSignal.timeout(10_000),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ body }),
  });
  return res.ok ? `posted: ${res.status}` : `not posted: ${res.status}`;
};

/** Keep the verdict for the card and tell the recovery issue. A failed post never loses the verdict. */
export async function reportVerdict(
  dataDir: string,
  result: DrillResult,
  post: Poster = postToRecoveryIssue,
): Promise<string> {
  // A disk that will not take the file must not keep the comment from going.
  const kept = (() => {
    try {
      recordVerdict(dataDir, result);
      return "";
    } catch (error) {
      return ` (verdict not kept: ${String(error)})`;
    }
  })();
  const said = await post(verdictComment(result)).catch((error) => `not posted: ${String(error)}`);
  return said + kept;
}
