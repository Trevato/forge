/**
 * `bun test`, over the named files, in parallel shards.
 *
 *   bun scripts/test-shards.ts [bun test flags…] test/a.test.ts test/b.test.ts …
 *
 * The files come from the command line, so `forge.json`'s `check.run`
 * stays the one place that names them. Each shard is its own `bun test`
 * over a disjoint slice (`scripts/shards.ts` decides the slices); a
 * shard's output is written through whole when it finishes, so the log
 * reads one shard at a time, and the tail names every failing test from
 * every shard. Exits non-zero if any shard does.
 */

import { availableParallelism } from "node:os";
import { statSync } from "node:fs";
import { shardCount, splitFiles, tally, type ShardResult } from "./shards.ts";

const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;

const args = process.argv.slice(2);
const files = args.filter((arg) => TEST_FILE.test(arg));
const flags = args.filter((arg) => !TEST_FILE.test(arg));

if (files.length === 0) {
  console.error("test-shards: name the test files to run");
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
// Bytes stand in for how long a file takes: no timings are kept between runs.
const slices = splitFiles(files, count.value, (file) => size.get(file) ?? 0);

console.log(
  `test-shards: ${files.length} files in ${slices.length} shard${slices.length === 1 ? "" : "s"}`,
);

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

async function runShard(slice: string[], index: number): Promise<ShardResult> {
  const started = performance.now();
  // An exact path, never a filter: `test/web.test.ts` alone would also
  // match any file whose path contains it, in some other shard.
  const paths = slice.map((file) =>
    file.startsWith("/") || file.startsWith("./") ? file : `./${file}`,
  );
  const child = Bun.spawn(["bun", "test", ...flags, ...paths], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
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
  return { files: slice, code, output: text };
}

const started = performance.now();
const results = await Promise.all(slices.map(runShard));
const ending = tally(results, (performance.now() - started) / 1000);
console.log(`\n${ending.lines.join("\n")}`);
process.exit(ending.code);
