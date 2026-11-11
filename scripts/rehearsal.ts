/**
 * The roll rehearsal's plain parts (#873): what it was asked, who is in
 * rotation, what every request came back as, and the verdict. Plain data in,
 * plain data out; `scripts/rehearse-roll.ts` starts the processes and sends
 * the requests.
 *
 * The rehearsal is the chart's roll on a copy: the old forge serves, the new
 * one starts beside it on the same data directory, the new one enters
 * rotation once its `/readyz` says 200, the old one is sent SIGTERM, and
 * the old one leaves rotation when a probe sees it draining or gone, never
 * sooner. Requests run the whole time. A refusal is anything a person
 * would see as the forge being down: a 5xx or a connection that never
 * answered.
 */

export interface RehearsalArgs {
  /** A data directory to copy, or null for a fresh, empty forge. */
  readonly from: string | null;
  /** The forge checkout that serves first (the release rolled from). */
  readonly old: string;
  /** The forge checkout rolled to. */
  readonly next: string;
  /** How long requests run, from the old forge ready to the end. */
  readonly seconds: number;
  /** How often rotation asks each forge's `/readyz` (the chart: 5 s). */
  readonly probeMs: number;
  /** The old forge's FORGE_DRAIN_LINGER_S. */
  readonly lingerS: number;
  /** Requests in flight at once. */
  readonly concurrency: number;
  /** The paths asked, in turn. */
  readonly paths: readonly string[];
  readonly json: boolean;
}

export const DEFAULTS = {
  seconds: 60,
  probeMs: 5000,
  lingerS: 10,
  concurrency: 4,
  paths: ["/", "/healthz", "/explore"],
} as const;

const VALUED = [
  "--from",
  "--old",
  "--new",
  "--seconds",
  "--probe-ms",
  "--linger",
  "--concurrency",
  "--paths",
] as const;

function whole(flag: string, text: string, min: number, max: number): number {
  if (!/^\d{1,7}$/.test(text)) throw new Error(`${flag} wants a whole number`);
  const n = Number(text);
  if (n < min || n > max) throw new Error(`${flag} is ${min} to ${max}`);
  return n;
}

/** The command line, checked; a throw says which argument is wrong. */
export function parseArgs(argv: readonly string[], here: string): RehearsalArgs {
  const one: Record<string, string> = {};
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i] ?? "";
    if (flag === "--json") {
      json = true;
      continue;
    }
    if (!(VALUED as readonly string[]).includes(flag))
      throw new Error(`unknown argument ${JSON.stringify(flag).slice(0, 40)}`);
    const value = argv[++i];
    if (value === undefined) throw new Error(`${flag} wants a value`);
    if (one[flag] !== undefined) throw new Error(`${flag} given twice`);
    one[flag] = value;
  }
  const paths =
    one["--paths"] === undefined
      ? [...DEFAULTS.paths]
      : one["--paths"].split(",").map((p) => p.trim());
  for (const p of paths)
    if (!/^\/[A-Za-z0-9._~\/-]*$/.test(p))
      throw new Error(`--paths: ${JSON.stringify(p).slice(0, 40)} is not a plain path`);
  const num = (flag: string, fallback: number, min: number, max: number) =>
    one[flag] === undefined ? fallback : whole(flag, one[flag], min, max);
  return {
    from: one["--from"] ?? null,
    old: one["--old"] ?? here,
    next: one["--new"] ?? here,
    seconds: num("--seconds", DEFAULTS.seconds, 2, 3600),
    probeMs: num("--probe-ms", DEFAULTS.probeMs, 50, 60_000),
    lingerS: num("--linger", DEFAULTS.lingerS, 0, 120),
    concurrency: num("--concurrency", DEFAULTS.concurrency, 1, 64),
    paths,
    json,
  };
}

/**
 * What one readiness probe heard: a 200, a not-ready answer (a 503 or a
 * refused connection — nothing there to take work), or silence past the
 * probe's timeout, which says only that the machine is busy.
 */
export type ProbeAnswer = "ready" | "not-ready" | "silent";

/**
 * Silent probes in a row before a member leaves: the chart's readiness
 * probe keeps Kubernetes' default failureThreshold, 3. One slow probe on
 * a loaded machine is not a forge going away.
 */
export const SILENT_PROBES_TO_LEAVE = 3;

/**
 * Who takes requests, as a Service's endpoints do: a forge joins when a
 * probe sees it ready and leaves when a probe hears it is not, or hears
 * nothing {@link SILENT_PROBES_TO_LEAVE} times in a row — never between
 * probes. Requests go round the members in turn.
 */
export class Rotation<T> {
  private members: T[] = [];
  private silent = new Map<T, number>();
  private turn = 0;

  /** What one probe of `member` heard; `true` and `false` are ready and not. */
  saw(member: T, answer: ProbeAnswer | boolean): void {
    const heard = answer === true ? "ready" : answer === false ? "not-ready" : answer;
    const at = this.members.indexOf(member);
    const quiet = heard === "silent" ? (this.silent.get(member) ?? 0) + 1 : 0;
    this.silent.set(member, quiet);
    const leaves = heard === "not-ready" || quiet >= SILENT_PROBES_TO_LEAVE;
    if (heard === "ready" && at < 0) this.members.push(member);
    if (leaves && at >= 0) this.members.splice(at, 1);
  }

  has(member: T): boolean {
    return this.members.includes(member);
  }

  /** The next member to ask, or null when nobody is in rotation. */
  next(): T | null {
    if (this.members.length === 0) return null;
    this.turn = (this.turn + 1) % this.members.length;
    return this.members[this.turn] ?? null;
  }
}

/**
 * One request's outcome: a status; "refused" when the connection was
 * refused or cut (nothing was there to answer); "slow" when the client gave
 * up waiting on a forge that held the connection open; "nobody" when no
 * forge was in rotation to ask.
 */
export type Outcome = number | "refused" | "slow" | "nobody";

/** A request that did not come back answered, and the moment around it. */
export interface Miss {
  /** Milliseconds from the first request. */
  readonly atMs: number;
  /** The forge asked, or null when nobody was in rotation. */
  readonly forge: string | null;
  readonly outcome: Outcome;
  /** The client's error code ("ConnectionRefused", "TimeoutError"…), or null. */
  readonly code: string | null;
  /** Each forge's process at that moment: serving, draining or exited. */
  readonly forges: Readonly<Record<string, string>>;
}

export interface Tally {
  requests: number;
  /** Outcomes counted by status, "refused" and "nobody" included. */
  byOutcome: Record<string, number>;
  /** Requests each forge answered, by its name. */
  byForge: Record<string, number>;
  /** Every request that was not answered below 500, in order. */
  misses: Miss[];
}

export function emptyTally(): Tally {
  return { requests: 0, byOutcome: {}, byForge: {}, misses: [] };
}

export function count(
  tally: Tally,
  forge: string | null,
  outcome: Outcome,
  miss?: Omit<Miss, "forge" | "outcome">,
): void {
  tally.requests += 1;
  const key = String(outcome);
  tally.byOutcome[key] = (tally.byOutcome[key] ?? 0) + 1;
  if (forge !== null) tally.byForge[forge] = (tally.byForge[forge] ?? 0) + 1;
  if (miss !== undefined && (outcome === "slow" || isRefusal(outcome)))
    tally.misses.push({ ...miss, forge, outcome });
}

/**
 * Whether a person would have seen the forge down. A slow answer is not
 * one: the forge held the connection, and a busy machine is not a roll
 * that went dark (#2453).
 */
export function isRefusal(outcome: Outcome): boolean {
  return typeof outcome === "number" ? outcome >= 500 : outcome !== "slow";
}

export function refusals(tally: Tally): number {
  let n = 0;
  for (const [key, times] of Object.entries(tally.byOutcome))
    if (isRefusal(/^\d+$/.test(key) ? Number(key) : (key as Outcome))) n += times;
  return n;
}

export interface Timeline {
  /** Milliseconds from the first request to the new forge in rotation. */
  newInRotationMs: number | null;
  /** From the old forge's SIGTERM to the probe that took it out. */
  oldOutOfRotationMs: number | null;
  /** From the old forge's SIGTERM to its exit. */
  oldExitMs: number | null;
}

export interface Verdict {
  readonly ok: boolean;
  readonly requests: number;
  readonly refused: number;
  readonly tally: Tally;
  readonly timeline: Timeline;
  readonly problem: string | null;
}

/**
 * Zero refusals over a roll that happened. A rehearsal in which the new
 * forge never joined, or the old one never left, rolled nothing and says so.
 */
export function judge(tally: Tally, timeline: Timeline): Verdict {
  const refused = refusals(tally);
  const problem =
    timeline.newInRotationMs === null
      ? "the new forge never became ready"
      : timeline.oldExitMs === null
        ? "the old forge did not exit"
        : tally.requests === 0
          ? "no request was sent"
          : null;
  return {
    ok: refused === 0 && problem === null,
    requests: tally.requests,
    refused,
    tally,
    timeline,
    problem,
  };
}

const secs = (ms: number | null): string =>
  ms === null ? "never" : `${(ms / 1000).toFixed(1)}s`;

const MISSES_SHOWN = 20;

/** One miss as a line: when, whom, what came back, and where each process was. */
export function missLine(m: Miss): string {
  const forges = Object.entries(m.forges)
    .map(([k, state]) => `${k} ${state}`)
    .join(", ");
  return `miss       ${m.atMs} ms ${m.forge ?? "nobody in rotation"}: ${m.outcome}${m.code === null ? "" : ` (${m.code})`}; ${forges}`;
}

/** The verdict as the release checklist reads it. */
export function report(v: Verdict): string {
  const outcomes = Object.entries(v.tally.byOutcome)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, n]) => `${k}×${n}`)
    .join(" ");
  const forges = Object.entries(v.tally.byForge)
    .map(([k, n]) => `${k} ${n}`)
    .join(", ");
  return [
    v.ok
      ? `zero refused: ${v.requests} requests through the roll`
      : v.problem !== null
        ? `no verdict: ${v.problem}`
        : `${v.refused} of ${v.requests} requests refused: the roll went dark`,
    `outcomes   ${outcomes || "none"}`,
    `answered   ${forges || "by nobody"}`,
    `new ready  ${secs(v.timeline.newInRotationMs)} after the first request`,
    `old out    ${secs(v.timeline.oldOutOfRotationMs)} after its SIGTERM`,
    `old exit   ${secs(v.timeline.oldExitMs)} after its SIGTERM`,
    ...v.tally.misses.slice(0, MISSES_SHOWN).map(missLine),
    ...(v.tally.misses.length > MISSES_SHOWN
      ? [`           and ${v.tally.misses.length - MISSES_SHOWN} more`]
      : []),
  ].join("\n");
}

/** What a forge that did not come up, or went away, left to say why. */
export interface ForgeGone {
  readonly name: "old" | "new";
  readonly pid: number;
  readonly port: number;
  /** Its exit status; null while it still runs or when a signal ended it. */
  readonly exitCode: number | null;
  readonly signal: string | null;
  /** From its start to when it was given up on. */
  readonly waitedMs: number;
  /** Fresh ports it was started on after another process took its port. */
  readonly portsLost: number;
  /** What it wrote (stderr, else stdout); only the last lines are quoted. */
  readonly output: string;
  readonly log: string;
}

/** How many of a gone forge's last lines its error quotes. */
export const OUTPUT_TAIL_LINES = 20;

/**
 * The error a gone forge raises: which process on which port, how it
 * ended and how long it was waited for, and the end of what it said. The
 * log files go with the check's tmpdir, so the error carries their tail.
 */
export function goneLine(g: ForgeGone): string {
  const how =
    g.exitCode !== null
      ? `exited with code ${g.exitCode}`
      : g.signal !== null
        ? `was ended by ${g.signal}`
        : "was still not ready";
  const lost = g.portsLost === 0 ? "" : `, after losing ${g.portsLost} port${g.portsLost === 1 ? "" : "s"} to other processes`;
  const tail = g.output.trimEnd().split("\n").slice(-OUTPUT_TAIL_LINES).join("\n");
  const said = tail.trim() === "" ? `it wrote nothing; see ${g.log}` : `it wrote (${g.log}):\n${tail}`;
  return `the ${g.name} forge (pid ${g.pid}, port ${g.port}) ${how} ${g.waitedMs} ms after it started${lost}; ${said}`;
}
