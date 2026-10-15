/**
 * `bun test`, over the named files, in parallel shards.
 *
 *   bun scripts/test-shards.ts [bun test flags…] --gate
 *   bun scripts/test-shards.ts [bun test flags…] --gate --shard 1/3
 *   bun scripts/test-shards.ts [bun test flags…] test/a.test.ts test/b.test.ts …
 *   bun scripts/test-shards.ts [bun test flags…] --tier fast --diff <base>..<head>
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
 * that run one after another (`FORGE_CHECK_SHARDS=1`, or `--record` with
 * one worker) write each line the moment the test says it, so a check's
 * log tails live;
 * shards that run side by side are written through whole as each
 * finishes, so the log reads one shard at a time. Either way the tail
 * names every failing test from every shard. The first red shard stops
 * the rest (fail-fast) so a known fail does not burn the remaining wall
 * clock. Exits non-zero if any shard does.
 *
 * The whole gate, unsliced (`--gate` on the full tier, as `check.run`),
 * runs one file per `bun test`, heaviest first into whichever worker is
 * free, so every file is timed alone; when it is green it writes those
 * times to `.forge-cache/test-times.json`, which the forge keeps for the
 * next check (`src/checks/cache.ts`).
 *
 * Files are weighed by how long they took, from `scripts/test-times.json`
 * overlaid by `.forge-cache/test-times.json` (a file neither names, or a
 * table it refuses, falls back to bytes).
 * `--record` refreshes that table: the same number of workers, but each
 * file is its own `bun test`, timed alone from spawn to exit, and the
 * table is rewritten from those times when every file is green.
 */

import { availableParallelism, tmpdir } from "node:os";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  formatTimes,
  heaviestFirst,
  overlayTimes,
  refreshTimes,
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
import { GATE, gateRefusal, presentTests } from "./gate.ts";
import { executedFiles, formatImpact, handedImpact, mergeImpact, parseImpact } from "../src/checks/impact.ts";
import { fastSet, importsOf, duration } from "../src/checks/tiers.ts";
import { CHECK_CACHE } from "../src/checks/cache.ts";

const TIMES = new URL("./test-times.json", import.meta.url).pathname;
// The forge hands the map over in the checkout (`src/checks/impact-store.ts`):
// seeded from the last green default-branch run, kept from this one when
// it is green. By hand, it is scripts/test-impact.json.
const handed = handedImpact(process.env["FORGE_CHECK_IMPACT"]);
const IMPACT = handed ?? new URL("./test-impact.json", import.meta.url).pathname;
const IMPACT_NAME = handed ?? "scripts/test-impact.json";
// What the forge keeps between checks (`src/checks/cache.ts`): the full
// gate's own per-file times, fresher than the committed table.
const CACHED_TIMES = `${CHECK_CACHE}/test-times.json`;

const argv = process.argv.slice(2);
const record = argv.includes("--record");
const gate = argv.includes("--gate");
const measure = argv.includes("--impact");

/**
 * Measured seconds where a table has them, bytes scaled to seconds where
 * it does not: the committed table, overlaid by the times the last green
 * full gate left in the forge's cache. A missing or refused table is said
 * out loud and the gate still runs, on what is left.
 */
function loadTimes(): Map<string, number> {
  const read = (path: string, name: string, quiet: boolean): Map<string, number> => {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      if (!quiet) console.log(`test-shards: no ${name}; weighing by bytes`);
      return new Map();
    }
    const parsed = parseTimes(text);
    if (parsed.ok) return parsed.value;
    console.log(`test-shards: ${name} refused (${parsed.error}); weighing by bytes`);
    return new Map();
  };
  return overlayTimes(
    read(TIMES, "scripts/test-times.json", false),
    read(CACHED_TIMES, CACHED_TIMES, true),
  );
}

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

/** Pull `--name value` / `--name=value` out of argv. */
function takeValue(
  raw: string[],
  name: string,
): { rest: string[]; value: string | undefined; error?: string } {
  const rest: string[] = [];
  let value: string | undefined;
  for (let i = 0; i < raw.length; i++) {
    const arg = raw[i]!;
    let got: string | undefined;
    if (arg === name) {
      got = raw[++i];
      if (got === undefined || got.startsWith("-"))
        return { rest, value, error: `${name} needs a value` };
    } else if (arg.startsWith(`${name}=`)) got = arg.slice(name.length + 1);
    else {
      rest.push(arg);
      continue;
    }
    if (value !== undefined)
      return { rest, value, error: `${name} named twice` };
    value = got;
  }
  return { rest, value };
}

const tierArg = takeValue(
  argv.filter((arg) => arg !== "--record" && arg !== "--gate" && arg !== "--impact"),
  "--tier",
);
const diffArg = takeValue(tierArg.rest, "--diff");
const learnedArg = takeValue(diffArg.rest, "--learned");
for (const error of [tierArg.error, diffArg.error, learnedArg.error])
  if (error) {
    console.error(`test-shards: ${error}`);
    process.exit(2);
  }
if (tierArg.value !== undefined && !["fast", "full"].includes(tierArg.value)) {
  console.error("test-shards: --tier is fast or full");
  process.exit(2);
}
const tier = tierArg.value ?? "full";
// A range is two plain revisions; nothing that git could read as a flag.
const REV = /^[A-Za-z0-9_][A-Za-z0-9_./@^~-]*$/;
const range = diffArg.value?.split("..");
if (
  diffArg.value !== undefined &&
  (range?.length !== 2 || !range.every((rev) => REV.test(rev)))
) {
  console.error("test-shards: --diff is <base>..<head>");
  process.exit(2);
}
if (tier === "fast" && diffArg.value === undefined) {
  console.error("test-shards: --tier fast needs --diff <base>..<head>");
  process.exit(2);
}

const taken = takeShardArg(learnedArg.rest);
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
// A test file in neither GATE nor EXCLUDED costs a whole gate run to find
// out; say so before anything spawns. Explicit files alone are not audited.
if (gate || tier === "fast") {
  const refusal = gateRefusal(presentTests());
  if (refusal.length > 0) {
    for (const line of refusal) console.error(`test-shards: ${line}`);
    process.exit(2);
  }
}
let files = [...(gate || tier === "fast" ? GATE : []), ...split.files];
if (tier === "fast") {
  const diff = Bun.spawnSync(
    ["git", "diff", "--name-only", "--no-renames", diffArg.value!],
    { stderr: "pipe" },
  );
  if (diff.exitCode !== 0) {
    console.error(`test-shards: git diff failed: ${diff.stderr.toString()}`);
    process.exit(2);
  }
  const changed = diff.stdout.toString().split("\n").filter((f) => f !== "");
  const cache = new Map<string, string[]>();
  const imports = (file: string): string[] => {
    let found = cache.get(file);
    if (found === undefined) {
      try {
        found = importsOf(readFileSync(file, "utf8"), file).flatMap((path) =>
          /\.[cm]?[jt]sx?$/.test(path) ? [path] : [path, `${path}.ts`],
        );
      } catch {
        found = [];
      }
      cache.set(file, found);
    }
    return found;
  };
  let impact: Map<string, string[]> | undefined;
  try {
    const parsed = parseImpact(readFileSync(IMPACT, "utf8"));
    if (parsed.ok) impact = parsed.value;
    else console.log(`test-shards: ${IMPACT_NAME} refused (${parsed.error}); guessing by imports`);
  } catch {
    // no map yet: the import guess stands
  }
  const plan = fastSet({
    ...(impact === undefined ? {} : { impact }),
    changed,
    tests: files,
    imports,
    times: loadTimes(),
    learned: (learnedArg.value ?? "").split(",").filter((f) => f !== ""),
  });
  console.log(
    `test-shards: fast tier, ${plan.files.length} of ${files.length} files for ${changed.length} changed, ${plan.line} ` +
      `(expected ${duration(plan.expected)}${plan.overBudget ? ", over the 5m budget" : ""})`,
  );
  for (const file of plan.files)
    console.log(`  ${file}: ${plan.why.get(file)}`);
  files = plan.files;
}

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
const times = loadTimes();
const weight = weigher(files, size, times);
// Recording and measuring run one file per process, so every file is its
// own slice: Bun's coverage is per process, and a shard of many files would
// merge theirs into one (#1794).
// FORGE_CHECK_SHARDS=1 on the isolated Actions runner still OOMed when one
// bun test held the whole gate (#386/#388, exit 137 ~15–17m). Same count
// with one-file-per-process, serial, keeps peak RSS to a single suite.
const serialFiles = !record && count.value === 1;
// The whole gate, unsliced, runs one file per process too, heaviest first
// into whichever worker frees: no shard waits on a slow neighbour it was
// statically paired with, and every file is timed alone, so a green gate
// refreshes the time of every file it ran (#1797).
const timed = !record && !serialFiles && gate && tier === "full" && "none" in shardSpec;
const perFile = record || measure || serialFiles || timed;
const slices =
  perFile
    ? heaviestFirst(files, weight).map((file) => [file])
    : splitFiles(files, count.value, weight);
const work = files.reduce((sum, file) => sum + weight(file), 0);

const banner = record
  ? `test-shards: recording ${files.length} files, ${count.value} at a time`
  : measure && !serialFiles
    ? `test-shards: measuring ${files.length} files under coverage, one bun test each, ${count.value} at a time`
  : serialFiles
    ? `test-shards: ${files.length} files serial (one bun test each; FORGE_CHECK_SHARDS=1), ` +
      `expected ${work.toFixed(0)}s`
    : timed
      ? `test-shards: ${files.length} files, one bun test each, ${count.value} at a time, ` +
        `expected ${(work / count.value).toFixed(0)}s (${work.toFixed(0)}s of work)`
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

const measured = new Map<string, string[]>();
const unmeasured = new Set<string>();

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
  // Measuring: one file per process, its coverage in a directory of its own.
  const covDir =
    measure && slice.length === 1 ? mkdtempSync(join(tmpdir(), "impact-")) : undefined;
  const cover = covDir
    ? ["--coverage", "--coverage-reporter=lcov", `--coverage-dir=${covDir}`]
    : [];
  const child = Bun.spawn(["bun", "test", ...flags, ...cover, ...paths], {
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
  if (covDir) {
    try {
      measured.set(slice[0]!, executedFiles(readFileSync(join(covDir, "lcov.info"), "utf8")));
    } catch {
      unmeasured.add(slice[0]!);
    }
    rmSync(covDir, { recursive: true, force: true });
  }
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
  serialFiles ? 1 : record || measure || timed ? count.value : slices.length,
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
if (!record && !timed && results.length > 1)
  console.log(
    `Slowest shard ${Math.max(...spread).toFixed(1)}s, fastest ${Math.min(...spread).toFixed(1)}s.`,
  );
if (record || timed) {
  if (ending.code !== 0) {
    console.log(
      "test-shards: not recording: a file is red, so its time is not its time",
    );
  } else {
    // Files this run did not name keep their old times: a partial run
    // refreshes what it ran and forgets nothing else. A file gone from
    // the tree is forgotten.
    const fresh = refreshTimes(
      times,
      results.map((result) => ({ file: result.files[0]!, seconds: result.seconds })),
      (file) => existsSync(file),
    );
    // `--record` rewrites the committed table; the check's full gate
    // writes the cache the forge keeps for the next check.
    const target = record ? TIMES : CACHED_TIMES;
    if (!record) mkdirSync(CHECK_CACHE, { recursive: true });
    writeFileSync(target, formatTimes(fresh));
    console.log(
      `test-shards: wrote ${results.length} times to ${record ? "scripts/test-times.json" : CACHED_TIMES}`,
    );
  }
}
if (measure) {
  if (ending.code !== 0 || unmeasured.size > 0) {
    console.log(`test-shards: not writing ${IMPACT_NAME}: the run was not green and measured`);
  } else {
    // A partial run refreshes what it ran and forgets nothing else.
    let old = new Map<string, string[]>();
    try {
      const parsed = parseImpact(readFileSync(IMPACT, "utf8"));
      if (parsed.ok) old = parsed.value;
      else console.log(`test-shards: ${IMPACT_NAME} refused (${parsed.error}); writing a fresh map`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        console.log(`test-shards: ${IMPACT_NAME} unreadable (${String(error)}); writing a fresh map`);
    }
    writeFileSync(IMPACT, formatImpact(mergeImpact(old, measured, GATE)));
    console.log(`test-shards: wrote ${measured.size} test impacts to ${IMPACT_NAME}`);
  }
}
process.exit(ending.code);
