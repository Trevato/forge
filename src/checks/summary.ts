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
import { fullShard, OUT_OF_ROOM, TEMP_FULL } from "./disk_full.ts";
import { oneLine } from "./words.ts";
import { clip } from "../text/clip.ts";
import { webvitals, type Entries } from "../release/webvitals.ts";
import type { PageSize } from "../looks/capture.ts";
export type { PageSize };

/**
 * The first line of the block a timed full gate ends its log with
 * (`scripts/gate-summary.ts`): what follows it — slow-file warnings among
 * it — is how the cell ran, never why the check is red (#2271).
 */
export const GATE_SUMMARY_HEADING = "── gate summary";

/** The sharded gate's line for a red shard that named no test (`tally` in scripts/shards.ts). */
const UNNAMED_SHARD =
  /^shard [0-9]+ (?:exited -?[0-9]+ without naming a test: |killed after [0-9]+ s, running )/;

/** A summary is one line on a card; a name from a subprocess is bounded to fit it. */
const SUMMARY_MAX = 200;

const truncate = (text: string): string => clip(text, SUMMARY_MAX);

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
  const parsed = parseBunTestFailure(lines);
  // A shard that ran out of temp space is marked on the detail, not worded
  // into the summary: the crew reads the mark, the summary keeps the failures.
  const full = fullShard(lines);
  const detail = full
    ? { ...(parsed ?? { passed: 0, failed: 0, names: [] }), environment: TEMP_FULL }
    : parsed;
  const note = full ? `${OUT_OF_ROOM} (the environment's fault): ` : "";
  if (parsed !== undefined && detail !== undefined) {
    const total = detail.passed + detail.failed;
    const names = [...new Set(detail.names)].slice(0, 3);
    const quoted = names.map((n) => `"${n}"`);
    const more = detail.failed - names.length;
    const list =
      names.length === 0
        ? '""'
        : more > 0
          ? `${quoted.join(", ")} and ${more} more`
          : quoted.length > 1
            ? `${quoted.slice(0, -1).join(", ")} and ${quoted.at(-1)}`
            : quoted[0]!;
    return {
      summary: truncate(`${note}${detail.failed} of ${total} tests — ${list}`),
      detail,
    };
  }
  const unnamed = lines.find((line) => UNNAMED_SHARD.test(line.trim()));
  if (full) return { summary: truncate(`${note}${unnamed?.trim() ?? fallback}`), detail };
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
  /** `progressWords` of the run's log, when it has any. */
  progress = "",
): string | undefined {
  if (run.kind !== "check") return undefined;
  const began = Date.parse(run.startedAt ?? run.createdAt);
  if (run.state === "running")
    return `Check running · ${spanWords(now - began)}${progress === "" ? "" : ` · ${progress}`}`;
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

export type StepName = "install" | "typecheck" | "tests";
export type StepState =
  | "pending"
  | "running"
  | "ok"
  | "failed"
  | "stopped"
  | "unknown";

export interface CheckStep {
  readonly name: StepName;
  readonly state: StepState;
}

/** `$ <command>` is what `runStep` and the job runner echo before each command. */
const ECHO = /^\$ /;
/** The package manager's own install, never a script that merely has the word in its name. */
const INSTALL_ECHO = /^\$ (?:bun|npm|pnpm|yarn)(?: -\S+)* (?:install|ci)\b/;
/** The shard runner's banner and shard headers: the tests have begun. */
const TESTS_BEGUN = /^test-shards: |^── shard /;

/**
 * The three rows of a check's run page — install, typecheck, tests — read
 * from the run's state and the lines the check wrote, never from a new
 * record. The log carries no step boundaries of its own, so each is
 * inferred from the furthest sign of progress: an echoed command, then the
 * shard runner's banner (typecheck comes before it in the check command).
 * A repository without an install command has its install row `ok` once
 * the check begins. A job-placed check echoes every command up front, so
 * its install is only done once output follows the echoes. Always three
 * rows, so the page never shifts when a state changes. `lines` may be only
 * the tail of a long log (`truncated`): the echoes are then gone, so unless
 * the tests are seen to have begun, or the run passed, the rows are
 * `unknown` rather than read wrong.
 */
export function checkSteps(
  run: Pick<Run, "state" | "placement">,
  lines: readonly string[],
  truncated = false,
): readonly CheckStep[] {
  const echoes = lines.flatMap((line, i) => (ECHO.test(line) ? [i] : []));
  const hasInstall = lines.some((line) => INSTALL_ECHO.test(line));
  const needed = hasInstall ? 2 : 1;
  const lastEcho = echoes.at(-1);
  const output = lastEcho !== undefined && lastEcho < lines.length - 1;
  const checkBegan =
    echoes.length >= needed && (run.placement !== "job" || output);
  const testsBegan = lines.some((line) => TESTS_BEGUN.test(line));
  if (truncated && run.state !== "ok" && !testsBegan)
    return (["install", "typecheck", "tests"] as const).map((name) => ({
      name,
      state: "unknown",
    }));
  // A tail that begins after the echoes still shows the tests by their own banner.
  const live = run.state === "running";
  const dead = run.state === "failed" || run.state === "cancelled";
  const after = run.state === "cancelled" ? "stopped" : "failed";

  // The first step not yet done is where the run is, or where it ended.
  const reached = testsBegan ? 2 : checkBegan ? 1 : 0;
  const names: StepName[] = ["install", "typecheck", "tests"];
  return names.map((name, i): CheckStep => {
    if (run.state === "ok") return { name, state: "ok" };
    if (i < reached) return { name, state: "ok" };
    if (i === reached) {
      if (live) return { name, state: "running" };
      if (dead) return { name, state: after };
    }
    return { name, state: "pending" };
  });
}

const STEP_WORDS: Record<StepState, string> = {
  pending: "waiting",
  running: "running",
  ok: "passed",
  failed: "failed",
  stopped: "stopped",
  unknown: "unknown",
};

/** `install passed · typecheck passed · tests running`: the page's rows, in a line. */
export const stepWord = (state: StepState): string => STEP_WORDS[state];

export function stepsWords(steps: readonly CheckStep[]): string {
  return steps.map((s) => `${s.name} ${stepWord(s.state)}`).join(" · ");
}

/** One look's recorded entries, or why it has none; plain data from the caller. */
export type LookVitals =
  | { readonly look: string; readonly entries: Entries; readonly size?: PageSize }
  | { readonly look: string; readonly skipped: string };

/** One cell row of a look's table: words only, escaped where they are rendered. */
export interface VitalsRow {
  readonly vital: string;
  /** `n/a` when the page recorded no entry, never zero. */
  readonly value: string;
  readonly thresholds: string;
  readonly grade: string;
}

export interface LookRows {
  readonly look: string;
  /** Why the look has no numbers (`no browser`); empty when it has rows. */
  readonly skipped: string;
  readonly rows: readonly VitalsRow[];
  /** Screens tall (scrollHeight / innerHeight, one decimal); empty without a size. */
  readonly screens: string;
  /** A phone look whose page is wider than its window; false without a size. */
  readonly sideways: boolean;
}

const isPhone = (look: string): boolean => look === "phone" || look.startsWith("phone ");

/** `phone /x scrolls sideways` for each phone look wider than its window; empty when none. */
export function sidewaysLine(groups: readonly LookRows[]): string {
  return groups
    .filter((g) => g.sideways)
    .map((g) => `${g.look} scrolls sideways`)
    .join("; ");
}

const VITAL_ROWS = [
  ["LCP", "lcpMs"],
  ["CLS", "cls"],
  ["TBT", "tbtMs"],
] as const;

const shown = (n: number, unit: string): string => `${n}${unit === "" ? "" : ` ${unit}`}`;

/**
 * Each look's LCP, CLS and TBT beside their thresholds and grade. Report-only:
 * it returns words and has no verdict, so nothing in it can turn a check red.
 */
export function vitalsRows(looks: readonly LookVitals[]): readonly LookRows[] {
  return looks.map((l) => {
    if ("skipped" in l) return { look: l.look, skipped: l.skipped, rows: [], screens: "", sideways: false };
    const v = webvitals(l.entries);
    const rows = VITAL_ROWS.map(([vital, key]): VitalsRow => {
      const x = v[key];
      return {
        vital,
        value: x.value === null ? "n/a" : shown(x.value, x.unit),
        thresholds: `good ≤ ${shown(x.good, x.unit)}, poor > ${shown(x.poor, x.unit)}`,
        grade: x.grade ?? "n/a",
      };
    });
    const z = l.size;
    const tall = z === undefined || z.innerHeight <= 0 ? null : z.scrollHeight / z.innerHeight;
    const screens = tall === null ? "" : (Math.round(tall * 10) / 10).toFixed(1);
    const sideways = z !== undefined && isPhone(l.look) && z.scrollWidth > z.innerWidth;
    return { look: l.look, skipped: "", rows, screens, sideways };
  });
}
