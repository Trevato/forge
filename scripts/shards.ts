/**
 * The gate's test files, split into shards that run side by side.
 *
 * Plain data in, plain data out: how many shards, which files each gets,
 * and what one log says when they are done. `scripts/test-shards.ts` does
 * the spawning; this module only decides, so a test can prove the split
 * is disjoint and covering, and that one red shard makes the run red.
 */

/** No more than this many `bun test` processes at once, whatever the host. */
export const SHARDS_MAX = 8;

/**
 * How many shards: one per CPU the process may use, capped at
 * {@link SHARDS_MAX} and at the number of files, at least one. One per CPU,
 * not fewer: most of a forge test's time is spent waiting on git children
 * and timers, not computing. `FORGE_CHECK_SHARDS` overrides it (still
 * capped at the file count) so a small or busy host can turn it down.
 */
export function shardCount(
  cpus: number,
  files: number,
  override?: string,
): { ok: true; value: number } | { ok: false; error: string } {
  let n = Math.min(SHARDS_MAX, Math.floor(cpus));
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

/** One shard, finished: what it ran, how it exited, everything it printed. */
export interface ShardResult {
  readonly files: readonly string[];
  readonly code: number;
  readonly output: string;
}

/** What the log ends with, and the exit code of the whole run. */
export interface Tally {
  readonly code: number;
  readonly lines: string[];
}

const RAN = /^Ran (\d+) tests? across (\d+) files?\./m;
const FAIL = /^\(fail\) .*$/gm;

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
    const named = result.output.match(FAIL) ?? [];
    for (const line of new Set(named)) failing.push(`${line} [shard ${i + 1}]`);
    if (result.code !== 0 && named.length === 0)
      unnamed.push(
        `shard ${i + 1} exited ${result.code} without naming a test: ${result.files.join(" ")}`,
      );
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
 * no matrix slice — run every named file.
 */
export function parseShardSpec(
  spec: string | undefined,
):
  | { ok: true; index: number; total: number }
  | { ok: true; none: true }
  | { ok: false; error: string } {
  if (spec === undefined || spec.trim() === "") return { ok: true, none: true };
  const m = /^([1-9][0-9]{0,2})\/([1-9][0-9]{0,2})$/.exec(spec.trim());
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
