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
 * Who takes requests, as a Service's endpoints do: a forge joins when a
 * probe sees it ready and leaves when a probe sees it not, never between
 * probes. Requests go round the members in turn.
 */
export class Rotation<T> {
  private members: T[] = [];
  private turn = 0;

  /** What one probe of `member` saw. */
  saw(member: T, ready: boolean): void {
    const at = this.members.indexOf(member);
    if (ready && at < 0) this.members.push(member);
    if (!ready && at >= 0) this.members.splice(at, 1);
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

/** One request's outcome: a status, or "refused" when nothing answered. */
export type Outcome = number | "refused" | "nobody";

export interface Tally {
  requests: number;
  /** Outcomes counted by status, "refused" and "nobody" included. */
  byOutcome: Record<string, number>;
  /** Requests each forge answered, by its name. */
  byForge: Record<string, number>;
}

export function emptyTally(): Tally {
  return { requests: 0, byOutcome: {}, byForge: {} };
}

export function count(tally: Tally, forge: string | null, outcome: Outcome): void {
  tally.requests += 1;
  const key = String(outcome);
  tally.byOutcome[key] = (tally.byOutcome[key] ?? 0) + 1;
  if (forge !== null) tally.byForge[forge] = (tally.byForge[forge] ?? 0) + 1;
}

/** Whether a person would have seen the forge down. */
export function isRefusal(outcome: Outcome): boolean {
  return typeof outcome === "number" ? outcome >= 500 : true;
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
  ].join("\n");
}
