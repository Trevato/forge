/**
 * How far a running check has got, read from the lines the shard runner
 * (`scripts/test-shards.ts`) writes itself: its banner names how many files
 * the run has, and each shard it finishes says which files it ran and
 * carries `bun test`'s `N pass` / `M fail` for them. Only those lines count;
 * a log that never had them (another runner, a build step) yields nothing,
 * and a count not yet known is left out, never guessed.
 */

import type { CheckSummary } from "../core/runs.ts";
import { readLooks } from "./looks.ts";
import { checkSteps, sidewaysLine, stepsWords, vitalsRows, type LookVitals } from "./summary.ts";
import { parseTestsRow, testsRowLine } from "./tests-row.ts";
import { readRunLog } from "../runs/log.ts";

export type CheckProgress = {
  /** Files in the run, from the banner; undefined until it is written. */
  of?: number;
  /** Files whose shard has finished. */
  files?: number;
  passed?: number;
  failed?: number;
};

const BANNER = /^test-shards: (?:recording |measuring )?(\d+) files\b/;
const SHARD_OPEN = /^── shard \d+\/\d+(?: \(exit \d+, [0-9.]+s\))?: (.+)$/;
const SHARD_LIVE_OPEN = /^── shard \d+\/\d+: (.+)$/;
const SHARD_DONE = /^── shard \d+\/\d+ done \(exit \d+, [0-9.]+s\)$/;
const PASS_COUNT = /^\s*(\d+) pass$/;
const FAIL_COUNT = /^\s*(\d+) fail$/;

const fileCount = (names: string): number =>
  names.split(" ").filter((n) => n !== "").length;

export function parseShardProgress(lines: readonly string[]): CheckProgress {
  const out: CheckProgress = {};
  // The files of the shard whose lines are being read; counted once its
  // report is complete (live: at its `done` line; batched: at its header).
  let open = 0;
  for (const line of lines) {
    const banner = BANNER.exec(line);
    if (banner) {
      out.of = Number(banner[1]);
      continue;
    }
    const batched = SHARD_OPEN.exec(line);
    if (batched && line.includes("(exit")) {
      out.files = (out.files ?? 0) + fileCount(batched[1]!);
      continue;
    }
    const live = SHARD_LIVE_OPEN.exec(line);
    if (live) {
      open = fileCount(live[1]!);
      out.files ??= 0;
      continue;
    }
    if (SHARD_DONE.test(line)) {
      out.files = (out.files ?? 0) + open;
      open = 0;
      continue;
    }
    // `bun test`'s own tail counts only inside a shard's report.
    if (out.files === undefined) continue;
    const pass = PASS_COUNT.exec(line);
    if (pass) out.passed = (out.passed ?? 0) + Number(pass[1]);
    const fail = FAIL_COUNT.exec(line);
    if (fail) out.failed = (out.failed ?? 0) + Number(fail[1]);
  }
  return out;
}

/**
 * `61 of 170 files · 812 passed, 0 failed`, with each part left out when it
 * is not known: nothing at all, as an empty string, when nothing is.
 */
export function progressWords(p: CheckProgress): string {
  const parts: string[] = [];
  if (p.files !== undefined && p.of !== undefined && p.files <= p.of)
    parts.push(`${p.files} of ${p.of} files`);
  if (p.passed !== undefined && p.failed !== undefined)
    parts.push(`${p.passed} passed, ${p.failed} failed`);
  return parts.join(" · ");
}

/**
 * What both doors (the pull page and the terminal) say of a check's
 * progress: the words for a running check's own log, empty for anything
 * else. One reader, so the two cannot disagree.
 */
export function runningProgress(dataDir: string, check: CheckSummary): string {
  const run = check.run;
  if (check.state !== "running" || run === null || run.kind !== "check")
    return "";
  return progressWords(parseShardProgress(readRunLog(dataDir, run.id).lines));
}

/**
 * The run page's three step rows as one line, for the terminal: the same
 * `checkSteps` over the same log, and nothing at all when the run is not a
 * check or when the viewer may not read its log (`mayReadRunLog`), as the
 * page withholds the rows then.
 */
export function stepsLine(
  dataDir: string,
  check: CheckSummary,
  mayReadLog: boolean,
): string {
  const run = check.run;
  if (!mayReadLog || run === null || run.kind !== "check") return "";
  const { lines, truncated } = readRunLog(dataDir, run.id);
  const steps = stepsWords(checkSteps({ ...run, state: check.state === "none" ? run.state : check.state }, lines, truncated));
  const tests = testsRowLine(parseTestsRow(lines));
  return [steps, tests, vitalsLine(readLooks(dataDir, run))].filter((w) => w !== "").join(" · ");
}

/** `vitals home: LCP 3100 ms needs-improvement, CLS 0.3 poor, TBT 100 ms good; mobile: skipped: no browser` */
export function vitalsLine(looks: readonly LookVitals[]): string {
  const rows = vitalsRows(looks);
  const groups = rows.map((g) => {
    if (g.skipped !== "") return `${g.look}: skipped: ${g.skipped}`;
    const vitals = g.rows.map((r) => `${r.vital} ${r.value}${r.grade === "n/a" ? "" : ` ${r.grade}`}`);
    return `${g.look}: ${vitals.join(", ")}${g.screens === "" ? "" : `, ${g.screens} screens`}`;
  });
  if (groups.length === 0) return "";
  const sideways = sidewaysLine(rows);
  return `vitals ${groups.join("; ")}${sideways === "" ? "" : ` · ${sideways}`}`;
}
