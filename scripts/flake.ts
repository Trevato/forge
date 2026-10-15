/**
 * What a flake is, and what is done about one — plain data in, plain data out.
 *
 * A test file that is red in one run and green in another, over the same
 * code, is flaky. `scripts/flake-hunt.ts` runs each gate file several times
 * in random order and hands every run here; this module names the flaky
 * files, writes the issue that carries the evidence, and moves a file from
 * `GATE` to `EXCLUDED` in `scripts/gate.ts` — so nobody hand-edits the list.
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
      `To rejoin the gate: fix it, run \`bun scripts/flake-hunt.ts admit ${flake.file}\`, and put its ${ADMISSION_RUNS}-run record in the pull that moves the file back to \`GATE\`.`,
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
 * forge has not marked it `untrusted`. Anyone else's `Flaky:` title moves
 * nothing out of GATE.
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

/** `scripts/gate.ts` with `file` moved from GATE to EXCLUDED under `issue`. */
export function quarantine(
  source: string,
  file: string,
  issue: number,
  reason = "flaky: red in one hunt run and green in another",
): string {
  const gateStart = source.indexOf("export const GATE");
  const gateEnd = source.indexOf("\n];", gateStart);
  const line = `  ${JSON.stringify(file)},\n`;
  const at = source.indexOf(line, gateStart);
  if (gateStart === -1 || at === -1 || at > gateEnd) return source;
  const without = source.slice(0, at) + source.slice(at + line.length);
  const end = without.indexOf("\n];", without.indexOf("export const EXCLUDED"));
  return (
    without.slice(0, end + 1) +
    entryFor(file, reason, issue) +
    without.slice(end + 1)
  );
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
