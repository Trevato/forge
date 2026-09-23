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
 * hold every file once. Heaviest file first onto the lightest slice, so a
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
