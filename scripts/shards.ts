/**
 * The gate's test files, split into shards that run side by side.
 *
 * Plain data in, plain data out: how many shards, which files each gets,
 * and what one log says when they are done. `scripts/test-shards.ts` does
 * the spawning; this module only decides, so a test can prove the split
 * is disjoint and covering, and that one red shard makes the run red.
 */

import { nameUnnamed } from "../src/checks/bun-test.ts";

/**
 * No more than this many `bun test` processes at once, whatever the host:
 * a ceiling for a big shared machine, not the check cell's number. The cell
 * (16 CPUs, 8 GiB) is bounded by its CPUs and its memory (#2038), its CPUs
 * through {@link workerCpus}; the old ceiling of 8 left half its CPUs idle.
 */
export const SHARDS_MAX = 32;

/**
 * Memory one `bun test` process is given room for: the heaviest suite peaks
 * near 260 MiB of its own (test/studio.test.ts, measured with
 * `resourceUsage().maxRSS`), and an apps suite's deploys add children of
 * their own, so twice that. Fewer workers than CPUs on a cell whose memory
 * would not hold one per CPU, rather than an OOM kill mid-gate (#386).
 */
export const WORKER_MEMORY_BYTES = 512 * 1024 * 1024;

/**
 * Memory one worker of a measuring run (`--impact`: one file per `bun test`
 * under `--coverage`) is given room for. Coverage roughly doubles a worker
 * that boots forges and apps: six main checks of 4 such workers were stopped
 * at 4105–4668 MiB of tree RSS against the cell's 4096 MiB (#3118), so about
 * 1170 MiB each at the peak; 1.25 GiB holds that with a little room, and
 * gives 3 workers in a 4096 MiB cell.
 */
export const MEASURE_WORKER_MEMORY_BYTES = 1280 * 1024 * 1024;

// Lives in src/ because the running forge sizes its checks with it, and the
// image ships src/ alone (#2652).
export { CELL_CPU_SHARE, workerCpus } from "../src/core/capacity.ts";
import { workerCpus } from "../src/core/capacity.ts";

/**
 * How many shards: one per CPU the process may use, no more than its
 * memory holds at {@link WORKER_MEMORY_BYTES} each, capped at
 * {@link SHARDS_MAX} and at the number of files, at least one. One per CPU,
 * not fewer: most of a forge test's time is spent waiting on git children
 * and timers, not computing. `memory` absent is not a bound; `workerBytes`
 * is what one worker needs of it ({@link MEASURE_WORKER_MEMORY_BYTES} for a
 * measuring run).
 * `FORGE_CHECK_SHARDS` overrides it (still capped at the file count) so a
 * small or busy host can turn it down; that is an explicit operator
 * choice and wins over the cell cap below. `cellCpus` (`FORGE_CELL_CPUS`, the
 * CPU limit of the cell the check runs in) holds the count to
 * {@link workerCpus} of it, since the runner and each worker's own threads
 * need room and the cell's guard kills a check that uses more than its
 * limit; unset or not a whole number from 1 is no limit.
 */
export function shardCount(
  cpus: number,
  files: number,
  override?: string,
  memory?: number,
  cellCpus?: string,
  workerBytes: number = WORKER_MEMORY_BYTES,
): { ok: true; value: number } | { ok: false; error: string } {
  let n = Math.min(SHARDS_MAX, Math.floor(cpus));
  if (cellCpus !== undefined && /^[1-9][0-9]{0,3}$/.test(cellCpus.trim()))
    n = workerCpus(n, Number(cellCpus.trim()));
  if (memory !== undefined && Number.isFinite(memory) && memory > 0)
    n = Math.min(n, Math.floor(memory / workerBytes));
  if (override !== undefined && override.trim() !== "") {
    if (!/^[1-9][0-9]{0,2}$/.test(override.trim()))
      return {
        ok: false,
        error: `FORGE_CHECK_SHARDS must be a whole number from 1, not ${JSON.stringify(override)}`,
      };
    n = Number(override.trim());
  }
  return { ok: true, value: Math.max(1, Math.min(n, files)) };
}

/**
 * {@link shardCount} from the process environment: `FORGE_CHECK_SHARDS`
 * (the override) and `FORGE_CELL_CPUS` (the cell's CPU limit, which the
 * forge sets for a check in `src/checks/service.ts`).
 */
export function shardCountFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  cpus: number,
  files: number,
  memory?: number,
  workerBytes?: number,
): { ok: true; value: number } | { ok: false; error: string } {
  return shardCount(cpus, files, env["FORGE_CHECK_SHARDS"], memory, env["FORGE_CELL_CPUS"], workerBytes);
}

/**
 * The memory a process may use: the least of the machine's and each
 * cgroup limit it can read (`memory.max` under v2, `memory.limit_in_bytes`
 * under v1). "max", a v1 "no limit" (a page-rounded 2^63), an unreadable
 * file (`undefined`) or anything not a whole number is no limit.
 */
export function memoryLimit(
  total: number,
  limits: readonly (string | undefined)[],
): number {
  let least = total;
  for (const text of limits) {
    const value = text?.trim() ?? "";
    if (!/^[0-9]{1,19}$/.test(value)) continue;
    const bytes = Number(value);
    if (bytes > 0 && bytes < least) least = bytes;
  }
  return least;
}

/**
 * Splits `files` into at most `n` disjoint, non-empty slices that together
 * hold every file once. `weight` is how long a file is expected to take
 * ({@link weigher}). Heaviest file first onto the lightest slice (LPT:
 * the longest shard is at most 4/3 of the best possible), so a
 * big file does not share a shard with other big ones; ties break on the
 * file's place in the list, so the same input always gives the same split.
 * Each slice keeps the list's own order.
 */
export function splitFiles(
  files: readonly string[],
  n: number,
  weight: (file: string) => number = () => 1,
): string[][] {
  const count = Math.max(1, Math.min(Math.floor(n), files.length));
  const order = files
    .map((file, index) => ({ file, index, weight: weight(file) }))
    .sort((a, b) => b.weight - a.weight || a.index - b.index);
  const slices = Array.from({ length: count }, () => ({
    load: 0,
    items: [] as { file: string; index: number }[],
  }));
  for (const item of order) {
    let lightest = slices[0]!;
    // Fewest files breaks a tie, so weightless files still spread out.
    for (const slice of slices)
      if (
        slice.load < lightest.load ||
        (slice.load === lightest.load &&
          slice.items.length < lightest.items.length)
      )
        lightest = slice;
    lightest.load += item.weight;
    lightest.items.push(item);
  }
  return slices
    .filter((slice) => slice.items.length > 0)
    .map((slice) =>
      slice.items.sort((a, b) => a.index - b.index).map((item) => item.file),
    );
}

/**
 * The most test files one `bun test` process runs. A process keeps what
 * each file leaves behind (one global per process), and the forge was
 * OOM-killed with 29 of them at 230–380 MiB each, ~110 files apiece
 * (#2410). Measured with VmHWM on Bun 1.3.14, light gate files in name
 * order: 40 files peaked at 548 MiB and 120 at 549 MiB — a process's peak
 * is its heaviest file's plus what the files before it left, so 40 keeps
 * that under 1 GiB with room, and costs a spawn (~0.1 s) per 40 files.
 */
export const FILES_PER_PROCESS = 40;

/**
 * {@link splitFiles}, with no slice over `max` files: enough slices that
 * every one fits, balanced by weight, and any still over (many light files
 * on one slice) cut in order into runs of `max`. A runner runs at most
 * `n` of them at once; this decides only what each process holds.
 */
export function splitCapped(
  files: readonly string[],
  n: number,
  weight: (file: string) => number = () => 1,
  max = FILES_PER_PROCESS,
): string[][] {
  const per = Math.max(1, Math.floor(max));
  const slices = splitFiles(files, Math.max(n, Math.ceil(files.length / per)), weight);
  return slices.flatMap((slice) =>
    Array.from({ length: Math.ceil(slice.length / per) }, (_, i) => slice.slice(i * per, (i + 1) * per)),
  );
}

/** How a test file is named: the same rule `scripts/test-shards.ts` uses. */
export const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;

/** A test's short name after `--`: `crew-wrapup` is `test/crew-wrapup.test.ts`. */
const TEST_NAME = /^[a-z0-9][a-z0-9-]{0,99}$/;

/**
 * Splits `scripts/test-shards.ts`'s arguments into `bun test` flags and
 * test files. Before `--`, an argument naming a test file is a file and
 * anything else a flag; after it, every argument is a short name under
 * `test/` (`crew` is `test/crew.test.ts`), which keeps `forge.json`'s
 * `check.run` under the manifest's 1000-character bound.
 */
export function splitArgs(
  args: readonly string[],
):
  | { ok: true; flags: string[]; files: string[] }
  | { ok: false; error: string } {
  const at = args.indexOf("--");
  const head = at === -1 ? args : args.slice(0, at);
  const names = at === -1 ? [] : args.slice(at + 1);
  const flags = head.filter((arg) => !TEST_FILE.test(arg));
  const files = head.filter((arg) => TEST_FILE.test(arg));
  for (const name of names) {
    if (!TEST_NAME.test(name))
      return { ok: false, error: `${JSON.stringify(name)} is not a test name` };
    files.push(`test/${name}.test.ts`);
  }
  return { ok: true, flags, files };
}

/** A sane bound on one entry of the times table: a day, in seconds. */
const TIME_MAX = 86_400;

/**
 * Seconds per byte when the table says nothing about any file in the list:
 * about what this suite showed when the table was first recorded (a 40 kB
 * file of forge-booting tests runs for tens of seconds). Only the ratio
 * between fallback files matters then, so the constant's exact value does
 * not change the split; it only has to be in the right range beside
 * measured seconds.
 */
export const SECONDS_PER_BYTE_DEFAULT = 1 / 2_000;

/**
 * Reads `scripts/test-times.json`: one object, test file path to the
 * seconds it took alone, e.g. `{ "test/crew.test.ts": 50.1 }`. Anything
 * else — not JSON, not an object, a key that is not a test file, a value
 * that is not a finite number from 0 to a day — refuses the whole table,
 * so a half-trusted table never steers the split.
 */
export function parseTimes(
  text: string,
): { ok: true; value: Map<string, number> } | { ok: false; error: string } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: "not JSON" };
  }
  if (typeof data !== "object" || data === null || Array.isArray(data))
    return { ok: false, error: "not an object of file to seconds" };
  const times = new Map<string, number>();
  for (const [file, seconds] of Object.entries(data)) {
    if (!TEST_FILE.test(file) || file.length > 512)
      return { ok: false, error: `${JSON.stringify(file)} is not a test file` };
    if (
      typeof seconds !== "number" ||
      !Number.isFinite(seconds) ||
      seconds < 0 ||
      seconds > TIME_MAX
    )
      return {
        ok: false,
        error: `${file}: ${JSON.stringify(seconds)} is not seconds from 0 to ${TIME_MAX}`,
      };
    times.set(normalise(file), seconds);
  }
  return { ok: true, value: times };
}

/** `./test/a.test.ts` and `test/a.test.ts` are the same file. */
function normalise(file: string): string {
  return file.startsWith("./") ? file.slice(2) : file;
}

/**
 * How long each file is expected to take, in seconds: its measured time
 * from the table when there is one, else its size in bytes scaled to
 * seconds. The scale is fitted on the files that have both (total
 * measured seconds ÷ their total bytes), so a new file is weighed like
 * its neighbours; with none, {@link SECONDS_PER_BYTE_DEFAULT}. A pure
 * function of the list, the sizes and the table: the same three always
 * give the same weights, so the same split.
 */
export function weigher(
  files: readonly string[],
  bytes: ReadonlyMap<string, number>,
  times: ReadonlyMap<string, number>,
): (file: string) => number {
  let seconds = 0;
  let size = 0;
  for (const file of files) {
    const measured = times.get(normalise(file));
    const b = bytes.get(file);
    if (measured === undefined || b === undefined) continue;
    seconds += measured;
    size += b;
  }
  const perByte =
    seconds > 0 && size > 0 ? seconds / size : SECONDS_PER_BYTE_DEFAULT;
  return (file) =>
    times.get(normalise(file)) ?? (bytes.get(file) ?? 0) * perByte;
}

/**
 * The table as it is checked in: keys sorted, seconds to one decimal, one
 * file per line, so a refresh reads as a small diff.
 */
export function formatTimes(times: ReadonlyMap<string, number>): string {
  const entries = [...times]
    .map(([file, seconds]) => [normalise(file), seconds] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const lines = entries.map(
    ([file, seconds]) =>
      `  ${JSON.stringify(file)}: ${Math.round(seconds * 10) / 10}`,
  );
  return lines.length === 0 ? "{}\n" : `{\n${lines.join(",\n")}\n}\n`;
}

/**
 * The order a pool of one-file workers takes files in: heaviest first (LPT
 * on a work queue: the wall is at most the heaviest file plus an even
 * share of the rest), ties in the list's own order.
 */
export function heaviestFirst(
  files: readonly string[],
  weight: (file: string) => number,
): string[] {
  return files
    .map((file, index) => ({ file, index, weight: weight(file) }))
    .sort((a, b) => b.weight - a.weight || a.index - b.index)
    .map((item) => item.file);
}

/** `over`'s times where it has them, `base`'s for every other file. */
export function overlayTimes(
  base: ReadonlyMap<string, number>,
  over: ReadonlyMap<string, number>,
): Map<string, number> {
  const merged = new Map(base);
  for (const [file, seconds] of over) merged.set(file, seconds);
  return merged;
}

/**
 * The table after a green run: every file it ran at the time it took, every
 * other file it still has at its old time, a file no longer on disk gone.
 */
export function refreshTimes(
  old: ReadonlyMap<string, number>,
  ran: readonly { file: string; seconds: number }[],
  exists: (file: string) => boolean,
): Map<string, number> {
  const fresh = new Map<string, number>();
  for (const [file, seconds] of old) if (exists(file)) fresh.set(file, seconds);
  for (const { file, seconds } of ran) fresh.set(normalise(file), seconds);
  return fresh;
}

/** One shard, finished: what it ran, how it exited, everything it printed. */
export interface ShardResult {
  readonly files: readonly string[];
  readonly code: number;
  readonly output: string;
  /** How long the shard ran, when the runner timed it. */
  readonly seconds?: number;
}

/**
 * The most shards one run re-runs after a crash outside any test (#7788).
 * One crash is a leaked timer or socket from a file before; more than
 * this is a change that breaks loading, and re-running it only doubles
 * the wall.
 */
export const CRASH_RERUNS = 3;

/**
 * Whether a finished shard crashed outside any test: it went red and its
 * report is not only failed tests ({@link onlyTestFailures}) — an
 * unhandled error between tests ("Cannot use a closed database" from a
 * timer the file before left), a file that would not load, a process that
 * died before its summary. Such a shard is re-run once, whole.
 */
export function crashedOutside(result: Pick<ShardResult, "code" | "output">): boolean {
  return result.code !== 0 && !onlyTestFailures(result.output);
}

/**
 * The crashed run's output, kept in the log for whoever reads it, each line
 * behind `  │ ` so nothing that reads the log (the tally, the failing-test
 * list) counts its reds beside the re-run's.
 */
export function quoteCrash(where: string, code: number, output: string): string {
  const lines = output.replace(/\n$/, "").split("\n");
  return [
    `test-shards: shard ${where} crashed outside any test (exit ${code}); re-running it once. The crashed run:`,
    ...lines.map((line) => `  │ ${line}`),
    "",
  ].join("\n");
}

/** What the log ends with, and the exit code of the whole run. */
export interface Tally {
  readonly code: number;
  readonly lines: string[];
}

const RAN = /^Ran (\d+) tests? across (\d+) files?\./m;
const FAIL = /^\(fail\) .*$/gm;
const FILE_STARTED = /^(\S+\.test\.[cm]?[jt]sx?):$/gm;

/** The last test file a shard's output says it started, if any. */
export function lastStarted(output: string): string | undefined {
  return [...output.matchAll(FILE_STARTED)].at(-1)?.[1];
}

/** The line for a red shard that named no test: where it was and how long it ran, when known. */
function unnamedLine(n: number, result: ShardResult): string {
  const running = lastStarted(result.output);
  if (running !== undefined && result.seconds !== undefined)
    return `shard ${n} killed after ${Math.round(result.seconds)} s, running ${running}`;
  return `shard ${n} exited ${result.code} without naming a test: ${result.files.join(" ")}`;
}

/**
 * Reads every shard's `bun test` output into one ending. Green: one line,
 * how many tests across how many files and how long. Red: every failing
 * test from every shard, and any shard that went red without naming one
 * (a file that would not load, a crash between tests) by its files.
 */
export function tally(results: readonly ShardResult[], seconds: number): Tally {
  let tests = 0;
  let files = 0;
  const failing: string[] = [];
  const unnamed: string[] = [];
  results.forEach((result, i) => {
    const ran = RAN.exec(result.output);
    if (ran) {
      tests += Number(ran[1]);
      files += Number(ran[2]);
    }
    const named = nameUnnamed(result.output.split("\n")).join("\n").match(FAIL) ?? [];
    for (const line of new Set(named)) failing.push(`${line} [shard ${i + 1}]`);
    if (result.code !== 0 && named.length === 0)
      unnamed.push(unnamedLine(i + 1, result));
  });
  const took = `${seconds.toFixed(1)}s`;
  const shards = `${results.length} shard${results.length === 1 ? "" : "s"}`;
  const red = results.filter((result) => result.code !== 0).length;
  if (red === 0)
    return {
      code: 0,
      lines: [
        `Ran ${tests} tests across ${files} files in ${took} (${shards}).`,
      ],
    };
  return {
    code: 1,
    lines: [
      `${red} of ${shards} failed:`,
      ...failing,
      ...unnamed,
      `Ran ${tests} tests across ${files} files in ${took}; ${failing.length} failed.`,
    ],
  };
}

/**
 * Contiguous 1-based slice of `files` for Actions matrix cells (`--shard N/M`).
 * Slices are disjoint and covering; empty only when `files` is empty.
 */
export function sliceFiles(
  files: readonly string[],
  index: number,
  total: number,
): { ok: true; files: string[] } | { ok: false; error: string } {
  if (!Number.isInteger(total) || total < 1)
    return {
      ok: false,
      error: `shard total must be a whole number from 1, not ${JSON.stringify(total)}`,
    };
  if (!Number.isInteger(index) || index < 1 || index > total)
    return {
      ok: false,
      error: `shard index must be from 1 to ${total}, not ${JSON.stringify(index)}`,
    };
  const start = Math.floor((files.length * (index - 1)) / total);
  const end = Math.floor((files.length * index) / total);
  return { ok: true, files: [...files.slice(start, end)] };
}

/**
 * Parses `--shard N/M` (or the same shape from env). Empty / undefined means
 * no matrix slice — run every named file. Four digits a side: the gate
 * passed 999 files, and a slice per file must still be nameable.
 */
export function parseShardSpec(
  spec: string | undefined,
):
  | { ok: true; index: number; total: number }
  | { ok: true; none: true }
  | { ok: false; error: string } {
  if (spec === undefined || spec.trim() === "") return { ok: true, none: true };
  const m = /^([1-9][0-9]{0,3})\/([1-9][0-9]{0,3})$/.exec(spec.trim());
  if (!m)
    return {
      ok: false,
      error: `shard must be N/M (e.g. 1/3), not ${JSON.stringify(spec)}`,
    };
  const index = Number(m[1]);
  const total = Number(m[2]);
  if (index > total)
    return {
      ok: false,
      error: `shard index ${index} is past total ${total}`,
    };
  return { ok: true, index, total };
}

/**
 * Which of a shard's failing files were red only beside others. `alone` maps
 * a file to whether it passed when run by itself: true moves it to
 * `besideOthers`; false, or no entry (never retried), keeps it red. Only the
 * first `cap` files of the shard may be cleared, so a shard that is red
 * across the board stays red. `line` names the cleared files and the files
 * that stayed red beside them, or is null when nothing was cleared.
 */
export function besideOthers(
  red: readonly string[],
  alone: Readonly<Record<string, boolean>> | ReadonlyMap<string, boolean>,
  cap = 3,
): { red: string[]; besideOthers: string[]; line: string | null } {
  const results = alone instanceof Map ? alone : new Map(Object.entries(alone));
  const limit = Math.max(0, cap);
  const stillRed: string[] = [];
  const cleared: string[] = [];
  red.forEach((file, i) => {
    if (i < limit && results.get(file) === true) cleared.push(file);
    else stillRed.push(file);
  });
  if (cleared.length === 0) return { red: stillRed, besideOthers: [], line: null };
  const mates = stillRed.length > 0 ? stillRed.join(", ") : "none";
  const line = `fails only beside others: ${cleared.join(", ")} (shard-mates: ${mates})`;
  return { red: stillRed, besideOthers: cleared, line };
}

// Under GitHub-style Actions (GITHUB_ACTIONS=true, which Forgejo's runner
// sets too) bun opens each file's tests with `::group::path:` instead of
// `path:`; the group marker is not part of the path.
const HEADER = /^(?:::group::)?(\S+\.test\.[cm]?[jt]sx?):$/;
const FAILED = /^\(fail\) /;

/**
 * The files whose tests failed in one `bun test` report, in the order the
 * report reached them: bun prints `path:` (in an Actions job,
 * `::group::path:`) before a file's tests and `(fail) name` for each one
 * that failed. A report that names no failing test (a crash, a file that
 * would not load) yields none.
 */
export function failingFiles(output: string): string[] {
  const found: string[] = [];
  let current: string | undefined;
  for (const line of output.split("\n")) {
    const header = HEADER.exec(line);
    if (header) current = header[1]!;
    else if (FAILED.test(line) && current !== undefined && !found.includes(current))
      found.push(current);
  }
  return found;
}

/**
 * Whether every red in one `bun test` report is a failed test: the report
 * reached its summary, counts no errors, and has no unhandled error between
 * tests. A file that threw while loading, an error outside any test, or a
 * crash before the summary is red for a reason a second run alone does not
 * explain away, so nothing in such a report may be cleared.
 */
export function onlyTestFailures(output: string): boolean {
  if (!/^Ran \d+ tests? across \d+ files?/m.test(output)) return false;
  if (/^# Unhandled error/m.test(output)) return false;
  return !/^\s*[1-9][0-9]* errors?\s*$/m.test(output);
}
