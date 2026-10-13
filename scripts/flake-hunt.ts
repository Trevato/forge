/**
 * Flake hunting, quarantine and admission, by machine.
 *
 *   bun scripts/flake-hunt.ts hunt [--runs 5] [--shard N/M] [--file-issues]
 *       Every gate file (or the Nth of M slices) HUNT_RUNS times: each run
 *       a fresh seed, the files in that seed's order, each file its own
 *       `bun test --randomize --seed=…` beside busy loops, nothing stopped
 *       early. A file red in some runs and green in others is flaky; with
 *       `--file-issues` each gets an issue carrying the failure text, the
 *       seed and the run (FORGE_API, FORGE_REPO, FORGE_TOKEN; FORGE_RUN_URL
 *       names the run). Exits 1 when it found one.
 *   bun scripts/flake-hunt.ts quarantine
 *       Moves every file an open `Flaky: test/….test.ts` issue names from
 *       GATE to EXCLUDED under that issue, in scripts/gate.ts. The issue is
 *       the record; this is the only hand that edits the list for a flake.
 *   bun scripts/flake-hunt.ts admit test/x.test.ts [--runs 10]
 *       The file ADMISSION_RUNS times the same way; prints the record the
 *       admitting pull carries. Exits non-zero unless every run is green.
 */

import { availableParallelism } from "node:os";
import { readFileSync, writeFileSync } from "node:fs";
import {
  admissionRecord,
  admitted,
  ADMISSION_RUNS,
  findBroken,
  findFlakes,
  flakyFile,
  HUNT_RUNS,
  issueFor,
  quarantine,
  readRun,
  shuffled,
  type FileRun,
} from "./flake.ts";
import { GATE } from "./gate.ts";
import { parseShardSpec, sliceFiles } from "./shards.ts";

const GATE_FILE = new URL("./gate.ts", import.meta.url).pathname;
const [mode, ...rest] = process.argv.slice(2);

function fail(message: string): never {
  console.error(`flake-hunt: ${message}`);
  process.exit(2);
}

function valueOf(flag: string): string | undefined {
  const at = rest.indexOf(flag);
  if (at === -1) return undefined;
  const value = rest[at + 1];
  if (value === undefined || value.startsWith("-"))
    fail(`${flag} needs a value`);
  return value;
}

function runsOf(fallback: number): number {
  const raw = valueOf("--runs");
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 100)
    fail("--runs is a whole number from 1 to 100");
  return n;
}

const freshSeed = (): number => crypto.getRandomValues(new Uint32Array(1))[0]!;

/** One file, one seed, one `bun test`: the gate's own unit. */
async function runFile(file: string, seed: number): Promise<FileRun> {
  const env = { ...process.env };
  // The gate hands its children none of these (scripts/test-shards.ts).
  for (const name of [
    "FORGE_CHECK_SHARDS",
    "FORGE_CHECK_SHARD_INDEX",
    "FORGE_CHECK_SHARD_TOTAL",
    "NODE_OPTIONS",
    "FORGE_TOKEN",
  ])
    delete env[name];
  const child = Bun.spawn(
    [
      "bun",
      "test",
      "--timeout",
      "60000",
      "--randomize",
      `--seed=${seed}`,
      `./${file}`,
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe", env },
  );
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return readRun(file, seed, code, `${out}\n${err}`);
}

/** Busy loops, one per two cores, for as long as `work` runs: a loaded box. */
async function underLoad<T>(work: () => Promise<T>): Promise<T> {
  const burners = Array.from(
    { length: Math.max(1, Math.floor(availableParallelism() / 2)) },
    () =>
      Bun.spawn(["bun", "-e", "for(;;){}"], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      }),
  );
  try {
    return await work();
  } finally {
    for (const burner of burners) burner.kill();
  }
}

function forgeApi(): { api: string; repo: string; token: string } {
  const api = process.env["FORGE_API"];
  const repo = process.env["FORGE_REPO"];
  const token = process.env["FORGE_TOKEN"];
  if (!api || !repo || !token)
    fail("needs FORGE_API, FORGE_REPO and FORGE_TOKEN");
  if (!/^https?:\/\/[^\s]+$/.test(api)) fail("FORGE_API is an http(s) URL");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) fail("FORGE_REPO is owner/name");
  return { api: api.replace(/\/+$/, ""), repo, token };
}

/** Open issues whose title names a flaky file: file → issue number. */
async function openFlakyIssues(): Promise<Map<string, number>> {
  const { api, repo, token } = forgeApi();
  const found = new Map<string, number>();
  let cursor: string | number | null = "";
  for (let page = 0; page < 100 && cursor !== null; page++) {
    const query = cursor === "" ? "" : `&cursor=${encodeURIComponent(cursor)}`;
    const res = await fetch(
      `${api}/repos/${repo}/issues?state=open&limit=100${query}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    if (!res.ok) fail(`listing issues: ${res.status}`);
    const body = (await res.json()) as {
      items?: { number?: unknown; title?: unknown }[];
      next_cursor?: string | number | null;
    };
    for (const issue of body.items ?? []) {
      const file =
        typeof issue.title === "string" ? flakyFile(issue.title) : undefined;
      if (file !== undefined && Number.isInteger(issue.number))
        found.set(file, issue.number as number);
    }
    cursor = body.next_cursor ?? null;
  }
  return found;
}

async function hunt(): Promise<number> {
  const runs = runsOf(HUNT_RUNS);
  const spec = parseShardSpec(valueOf("--shard"));
  if (!spec.ok) fail(spec.error);
  let files = [...GATE];
  if (!("none" in spec)) {
    const sliced = sliceFiles(files, spec.index, spec.total);
    if (!sliced.ok) fail(sliced.error);
    files = sliced.files;
  }
  const fileIssues = rest.includes("--file-issues");
  // Checked before an hour of runs, not after.
  const known = fileIssues ? await openFlakyIssues() : new Map();
  const results: FileRun[] = [];
  await underLoad(async () => {
    for (let i = 0; i < runs; i++) {
      const seed = freshSeed();
      console.log(`hunt run ${i + 1}/${runs}: seed ${seed}, ${files.length} files`);
      for (const file of shuffled(files, seed)) {
        const run = await runFile(file, seed);
        if (!run.green) console.log(`  red: ${file} (seed ${seed})`);
        results.push(run);
      }
    }
  });
  for (const file of findBroken(results))
    console.log(`red in every run (broken, not flaky): ${file}`);
  const flakes = findFlakes(results);
  if (flakes.length === 0) {
    console.log(`no flaky file in ${runs} runs of ${files.length} files`);
    return 0;
  }
  for (const flake of flakes) {
    console.log(
      `FLAKY ${flake.file}: red ${flake.red}, green ${flake.green}; first red seed ${flake.seed}`,
    );
    if (!fileIssues) continue;
    const already = known.get(flake.file);
    if (already !== undefined) {
      console.log(`  already open as #${already}`);
      continue;
    }
    const { api, repo, token } = forgeApi();
    const res = await fetch(`${api}/repos/${repo}/issues`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(
        issueFor(flake, process.env["FORGE_RUN_URL"] ?? ""),
      ),
    });
    const made = (await res.json().catch(() => ({}))) as { number?: unknown };
    if (!res.ok || !Number.isInteger(made.number))
      fail(`filing the issue for ${flake.file}: ${res.status}`);
    console.log(`  filed #${made.number}`);
  }
  return 1;
}

async function quarantineAll(): Promise<number> {
  let source = readFileSync(GATE_FILE, "utf8");
  const moved: string[] = [];
  for (const [file, issue] of await openFlakyIssues()) {
    const next = quarantine(source, file, issue);
    if (next === source) continue;
    source = next;
    moved.push(`${file} (#${issue})`);
  }
  if (moved.length === 0) {
    console.log("nothing to quarantine");
    return 0;
  }
  writeFileSync(GATE_FILE, source);
  for (const line of moved) console.log(`quarantined ${line}`);
  return 0;
}

async function admit(): Promise<number> {
  const file = rest.find((arg) => /^test\/[\w./-]+\.test\.ts$/.test(arg));
  if (file === undefined || file.includes(".."))
    fail("admit needs a file: bun scripts/flake-hunt.ts admit test/x.test.ts");
  const runs = runsOf(ADMISSION_RUNS);
  const results = await underLoad(async () => {
    const out: FileRun[] = [];
    for (let i = 0; i < runs; i++) out.push(await runFile(file, freshSeed()));
    return out;
  });
  console.log(admissionRecord(file, results));
  for (const run of results.filter((r) => !r.green))
    console.log(`\nseed ${run.seed}:\n${run.text}`);
  return admitted(results) ? 0 : 1;
}

if (mode === "hunt") process.exit(await hunt());
else if (mode === "quarantine") process.exit(await quarantineAll());
else if (mode === "admit") process.exit(await admit());
else
  fail(
    "usage: flake-hunt.ts hunt [--runs N] [--shard N/M] [--file-issues] | quarantine | admit test/x.test.ts [--runs N]",
  );
