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
import type { DrillResult, DrillStep } from "./drill.ts";

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
  return `The restore drill failed at ${r.failedStep ?? "an unknown step"}${r.reason ? `: ${r.reason}` : ""}. Snapshot ${r.snapshotId ?? "none"}; docs/RECOVERY.md says what to do.`;
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
