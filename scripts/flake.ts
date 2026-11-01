/**
 * What a flake is, and what is done about one — plain data in, plain data out.
 *
 * A test file that is red in one run and green in another, over the same
 * code, is flaky. `scripts/flake-hunt.ts` runs each gate file several times
 * in random order and hands every run here; this module names the flaky
 * files, writes the issue that carries the evidence, and adds a file to
 * `EXCLUDED` in `scripts/gate.ts` — so nobody hand-edits a quarantine.
 *
 * The unit is the file, judged by `bun test`'s exit code: that is what the
 * gate judges, what quarantine moves, and the only verdict a crash between
 * tests still leaves. Out of a terminal `bun test` prints only its `(fail)`
 * lines, so the failing names and the text above them ride along for the
 * issue, never as the verdict.
 */

/** Green runs, in random order under load, for a file to join the gate. */
export const ADMISSION_RUNS = 10;
/** Runs of every gate file in the nightly hunt, each with a fresh seed. */
export const HUNT_RUNS = 5;
/** The title prefix of the issue the hunt files; quarantine reads it back. */
export const FLAKY_TITLE = "Flaky: ";

/** The title prefix of the issue the scheduled run files for a red file. */
export const RED_TITLE = "Red: ";

/**
 * The least a test may bound a request or a spawn by, in wall-clock ms. A
 * loopback fetch on a loaded shared runner takes tens of milliseconds; a
 * bound below this goes red on load, not on the regression it guards.
 */
export const WALL_CLOCK_FLOOR_MS = 200;

/** The causes a flake has; the fix is the shape, never a retry. */
export const ROOT_CAUSES: readonly { name: string; fix: string }[] = [
  {
    name: "a shared port",
    fix: "listen on port 0 and read the port back; never a number two files can both want",
  },
  {
    name: "a real clock",
    fix: "inject the clock the code already takes; never sleep until something is due",
  },
  {
    name: "order dependence",
    fix: "each test makes its own state; none reads what an earlier one left",
  },
  {
    name: "a leaked server",
    fix: "close every server, socket and child in afterEach/afterAll, even on failure",
  },
  {
    name: "a timeout set near the real duration",
    fix: "make the work fast, or wait on the event itself; never raise the number to fit a loaded box",
  },
  {
    name: "a tight wall-clock bound",
    fix: `assert a speed relative to a baseline measured in the same run, or bound it at ${WALL_CLOCK_FLOOR_MS} ms or more so only the failure the test names crosses it`,
  },
];

/** One `bun test` of one file. */
export type FileRun = {
  file: string;
  seed: number;
  green: boolean;
  /** `(fail)` names, in the order bun printed them. */
  failing: string[];
  /** What the run said about its failures, bounded. */
  text: string;
};

const FAIL_LINE = /^\(fail\) (.+?)(?: \[[0-9.]+m?s\])?\s*$/;
const TEXT_LIMIT = 3000;

/** A file's run, from `bun test`'s exit code and output. */
export function readRun(
  file: string,
  seed: number,
  code: number,
  output: string,
): FileRun {
  const failing: string[] = [];
  const kept: string[] = [];
  let pending: string[] = [];
  for (const line of output.split("\n")) {
    const fail = FAIL_LINE.exec(line);
    if (fail) {
      failing.push(fail[1]!);
      kept.push(...pending, line);
      pending = [];
      continue;
    }
    pending.push(line);
    if (pending.length > 40) pending.shift();
  }
  const green = code === 0;
  // A red run with no `(fail)` line crashed outside a test: its tail is the text.
  const text = green ? "" : (failing.length > 0 ? kept : pending).join("\n");
  return {
    file,
    seed,
    green,
    failing,
    text: text.trim().slice(-TEXT_LIMIT),
  };
}

export type Flake = {
  file: string;
  green: number;
  red: number;
  /** The first red run: its seed, its failing names and its text. */
  seed: number;
  failing: string[];
  text: string;
};

function byFile(runs: readonly FileRun[]): Map<string, FileRun[]> {
  const files = new Map<string, FileRun[]>();
  for (const run of runs)
    files.set(run.file, [...(files.get(run.file) ?? []), run]);
  return files;
}

/** Files red in some runs and green in others. */
export function findFlakes(runs: readonly FileRun[]): Flake[] {
  const flakes: Flake[] = [];
  for (const [file, list] of byFile(runs)) {
    const red = list.filter((run) => !run.green);
    if (red.length === 0 || red.length === list.length) continue;
    const first = red[0]!;
    flakes.push({
      file,
      green: list.length - red.length,
      red: red.length,
      seed: first.seed,
      failing: first.failing,
      text: first.text,
    });
  }
  return flakes;
}

/** Files red in every run: broken, not flaky — the check already says so. */
export function findBroken(runs: readonly FileRun[]): string[] {
  return [...byFile(runs)]
    .filter(([, list]) => list.every((run) => !run.green))
    .map(([file]) => file)
    .sort();
}

/** The issue the hunt files for one flaky file. */
export function issueFor(
  flake: Flake,
  where: string,
): { title: string; body: string } {
  const fence = "```";
  const runs = flake.green + flake.red;
  return {
    title: `${FLAKY_TITLE}${flake.file}`,
    body: [
      `The flake hunt ran \`${flake.file}\` ${runs} times in random order under load: red ${flake.red}, green ${flake.green}. Quarantine moves it to \`EXCLUDED\` under this issue until it is fixed.`,
      "",
      `- seed: \`${flake.seed}\` — \`bun test --randomize --seed=${flake.seed} ./${flake.file}\``,
      `- run that failed: ${where || "(a local run)"}`,
      `- failing: ${flake.failing.length > 0 ? flake.failing.map((name) => `\`${name}\``).join(", ") : "no test named; the file failed outside one"}`,
      "",
      fence,
      flake.text || "(no failure text captured)",
      fence,
      "",
      "## Name the root cause",
      "",
      "Tick the one that holds and fix the shape. A retry is not a fix: `retry` is refused anywhere in the gate.",
      "",
      ...ROOT_CAUSES.map((cause) => `- [ ] ${cause.name} — ${cause.fix}`),
      "",
      `To rejoin the gate: fix it, run \`bun scripts/flake-hunt.ts admit ${flake.file}\`, and put its ${ADMISSION_RUNS}-run record in the pull that deletes its \`EXCLUDED\` entry.`,
    ].join("\n"),
  };
}

/** The file an open hunt issue names, or undefined for any other title. */
export function flakyFile(title: string): string | undefined {
  if (!title.startsWith(FLAKY_TITLE)) return undefined;
  const file = title.slice(FLAKY_TITLE.length).trim();
  return /^test\/[\w./-]+\.test\.ts$/.test(file) && !file.includes("..")
    ? file
    : undefined;
}

/**
 * The file an issue from the forge's list quarantines, or undefined. Only
 * an issue the hunt filed counts: its author is the hunt's own user and the
 * forge has not marked it `untrusted`. Anyone else's `Flaky:` title takes
 * nothing out of the gate.
 */
export function huntedFile(
  issue: { title?: unknown; authorId?: unknown; untrusted?: unknown },
  huntUserId: string,
): string | undefined {
  if (huntUserId === "" || issue.authorId !== huntUserId) return undefined;
  if (issue.untrusted !== undefined && issue.untrusted !== false)
    return undefined;
  return typeof issue.title === "string" ? flakyFile(issue.title) : undefined;
}

const entryFor = (file: string, reason: string, issue: number): string =>
  [
    "  {",
    `    file: ${JSON.stringify(file)},`,
    `    reason: ${JSON.stringify(reason)},`,
    `    issue: ${issue},`,
    "  },",
    "",
  ].join("\n");

/**
 * `scripts/gate.ts` with `file` excluded under `issue`: one entry at the end
 * of `EXCLUDED`. Unchanged when the file is excluded already.
 */
export function quarantine(
  source: string,
  file: string,
  issue: number,
  reason = "flaky: red in one hunt run and green in another",
): string {
  const start = source.indexOf("export const EXCLUDED");
  const end = source.indexOf("\n];", start);
  if (start === -1 || end === -1) return source;
  if (source.slice(start, end).includes(`file: ${JSON.stringify(file)}`)) return source;
  return source.slice(0, end + 1) + entryFor(file, reason, issue) + source.slice(end + 1);
}

/**
 * `scripts/gate.ts` with every open hunt issue's file quarantined, and the
 * `file (#issue)` lines that moved. A file no longer `present` is skipped:
 * an exclusion for a file that is gone would turn the gate's audit red.
 */
export function quarantineFlaky(
  source: string,
  flaky: Iterable<readonly [string, number]>,
  present: ReadonlySet<string>,
): { source: string; moved: string[] } {
  const moved: string[] = [];
  for (const [file, issue] of flaky) {
    if (!present.has(file)) continue;
    const next = quarantine(source, file, issue);
    if (next === source) continue;
    source = next;
    moved.push(`${file} (#${issue})`);
  }
  return { source, moved };
}

/** A retry anywhere in what the gate runs: the lines that carry one. */
export function retries(name: string, source: string): string[] {
  const found: string[] = [];
  source.split("\n").forEach((line, i) => {
    if (
      /--retry\b/.test(line) ||
      /--rerun-each\b/.test(line) ||
      /^\s*retry\s*=/.test(line) ||
      /\{[^}"'`]*\bretry\s*:\s*\d/.test(line)
    )
      found.push(`${name}:${i + 1}: ${line.trim()}`);
  });
  return found;
}

const TIMED =
  /\b(?:now|elapsed|took|ms|duration|latency|times?|started|began)\b/i;
const UPPER_BOUND =
  /expect\(([^;]*?)\)\s*\.toBeLessThan(?:OrEqual)?\(\s*([\d_]+)\s*\)/g;

/** Every line of `source` that bounds a measured time below the floor. */
export function tightBounds(name: string, source: string): string[] {
  const found: string[] = [];
  source.split("\n").forEach((line, i) => {
    for (const [, measured, bound] of line.matchAll(UPPER_BOUND))
      if (
        TIMED.test(measured!) &&
        Number(bound!.replaceAll("_", "")) < WALL_CLOCK_FLOOR_MS
      )
        found.push(`${name}:${i + 1}: ${line.trim()}`);
  });
  return found;
}

const BUDGET_TITLE = /\b(?:answers?|renders?|runs?|takes?)\s+(?:in\s+)?under\s+[\d_.]+\s*ms\b/i;
const BUDGET_MEASURE =
  /^(?:dur\(|total\b|best\b|left\b|(?:got|res|out|r)\.(?:ms|app))/;

/**
 * Every line of `source` that holds a speed to a raw millisecond number: a
 * title saying "under N ms", or a Server-Timing/elapsed time bounded by a
 * literal under the floor (a hang guard above it stays a plain expect). `test/helpers/budget.ts` is the one way (#4429).
 */
export function rawBudgets(name: string, source: string): string[] {
  const found: string[] = [];
  source.split("\n").forEach((line, i) => {
    let raw = BUDGET_TITLE.test(line);
    for (const [, measured, bound] of line.matchAll(UPPER_BOUND))
      if (
        (TIMED.test(measured!) || BUDGET_MEASURE.test(measured!.trim())) &&
        Number(bound!.replaceAll("_", "")) < WALL_CLOCK_FLOOR_MS
      )
        raw = true;
    if (raw && !/expectBudget/.test(line))
      found.push(`${name}:${i + 1}: ${line.trim()} — bound speed with expectBudget() from test/helpers/budget.ts (#4429)`);
  });
  return found;
}

/** The record an admitting pull carries. */
export function admissionRecord(
  file: string,
  runs: readonly { seed: number; green: boolean }[],
): string {
  const green = runs.filter((run) => run.green).length;
  return [
    `admission: ${file} — ${green}/${runs.length} green, random order, under load`,
    ...runs.map(
      (run, i) =>
        `  run ${i + 1}: seed ${run.seed} ${run.green ? "green" : "RED"}`,
    ),
  ].join("\n");
}

/** Admitted only when every one of the required runs is green. */
export const admitted = (runs: readonly { green: boolean }[]): boolean =>
  runs.length >= ADMISSION_RUNS && runs.every((run) => run.green);

/** `files` in an order fixed by `seed`: the same seed, the same order. */
export function shuffled(files: readonly string[], seed: number): string[] {
  const out = [...files];
  let state = seed >>> 0 || 1;
  const next = (): number => {
    // xorshift32: small, seeded, and enough to vary an order.
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** The first failing test's name as the issue words it. */
export function firstFailing(run: FileRun): string {
  return run.failing[0] !== undefined
    ? `\`${run.failing[0]}\``
    : "none named; the file failed outside a test";
}

/** Files that test the budget helper itself, not a speed: never in the timing run. */
export const TIMING_EXCLUDED: readonly string[] = ["test/budget.test.ts"];

/** How a file says it bounds a wall-clock speed: it imports the budget helper and calls it. */
const BUDGET_IMPORT = /from\s+["']\.\/helpers\/budget\.ts["']/;
const BUDGET_CALL = /\bexpectBudget\(/;

/**
 * The files the nightly timing run holds to their wall-clock budgets (#7789):
 * each present test that imports `test/helpers/budget.ts` and calls
 * `expectBudget`, less {@link TIMING_EXCLUDED}. A file that only mentions the
 * name, in a string or a comment, is not one.
 */
export function timingFiles(
  present: readonly string[],
  read: (file: string) => string,
): string[] {
  return present.filter((file) => {
    if (TIMING_EXCLUDED.includes(file)) return false;
    const text = read(file);
    return BUDGET_IMPORT.test(text) && BUDGET_CALL.test(text);
  });
}

/** Which scheduled run found a file red: the files outside the gate, or the wall-clock budgets. */
export type RedRun = "outside" | "timing";

/** The issue for a file the scheduled run found red. */
export function redIssueFor(
  run: FileRun,
  where: string,
  kind: RedRun = "outside",
): { title: string; body: string } {
  const fence = "```";
  return {
    title: `${RED_TITLE}${run.file}`,
    body: [
      kind === "timing"
        ? `\`${run.file}\` was over a wall-clock budget, or red, in the nightly timing run (one file at a time, absolute budgets). This issue closes itself when the file passes again.`
        : `\`${run.file}\` is outside the gate and was red in the scheduled run. This issue closes itself when the file passes again.`,
      "",
      `- first failing test: ${firstFailing(run)}`,
      `- run: ${where || "(a local run)"}`,
      kind === "timing"
        ? `- reproduce: \`FORGE_TEST_TIMING=1 FORGE_TEST_QUIET=1 bun test --timeout 60000 ./${run.file}\``
        : `- reproduce: \`bun test --timeout 60000 ./${run.file}\``,
      "",
      fence,
      run.text || "(no failure text captured)",
      fence,
    ].join("\n"),
  };
}

/** The file an issue titled `Red: …` names, or undefined. */
export function redFile(title: string): string | undefined {
  if (!title.startsWith(RED_TITLE)) return undefined;
  return flakyFile(`${FLAKY_TITLE}${title.slice(RED_TITLE.length)}`);
}

/** An open `Red:` issue as the scheduled run sees it. */
export type OpenRed = { number: number; body?: string };

export type RedAction =
  | { kind: "open"; run: FileRun }
  | { kind: "update"; run: FileRun; number: number }
  | { kind: "close"; file: string; number: number };

/**
 * What the forge must be told after a scheduled run: a newly red file opens
 * one issue; a file still red whose first failing test is not in its issue
 * updates that issue; a file green again closes it. A file that stays red
 * on the same test says nothing, so the asks show it once.
 */
export function redActions(
  runs: readonly FileRun[],
  open: ReadonlyMap<string, OpenRed>,
): RedAction[] {
  const actions: RedAction[] = [];
  for (const run of runs) {
    const issue = open.get(run.file);
    if (run.green) {
      if (issue)
        actions.push({ kind: "close", file: run.file, number: issue.number });
    } else if (!issue) actions.push({ kind: "open", run });
    else if (
      typeof issue.body === "string" &&
      !issue.body.includes(firstFailing(run))
    )
      actions.push({ kind: "update", run, number: issue.number });
  }
  return actions;
}
