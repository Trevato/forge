/**
 * `bun test`, over the named files, in parallel shards.
 *
 *   bun scripts/test-shards.ts [bun test flags…] --gate
 *   bun scripts/test-shards.ts [bun test flags…] test/a.test.ts test/b.test.ts …
 *   bun scripts/test-shards.ts --record [bun test flags…] test/a.test.ts …
 *   bun scripts/test-shards.ts [bun test flags…] -- a b …   (test/a.test.ts …)
 *
 * `--gate` runs the files `scripts/gate.ts` admits, which is how
 * `forge.json`'s `check.run` names them; files on the command line are for
 * running a slice by hand. Each shard is its own `bun test`
 * over a disjoint slice (`scripts/shards.ts` decides the slices); a
 * shard's output is written through whole when it finishes, so the log
 * reads one shard at a time, and the tail names every failing test from
 * every shard. Exits non-zero if any shard does.
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
  parseTimes,
  shardCount,
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
const args = argv.filter((arg) => arg !== "--record" && arg !== "--gate");
const split = splitArgs(args);
if (!split.ok) {
  console.error(`test-shards: ${split.error}`);
  process.exit(2);
}
const flags = split.flags;
const files = [...(gate ? GATE : []), ...split.files];

if (files.length === 0) {
  console.error("test-shards: name the test files to run, or --gate");
  process.exit(2);
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
): Promise<void> {
  const decoder = new TextDecoder();
  for await (const chunk of stream)
    into.push(decoder.decode(chunk, { stream: true }));
  into.push(decoder.decode());
}

type Timed = ShardResult & { seconds: number };

async function runShard(slice: string[], index: number): Promise<Timed> {
  const started = performance.now();
  // Print before spawn so a mid-suite cgroup SIGKILL still leaves a breadcrumb
  // (shard stdout is buffered until the child exits).
  // stderr: Actions often block-buffers stdout until exit; an OOM never flushes.
  process.stderr.write(
    `test-shards: start ${index + 1}/${slices.length} ${slice.join(" ")}\n`,
  );
  // An exact path, never a filter: `test/web.test.ts` alone would also
  // match any file whose path contains it, in some other shard.
  const paths = slice.map((file) =>
    file.startsWith("/") || file.startsWith("./") ? file : `./${file}`,
  );
  const childEnv = { ...process.env };
  delete childEnv["FORGE_CHECK_SHARDS"];
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
  await Promise.all([drain(child.stdout, output), drain(child.stderr, output)]);
  const code = await child.exited;
  children.delete(child);
  const text = output.join("");
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  process.stdout.write(
    `\n── shard ${index + 1}/${slices.length} (exit ${code}, ${seconds}s): ${slice.join(" ")}\n${text}${text.endsWith("\n") ? "" : "\n"}`,
  );
  return {
    files: slice,
    code,
    output: text,
    seconds: (performance.now() - started) / 1000,
  };
}

/** Runs every slice, at most `width` at once, in the slices' order. */
async function pool(width: number): Promise<Timed[]> {
  const results: Timed[] = [];
  let next = 0;
  async function worker(): Promise<void> {
    while (next < slices.length) {
      const index = next++;
      results[index] = await runShard(slices[index]!, index);
    }
  }
  await Promise.all(Array.from({ length: width }, worker));
  return results;
}

const started = performance.now();
// Serial one-file processes when SHARDS=1; record keeps its worker width;
// multi-shard still runs every slice side by side.
const results = await pool(
  serialFiles ? 1 : record ? count.value : slices.length,
);
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
