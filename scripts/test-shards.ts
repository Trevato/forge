/**
 * `bun test`, over the named files, in parallel shards.
 *
 *   bun scripts/test-shards.ts [bun test flags…] --gate
 *   bun scripts/test-shards.ts [bun test flags…] --gate --shard 1/3
 *   bun scripts/test-shards.ts [bun test flags…] test/a.test.ts test/b.test.ts …
 *   bun scripts/test-shards.ts [bun test flags…] --tier fast --diff <base>..<head>
 *   bun scripts/test-shards.ts --record [bun test flags…] test/a.test.ts …
 *   bun scripts/test-shards.ts [bun test flags…] -- a b …   (test/a.test.ts …)
 *   bun scripts/test-shards.ts [bun test flags…] --gate --impact --keep-going --nice
 *
 * `--gate` runs the files `scripts/gate.ts` admits (every test file not
 * excluded), which is how
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
 * names every failing test from every shard: every shard runs to the end,
 * whatever goes red, so one red never hides another (#7788). A shard that
 * crashed outside any test (an unhandled error between tests, a file that
 * would not load, a process that died before its summary) is re-run once,
 * whole, and judged by that run; the log keeps the crashed run quoted
 * behind `  │ `. At most `CRASH_RERUNS` shards are re-run so. Exits
 * non-zero if any shard does.
 *
 * `--keep-going` is the verification after landing (#7786): no shard stops
 * the rest, a file red on its own is run once more alone (green then, it
 * is named flaky and does not fail the run), and a measuring run writes
 * the impact of every file that ended green even when another is red.
 * `--nice` runs it all at the lowest CPU priority, so the checks a landing
 * waits on go first. `FORGE_CHECK_ONLY` (comma-separated test files, set
 * by the forge for a bisection step) keeps only those files.
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

import { availableParallelism, setPriority, tmpdir, totalmem } from "node:os";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveLimits } from "../src/apps/contain.ts";
import {
  formatTimes,
  heaviestFirst,
  MEASURE_WORKER_MEMORY_BYTES,
  memoryLimit,
  overlayTimes,
  refreshTimes,
  parseShardSpec,
  parseTimes,
  SHARDS_MAX,
  WORKER_MEMORY_BYTES,
  shardCountFromEnv,
  sliceFiles,
  splitArgs,
  splitCapped,
  tally,
  weigher,
  besideOthers,
  failingFiles,
  onlyTestFailures,
  crashedOutside,
  quoteCrash,
  CRASH_RERUNS,
  type ShardResult,
} from "./shards.ts";
import { gateFiles, gateRefusal, presentTests } from "./gate.ts";
import { cgroupMemory, summaryLines } from "./gate-summary.ts";
import { GATE_FILE, executedFiles, formatImpact, gateListAdds, handedImpact, mergeImpact, parseImpact } from "../src/checks/impact.ts";
import { importsReader, readImpact } from "./tier-input.ts";
import { shardHome, spaceLine } from "../src/checks/disk_full.ts";
import { fastSet, duration } from "../src/checks/tiers.ts";
import { CHECK_CACHE } from "../src/checks/cache.ts";
import { parseCheck } from "../src/apps/manifest.ts";
import { FLAKY_ALONE, onlyFiles } from "../src/checks/verify.ts";
import { crashFlakeLine } from "../src/checks/flake.ts";

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
const keepGoing = argv.includes("--keep-going");
const nice = argv.includes("--nice");
// Every `bun test` this spawns inherits it.
if (nice)
  try {
    setPriority(19);
  } catch (error) {
    console.log(`test-shards: --nice refused (${String(error)}); running at normal priority`);
  }

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
  argv.filter((arg) => !["--record", "--gate", "--impact", "--keep-going", "--nice"].includes(arg)),
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
// A stale exclusion costs a whole gate run to find out; say so before
// anything spawns. Explicit files alone are not audited.
if (gate || tier === "fast") {
  const refusal = gateRefusal(presentTests());
  if (refusal.length > 0) {
    for (const line of refusal) console.error(`test-shards: ${line}`);
    process.exit(2);
  }
}
const GATE = gateFiles();
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
  let gateAdds: string[] | undefined;
  if (changed.includes(GATE_FILE)) {
    const gateDiff = Bun.spawnSync(
      ["git", "diff", "-U0", "--no-renames", diffArg.value!, "--", GATE_FILE],
      { stderr: "pipe" },
    );
    if (gateDiff.exitCode === 0) gateAdds = gateListAdds(gateDiff.stdout.toString());
  }
  const imports = importsReader();
  const impact = readImpact(IMPACT, IMPACT_NAME, (line) => console.log(`test-shards: ${line}`));
  const plan = fastSet({
    ...(impact === undefined ? {} : { impact }),
    changed,
    ...(gateAdds === undefined ? {} : { gateAdds }),
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
  // A diff no test reaches (a timing table, a doc) is judged by the
  // type check alone: green, not a usage error.
  if (plan.files.length === 0) {
    console.log("test-shards: the change reaches no tests; nothing to run");
    process.exit(0);
  }
  files = plan.files;
}

const only = onlyFiles(process.env["FORGE_CHECK_ONLY"]);
if (only !== undefined) {
  const named = new Set(only);
  files = files.filter((file) => named.has(file) || named.has(file.replace(/^\.\//, "")));
  console.log(`test-shards: FORGE_CHECK_ONLY keeps ${files.length} of ${only.length} named file(s)`);
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

const readLimit = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};
// The cell's memory as forge.json declares it: its watchdog stops the
// check over it, and nothing in /proc or /sys says it. The machine grants
// no more than its maximum (resolveLimits), so a declared 8 GiB on a 4 GiB
// machine is 4 GiB: sizing shards by the declaration overran the cap (#3105).
// Its CPUs come from FORGE_CELL_CPUS (shardCountFromEnv).
const cell = parseCheck(readLimit(new URL("../forge.json", import.meta.url).pathname), undefined);
const declared = cell.ok ? cell.value?.limits : undefined;
const cpus = availableParallelism();
const shardsOverride = process.env["FORGE_CHECK_SHARDS"];
const memory = memoryLimit(totalmem(), [
  readLimit("/sys/fs/cgroup/memory.max"),
  readLimit("/sys/fs/cgroup/memory/memory.limit_in_bytes"),
  declared?.memoryMiB === undefined
    ? undefined
    : String(resolveLimits("step", declared).memoryMiB * 1024 * 1024),
]);
// A measuring run's workers are under coverage and need more room each (#3118).
const count = shardCountFromEnv(
  process.env,
  cpus,
  files.length,
  memory,
  measure ? MEASURE_WORKER_MEMORY_BYTES : undefined,
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
const slicesOf = (list: string[]): string[][] =>
  list.length === 0
    ? []
    : perFile
      ? heaviestFirst(list, weight).map((file) => [file])
      : splitCapped(list, count.value, weight);
const slices = slicesOf(files);
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

// Failing files a red shard re-runs alone.
const RETRY_CAP = 3;
// Shards re-run after a crash outside any test, so far.
let crashReruns = 0;
/** What a live first run shows once it has gone red: held until its end. */
const RED_SIGN = /^(\(fail\)|# Unhandled error|error:)/m;

type Timed = ShardResult & { seconds: number };

/**
 * One shard. `live` (shards running one at a time) writes the shard's
 * output as it arrives, between a header and a footer line; otherwise the
 * output is held and written through whole when the shard ends, so shards
 * running side by side never interleave.
 */
async function runShard(slice: string[], index: number, live: boolean): Promise<Timed> {
  // Its own temp and data directories: shards side by side never share a
  // path. They sit on the cell's disk (FORGE_CHECK_SCRATCH, else a
  // FORGE_APP_DATA, which is nested under, never replaced), not in its
  // 256 MiB /tmp; the system temp directory when neither is set. Removed
  // however the shard ends.
  const home = shardHome(process.env, tmpdir());
  try {
    return await runShardIn(slice, index, live, home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

async function runShardIn(
  slice: string[],
  index: number,
  live: boolean,
  home: string,
): Promise<Timed> {
  let started = performance.now();
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
  childEnv["TMPDIR"] = join(home, "tmp");
  childEnv["FORGE_APP_DATA"] = join(process.env["FORGE_APP_DATA"] ?? home, `data-${index}`);
  mkdirSync(childEnv["TMPDIR"], { recursive: true });
  mkdirSync(childEnv["FORGE_APP_DATA"], { recursive: true });
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
  const run = async (
    targets: string[],
    extra: string[],
    through?: (text: string) => void,
  ): Promise<{ code: number; output: string[] }> => {
    const child = Bun.spawn(["bun", "test", ...flags, ...extra, ...targets], {
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
    await Promise.all([
      drain(child.stdout, output, through),
      drain(child.stderr, output, through),
    ]);
    const code = await child.exited;
    children.delete(child);
    return { code, output };
  };
  const through = live
    ? (text: string): void => {
        process.stdout.write(text);
      }
    : undefined;
  // Live, the first run streams until the first sign of a red, then is held
  // to its end: if it crashed it is quoted behind `  │` like a parallel
  // shard's, never left bare, so nothing reading the log counts its
  // `(fail)` lines beside the re-run. A clean run streams in full.
  const mayRerun = crashReruns < CRASH_RERUNS;
  const held: string[] = [];
  const firstThrough =
    through && mayRerun
      ? (text: string): void => {
          if (held.length > 0 || RED_SIGN.test(text)) held.push(text);
          else through(text);
        }
      : through;
  let first = await run(paths, cover, firstThrough);
  // A crash outside any test re-runs the shard once, whole (#7788): the
  // leaked-timer class ("Cannot use a closed database" between tests) is
  // not this shard's tests failing. The re-run is the verdict, and its
  // time the shard's time.
  let quoted = "";
  const crashed = crashReruns < CRASH_RERUNS && crashedOutside({ code: first.code, output: first.output.join("") });
  if (!crashed && held.length > 0) through?.(held.join(""));
  if (crashed) {
    crashReruns++;
    quoted = quoteCrash(where, first.code, first.output.join(""));
    if (live) process.stdout.write(quoted);
    process.stderr.write(`test-shards: re-run ${where} after a crash (exit ${first.code})\n`);
    started = performance.now();
    first = await run(paths, cover, through);
    // Green the second time: the crash is a flake, named for the check to record.
    if (first.code === 0) process.stderr.write(`${crashFlakeLine(where, quoted)}\n`);
  }
  let code = first.code;
  let output = quoted === "" ? first.output : [quoted, ...first.output];
  // Kept going, a file red on its own is run once more alone: green then,
  // it was a flake, and its first output (the `(fail)` lines) is set aside.
  if (code !== 0 && keepGoing && slice.length === 1) {
    // The red run's coverage is not the green one's.
    if (covDir) {
      rmSync(covDir, { recursive: true, force: true });
      mkdirSync(covDir);
    }
    const again = await run(paths, cover, through);
    if (again.code === 0) {
      code = 0;
      output = [...again.output, `test-shards: ${FLAKY_ALONE} ${slice[0]}\n`];
      through?.(output.at(-1)!);
    } else output = again.output;
  }
  // A sliced shard that went red: each failing file (the first few) is run
  // once alone, same env and flags. One that passes alone was red only
  // beside others, and does not fail the check; the log names it.
  if (code !== 0 && slice.length > 1 && !covDir) {
    const report = first.output.join("");
    // A file that errored (not a failed test) keeps the whole shard red.
    const red = onlyTestFailures(report) ? failingFiles(report) : [];
    const alone = new Map<string, boolean>();
    for (const file of red.slice(0, RETRY_CAP)) {
      const again = await run([file.startsWith("/") || file.startsWith("./") ? file : `./${file}`], []);
      alone.set(file, again.code === 0);
    }
    const verdict = besideOthers(red, alone, RETRY_CAP);
    if (verdict.line !== null) {
      const note = `${output.join("").endsWith("\n") ? "" : "\n"}test-shards: ${verdict.line}\n`;
      output.push(note);
      through?.(note);
      if (verdict.red.length === 0) code = 0;
    }
  }
  // Where the room went, named on the log of a red shard, before its
  // directories are removed: the next red says its own cause (#8679).
  if (code !== 0) {
    const note = `${spaceLine({ scratch: home, tmp: tmpdir() })}\n`;
    output.push(note);
    through?.(note);
  }
  if (process.env["FORGE_APP_DATA"])
    rmSync(childEnv["FORGE_APP_DATA"], { recursive: true, force: true });
  const text = output.join("");
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  process.stdout.write(
    live
      ? `${text.endsWith("\n") || text === "" ? "" : "\n"}── shard ${where} done (exit ${code}, ${seconds}s)\n`
      : `\n── shard ${where} (exit ${code}, ${seconds}s): ${slice.join(" ")}\n${text}${text.endsWith("\n") ? "" : "\n"}`,
  );
  if (covDir && keepGoing && code !== 0) {
    // A red file's coverage is not its impact; the map keeps its old row.
    rmSync(covDir, { recursive: true, force: true });
  } else if (covDir) {
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

/** Runs slices `from` up to `to`, at most `width` at once, in the slices' order. */
async function pool(width: number, from: number, to: number): Promise<Timed[]> {
  const results: Timed[] = [];
  let next = from;
  async function worker(): Promise<void> {
    while (next < to) {
      const index = next++;
      results[index - from] = await runShard(slices[index]!, index, width === 1);
    }
  }
  await Promise.all(Array.from({ length: width }, worker));
  return results;
}

const started = performance.now();
// Serial one-file processes when SHARDS=1; record keeps its worker width;
// multi-shard still runs every slice side by side.
const results = [
  ...(await pool(
    // Never more side by side than the count: capped slices outnumber it.
    serialFiles ? 1 : Math.max(1, Math.min(count.value, slices.length)),
    0,
    slices.length,
  )),
  // Budget files, one at a time, once the rest are done and green.
  ...(await pool(1, slices.length, slices.length)),
];
const wall = (performance.now() - started) / 1000;
const ending = tally(results, wall);
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
  if ((ending.code !== 0 && !keepGoing) || unmeasured.size > 0 || measured.size === 0) {
    console.log(
      `test-shards: not writing ${IMPACT_NAME}: the run was not green and measured` +
        (unmeasured.size > 0 ? ` (no coverage from ${[...unmeasured].join(", ")})` : ""),
    );
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
// The timed full gate is the check on the cell itself: its log ends with
// what the cell did, so nobody has to measure it by hand (#2065).
if (timed)
  console.log(
    `\n${summaryLines({
      shards: count.value,
      cpus,
      shardsMax: SHARDS_MAX,
      files: files.length,
      override: shardsOverride,
      memoryBytes: memory,
      workerBytes: WORKER_MEMORY_BYTES,
      memory: cgroupMemory(readLimit),
      wallSeconds: wall,
      times: results.map((result) => ({ file: result.files[0]!, seconds: result.seconds })),
    }).join("\n")}`,
  );
process.exit(ending.code);
