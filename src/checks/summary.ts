/**
 * What a failed check's summary says first: bun test's own name and counts
 * when the check step's output carried them, the output's own last word
 * when it did not, and the bare exit code only when the output said
 * nothing at all. Plain data in (the check step's own lines, and the
 * error `runStep` already gives up), plain data out — never a re-read of
 * the run's log, and never a guess at *why* a test failed.
 */

import type { CheckDetail, Run } from "../core/runs.ts";
import { parseBunTestFailure } from "./bun-test.ts";
import { oneLine } from "./words.ts";

/**
 * The first line of the block a timed full gate ends its log with
 * (`scripts/gate-summary.ts`): what follows it — slow-file warnings among
 * it — is how the cell ran, never why the check is red (#2271).
 */
export const GATE_SUMMARY_HEADING = "── gate summary";

/** The sharded gate's line for a red shard that named no test (`tally` in scripts/shards.ts). */
const UNNAMED_SHARD = /^shard [0-9]+ exited -?[0-9]+ without naming a test: /;

/** A summary is one line on a card; a name from a subprocess is bounded to fit it. */
const SUMMARY_MAX = 200;

function truncate(text: string): string {
  return text.length > SUMMARY_MAX
    ? `${text.slice(0, SUMMARY_MAX - 1)}…`
    : text;
}

export interface CheckFailure {
  /** The one line a card shows, already bounded. */
  readonly summary: string;
  /** `bun test`'s own counts and names, when the output was its shape. */
  readonly detail: CheckDetail | undefined;
}

/**
 * `lines` is the check step's own output, nothing from `install` mixed in
 * (`checks/service.ts` keeps them apart already). `fallback` is what
 * `runStep` says when a step exits non-zero — "check exited with code 1",
 * sometimes with a reason it found on its own — used only when this
 * output named nothing better, so a truthful "no output at all" is never
 * dressed up as more than it is. Without test names the summary is the
 * sharded gate's first red shard that named none, else the last line
 * before the gate summary block — never a line of the block itself.
 */
export function summariseCheckFailure(
  lines: readonly string[],
  fallback: string,
): CheckFailure {
  const detail = parseBunTestFailure(lines);
  if (detail !== undefined) {
    const total = detail.passed + detail.failed;
    const name = detail.names[0] ?? "";
    return {
      summary: truncate(`${detail.failed} of ${total} tests — "${name}"`),
      detail,
    };
  }
  const unnamed = lines.find((line) => UNNAMED_SHARD.test(line.trim()));
  if (unnamed !== undefined)
    return { summary: truncate(unnamed.trim()), detail: undefined };
  const block = lines.findLastIndex((line) => line.trim() === GATE_SUMMARY_HEADING);
  for (let i = (block === -1 ? lines.length : block) - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (line !== "") return { summary: truncate(line), detail: undefined };
  }
  return { summary: fallback, detail: undefined };
}

/** `45s`, `12 min`, `1h 5m`: a span in the fewest words that stay true. */
export function spanWords(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return rest === 0
    ? `${Math.floor(minutes / 60)}h`
    : `${Math.floor(minutes / 60)}h ${rest}m`;
}

/**
 * What a pull's checks line says of a *check* run, in the check's own
 * words — never "deploy". `undefined` for a state the line words itself
 * (queued, cancelled, none) or when the run is not a check.
 */
export function checkWords(
  run: Pick<
    Run,
    "kind" | "state" | "createdAt" | "startedAt" | "finishedAt" | "summary" | "checkDetail"
  >,
  now = Date.now(),
): string | undefined {
  if (run.kind !== "check") return undefined;
  const began = Date.parse(run.startedAt ?? run.createdAt);
  if (run.state === "running")
    return `Check running · ${spanWords(now - began)}`;
  if (run.state === "ok")
    return run.finishedAt === null
      ? "Check passed"
      : `Check passed in ${spanWords(Date.parse(run.finishedAt) - began)}`;
  if (run.state === "failed") {
    const first = run.checkDetail?.names[0] ?? run.summary;
    return first === "" ? "Check failed" : `Check failed: ${oneLine(first)}`;
  }
  return undefined;
}
