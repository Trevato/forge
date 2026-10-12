/**
 * `bun test`, over the named files, in parallel shards.
 *
 *   bun scripts/test-shards.ts [bun test flags…] --gate
 *   bun scripts/test-shards.ts [bun test flags…] --gate --shard 1/3
 *   bun scripts/test-shards.ts [bun test flags…] test/a.test.ts test/b.test.ts …
 *   bun scripts/test-shards.ts --record [bun test flags…] test/a.test.ts …
 *   bun scripts/test-shards.ts [bun test flags…] -- a b …   (test/a.test.ts …)
 *
 * `--gate` runs the files `scripts/gate.ts` admits, which is how
 * `forge.json`'s `check.run` names them; files on the command line are for
 * running a slice by hand. `--shard N/M` (or `FORGE_CHECK_SHARD_INDEX` +
 * `FORGE_CHECK_SHARD_TOTAL`) keeps only the Nth contiguous slice of that
 * list so Actions can matrix the gate across jobs without parallel bun
 * inside one container. Each shard is its own `bun test`
 * over a disjoint slice (`scripts/shards.ts` decides the slices). Shards
 * that run one after another (`FORGE_CHECK_SHARDS=1`, `--record`) write
 * each line the moment the test says it, so a check's log tails live;
 * shards that run side by side are written through whole as each
 * finishes, so the log reads one shard at a time. Either way the tail
 * names every failing test from every shard. The first red shard stops
 * the rest (fail-fast) so a known fail does not burn the remaining wall
 * clock. Exits non-zero if any shard does.
 *
 * Files are weighed by how long they took, from `scripts/test-times.json`
 * (a file it does not name, or a table it refuses, falls back to bytes).
 * `--record` refreshes that table: the same number of workers, but each
 * file is its own `bun test`, timed alone from spawn to exit, and the
 * table is rewritten from those times when every file is green.
 */

import { availableParallelism } from "node:os";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import {
  formatTimes,
  parseShardSpec,
  parseTimes,
  shardCount,
  sliceFiles,
  splitArgs,
  splitFiles,
  tally,
  weigher,
  type ShardResult,
} from "./shards.ts";
import { GATE } from "./gate.ts";

const TIMES = new URL("./test-times.json", import.meta.url).pathname;

const argv = process.argv.slice(2);
const record = argv.includes("--record");
const gate = argv.includes("--gate");

/** Pull `--shard N/M` or `--shard=N/M` out of argv so it never reaches bun test. */
function takeShardArg(raw: string[]): {
  rest: string[];
  spec: string | undefined;
  error?: string;
} {
  const rest: string[] = [];
  let spec: string | undefined;
  for (let i = 0; i < raw.length; i++) {
    const arg = raw[i]!;
    if (arg === "--shard") {
      const next = raw[i + 1];
      if (next === undefined || next.startsWith("-"))
        return { rest, spec, error: "--shard needs N/M (e.g. 1/3)" };
      if (spec !== undefined)
        return { rest, spec, error: "--shard named twice" };
      spec = next;
      i++;
      continue;
    }
    if (arg.startsWith("--shard=")) {
      if (spec !== undefined)
        return { rest, spec, error: "--shard named twice" };
      spec = arg.slice("--shard=".length);
      continue;
    }
    rest.push(arg);
  }
  return { rest, spec };
}

const taken = takeShardArg(
  argv.filter((arg) => arg !== "--record" && arg !== "--gate"),
);
if (taken.error) {
  console.error(`test-shards: ${taken.error}`);
  process.exit(2);
}
const args = taken.rest;
// CLI --shard wins; else FORGE_CHECK_SHARD_INDEX + FORGE_CHECK_SHARD_TOTAL.
const envIndex = process.env["FORGE_CHECK_SHARD_INDEX"];
const envTotal = process.env["FORGE_CHECK_SHARD_TOTAL"];
const envSpec =
  envIndex !== undefined && envTotal !== undefined
    ? `${envIndex}/${envTotal}`
    : envIndex !== undefined || envTotal !== undefined
      ? // one without the other is nonsense — refuse via parseShardSpec shape
        `${envIndex ?? ""}/${envTotal ?? ""}`
      : undefined;
const shardSpec = parseShardSpec(taken.spec ?? envSpec);
if (!shardSpec.ok) {
  console.error(`test-shards: ${shardSpec.error}`);
  process.exit(2);
}

const split = splitArgs(args);
if (!split.ok) {
  console.error(`test-shards: ${split.error}`);
  process.exit(2);
}
const flags = split.flags;
let files = [...(gate ? GATE : []), ...split.files];

if (files.length === 0) {
  console.error("test-shards: name the test files to run, or --gate");
  process.exit(2);
}

if (!("none" in shardSpec)) {
  const sliced = sliceFiles(files, shardSpec.index, shardSpec.total);
  if (!sliced.ok) {
    console.error(`test-shards: ${sliced.error}`);
    process.exit(2);
  }
  const sliceBanner =
    `test-shards: matrix slice ${shardSpec.index}/${shardSpec.total} ` +
    `(${sliced.files.length} of ${files.length} files)`;
  console.log(sliceBanner);
  process.stderr.write(sliceBanner + "\n");
  files = sliced.files;
  if (files.length === 0) {
    console.log("test-shards: empty matrix slice; nothing to run");
    process.exit(0);
  }
}
// A file that is not there would be a filter matching nothing to `bun
// test`: a gate that quietly judges less than it says.
const size = new Map<string, number>();
for (const file of files) {
  try {
    size.set(file, statSync(file).size);
  } catch {
    console.error(`test-shards: ${file} does not exist`);
    process.exit(2);
  }
}
if (new Set(files).size !== files.length) {
  console.error("test-shards: a file is named twice");
  process.exit(2);
}

const count = shardCount(
  availableParallelism(),
  files.length,
  process.env["FORGE_CHECK_SHARDS"],
);
if (!count.ok) {
  console.error(`test-shards: ${count.error}`);
  process.exit(2);
}
// FORGE_CHECK_SHARDS is only for this runner's shard count. Drop it before
// spawning `bun test` so capacityDefault / capacityEnv inside the suite do
// not treat the gate's own setting as a forge boot default (#874).
delete process.env["FORGE_CHECK_SHARDS"];
delete process.env["FORGE_CHECK_SHARD_INDEX"];
delete process.env["FORGE_CHECK_SHARD_TOTAL"];
// Measured seconds where the table has them, bytes scaled to seconds
// where it does not. A missing or refused table is said out loud and the
// gate still runs, on bytes alone.
let times = new Map<string, number>();
let table = "";
try {
  table = readFileSync(TIMES, "utf8");
} catch {
  console.log("test-shards: no scripts/test-times.json; weighing by bytes");
}
if (table !== "") {
  const parsed = parseTimes(table);
  if (parsed.ok) times = parsed.value;
  else
    console.log(
      `test-shards: scripts/test-times.json refused (${parsed.error}); weighing by bytes`,
    );
}
const weight = weigher(files, size, times);
// Recording runs one file per process, so every file is its own slice.
// FORGE_CHECK_SHARDS=1 on the isolated Actions runner still OOMed when one
// bun test held the whole gate (#386/#388, exit 137 ~15–17m). Same count
// with one-file-per-process, serial, keeps peak RSS to a single suite.
const serialFiles = !record && count.value === 1;
const slices =
  record || serialFiles
    ? files.map((file) => [file])
    : splitFiles(files, count.value, weight);

const banner = record
  ? `test-shards: recording ${files.length} files, ${count.value} at a time`
  : serialFiles
    ? `test-shards: ${files.length} files serial (one bun test each; FORGE_CHECK_SHARDS=1), ` +
      `expected ${files.reduce((sum, file) => sum + weight(file), 0).toFixed(0)}s`
    : `test-shards: ${files.length} files in ${slices.length} shard${slices.length === 1 ? "" : "s"}, ` +
      `expected ${slices.map((slice) => slice.reduce((sum, file) => sum + weight(file), 0).toFixed(0) + "s").join(" ")}`;
console.log(banner);
process.stderr.write(banner + "\n");

const children = new Set<Bun.Subprocess>();
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    for (const child of children) child.kill(signal);
    process.exit(130);
  });

async function drain(
  stream: ReadableStream<Uint8Array>,
  into: string[],
  /** Where each piece also goes as it arrives: the live tail. */
  through?: (text: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  const take = (text: string): void => {
    into.push(text);
    if (text !== "") through?.(text);
  };
  for await (const chunk of stream)
    take(decoder.decode(chunk, { stream: true }));
  take(decoder.decode());
}

type Timed = ShardResult & { seconds: number };

/**
 * One shard. `live` (shards running one at a time) writes the shard's
 * output as it arrives, between a header and a footer line; otherwise the
 * output is held and written through whole when the shard ends, so shards
 * running side by side never interleave.
 */
async function runShard(
  slice: string[],
  index: number,
  live: boolean,
): Promise<Timed> {
  const started = performance.now();
  const where = `${index + 1}/${slices.length}`;
  // Print before spawn so a mid-suite cgroup SIGKILL still leaves a breadcrumb.
  // stderr: Actions often block-buffers stdout until exit; an OOM never flushes.
  process.stderr.write(`test-shards: start ${where} ${slice.join(" ")}\n`);
  if (live) process.stdout.write(`\n── shard ${where}: ${slice.join(" ")}\n`);
  // An exact path, never a filter: `test/web.test.ts` alone would also
  // match any file whose path contains it, in some other shard.
  const paths = slice.map((file) =>
    file.startsWith("/") || file.startsWith("./") ? file : `./${file}`,
  );
  const childEnv = { ...process.env };
  delete childEnv["FORGE_CHECK_SHARDS"];
  delete childEnv["FORGE_CHECK_SHARD_INDEX"];
  delete childEnv["FORGE_CHECK_SHARD_TOTAL"];
  // NODE_OPTIONS is for the sequential `node tsc` step only. Never hand it
  // to bun test shards — a leftover max-old-space-size races the check
  // cell's memory cgroup and the kernel SIGKILLs the gate (exit 137).
  delete childEnv["NODE_OPTIONS"];
  const child = Bun.spawn(["bun", "test", ...flags, ...paths], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    // Bun keeps shell-inherited vars after `delete process.env.X`; pass a
    // cleaned env so capacityDefault does not see the gate's shard count.
    env: childEnv,
  });
  children.add(child);
  // One buffer, in arrival order: `bun test` splits its report across
  // stdout and stderr.
  const output: string[] = [];
  const through = live
    ? (text: string): void => {
        process.stdout.write(text);
      }
    : undefined;
  await Promise.all([
    drain(child.stdout, output, through),
    drain(child.stderr, output, through),
  ]);
  const code = await child.exited;
  children.delete(child);
  const text = output.join("");
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  process.stdout.write(
    live
      ? `${text.endsWith("\n") || text === "" ? "" : "\n"}── shard ${where} done (exit ${code}, ${seconds}s)\n`
      : `\n── shard ${where} (exit ${code}, ${seconds}s): ${slice.join(" ")}\n${text}${text.endsWith("\n") ? "" : "\n"}`,
  );
  return {
    files: slice,
    code,
    output: text,
    seconds: (performance.now() - started) / 1000,
  };
}

/** Runs every slice, at most `width` at once, in the slices' order.
 * Stops starting new slices after the first non-zero exit and signals
 * in-flight children so a red shard does not burn the rest of the wall. */
async function pool(width: number): Promise<Timed[]> {
  const results: Timed[] = [];
  let next = 0;
  let stop = false;
  async function worker(): Promise<void> {
    while (next < slices.length) {
      if (stop) break;
      const index = next++;
      if (stop) break;
      results[index] = await runShard(slices[index]!, index, width === 1);
      if (results[index]!.code !== 0) {
        stop = true;
        for (const child of children) child.kill("SIGTERM");
      }
    }
  }
  await Promise.all(Array.from({ length: width }, worker));
  // Only slices that ran (parallel fail-fast leaves holes for never-started).
  return results.filter((result): result is Timed => result !== undefined);
}

const started = performance.now();
// Serial one-file processes when SHARDS=1; record keeps its worker width;
// multi-shard still runs every slice side by side.
const results = await pool(
  serialFiles ? 1 : record ? count.value : slices.length,
);
if (results.length < slices.length) {
  const skipped = slices.length - results.length;
  console.log(
    `test-shards: fail-fast — skipped ${skipped} remaining shard${skipped === 1 ? "" : "s"} after a red exit`,
  );
}
const ending = tally(results, (performance.now() - started) / 1000);
const spread = results.map((result) => result.seconds);
console.log(`\n${ending.lines.join("\n")}`);
if (!record && results.length > 1)
  console.log(
    `Slowest shard ${Math.max(...spread).toFixed(1)}s, fastest ${Math.min(...spread).toFixed(1)}s.`,
  );
if (record) {
  if (ending.code !== 0) {
    console.log(
      "test-shards: not recording: a file is red, so its time is not its time",
    );
  } else {
    // Files this run did not name keep their old times: a partial run
    // refreshes what it ran and forgets nothing else.
    const fresh = new Map(times);
    for (const result of results) fresh.set(result.files[0]!, result.seconds);
    writeFileSync(TIMES, formatTimes(fresh));
    console.log(
      `test-shards: wrote ${results.length} times to scripts/test-times.json`,
    );
  }
}
process.exit(ending.code);
