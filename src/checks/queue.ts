/**
 * The merge queue (#2036): per repository, one line of pulls that are green
 * and approved. The line is built into candidates — the base's tip, then
 * each queued pull's squash on top of the one before, in queue order, for
 * every pull that merges cleanly — and each candidate is gated once. Green
 * lands every step in order, each landing guarded so the squash it writes
 * is the step's tree on the base the step was built on: main ends at
 * exactly the tree that was gated.
 *
 * The line gates in parallel where check slots are free (#4053). While a
 * candidate gates on main, the next gates on top of it (`depth` deep): if
 * the first lands whole, the next lands right after on the tree it was
 * gated on; if not, the next is discarded and formed again on main. A red
 * candidate is searched by gating prefixes of its own chain at once, one per
 * free slot, each stacked on the one before (#5994): the longest green
 * prefix lands, and the culprit is in the run the first red one adds,
 * searched again on top of it. With no slot free that is one prefix, the
 * front half: plain bisection. A single red step is the culprit and is
 * handed back.
 *
 * A gate cut off by the forge stopping is no verdict: nothing is handed
 * back, and the forge that carries on admits the line again (#3155). A gate
 * that has not answered by `GATE_DEADLINE_MS` is abandoned the same way:
 * cut off, logged, and the line re-formed by the next sweep, so one gate
 * that never returns cannot hold the queue for good (#3430).
 *
 * The line remembers what its searches found (#4235): a pull handed back
 * red is remembered at its head, with the pulls its red tree held besides
 * it — a clash when there are any: red on top of them (green alone, or red
 * on its own too; the search does not spend a gate to tell which). A
 * remembered pull that joins again at the same head is re-checked in a
 * candidate of its own, formed only when no fresh pull waits and never
 * stacked on, so a red re-check cuts off no batch of fresh pulls. It is
 * forgotten when it lands or its head changes.
 *
 * A red batch is never formed again around the same head (#4999). With a
 * check slot free, the head of a red batch of three or more — the pull
 * every prefix of it holds — is a suspect, gated alone beside the line,
 * while the rest of the batch goes back to the front of the line and gates
 * without it, stacked as deep as the line goes. A pull in two red batches
 * is a suspect too, never in a third. A suspect red alone is handed back;
 * green alone it rides at the tail of a batch, never at its head, and the
 * search finds it there if it is red on top of others.
 *
 * Every red says why (#5276, `gate_reason.ts`): `tests: N failed`,
 * `typecheck` or `check` is the code's and searched as above; `install`,
 * `setup` or `timeout` names no pull's code, so the gate runs once more and
 * red that way twice is infrastructure — no verdict, nothing handed back,
 * nothing bisected. A `check` red at the line's own gate (a batch or a
 * suspect, not a search's prefix) is gated once more before it is searched
 * (#6722): a check cut short that printed no reason is not yet a red. A
 * check a signal from outside ended — the pod going, the OOM killer — is
 * no verdict at all, as a gate cut off is not. A pull that conflicts with
 * an earlier one of its batch is never red: it is left out, the pair named,
 * and the rest gate at once. A red with tests names them in the log —
 * `red (2 failed: "a > b", "c")` — and every finished gate is kept a week
 * with its pulls, counts and failing tests (#6739, `gate_result.ts`), read
 * by `GET …/queue/gates`.
 *
 * What is queued is not stored: it is the pulls `landIfGreen` admitted, and
 * every sweep admits them again. The queue only orders them and remembers
 * what is at the gate and what its searches found, for the tick line and
 * the flow panel on /boards.
 */

import type { Pull } from "../core/pulls.ts";
import { runGit } from "../git/env.ts";
import { mergeable, resolveOid, treeOf } from "../git/merge.ts";
import { id } from "../kernel/id.ts";
import { createLog } from "../kernel/log.ts";
import type { QueueVerdict } from "../flow/culprits.ts";
import { conflictWords, reasonWords, redWords, searched } from "./gate_reason.ts";
import type { GateResult } from "./gate_result.ts";
import type { LandVerdict } from "./tiers.ts";

/** The base a step must land on, and the tree it must write. */
export interface Expect {
  readonly baseOid: string;
  readonly treeOid: string;
}

/** A red verdict: what the culprit is told. */
export type Red = Extract<LandVerdict, { reopen: true }>;

/** One pull in the line, and what landing or handing it back does. */
export interface Queued {
  readonly pull: Pull;
  /** Where the pull's objects are (`pullDir`): a candidate is built in one place. */
  readonly dir: string;
  /**
   * Land this pull as the step was gated: the new tip of the base, or
   * undefined when it did not land.
   */
  land(expect: Expect): Promise<string | undefined>;
  /**
   * This pull was the last step of its candidate to land, and the base is
   * now at `tip`: called once per candidate that landed anything.
   */
  release(tip: string): void;
  /**
   * The gate found this pull to be the red one, on this base. `together`
   * names the pulls of its candidate that landed onto that base first and
   * that its red tree held: none when it was red on its own merge.
   */
  handBack(red: Red, baseOid: string, together: readonly number[]): void;
}

/** One pull's squash on top of the steps before it. */
export interface Step {
  readonly entry: Queued;
  readonly baseOid: string;
  readonly treeOid: string;
  /** The chain's commit once this step is on it: the tip of its prefix. */
  readonly commitOid: string;
}

/** What is gated: a chain of steps on the base, ending at `tipOid`. */
export interface Candidate {
  readonly dir: string;
  readonly baseOid: string;
  readonly baseTreeOid: string;
  readonly steps: readonly Step[];
  readonly tipOid: string;
  readonly treeOid: string;
}

/**
 * Gate a candidate: the full tier on its tip. `signal` aborts when the
 * queue abandons the gate at its deadline: what it started should stop.
 */
export type GateCandidate = (candidate: Candidate, signal: AbortSignal) => Promise<LandVerdict>;

/**
 * How long a candidate's gate may run before the queue abandons it (#3430):
 * twice the forge's full tier. Past it the gate is no verdict, as a gate the
 * forge stopping cut off is not (#3155).
 */
export const GATE_DEADLINE_MS = 15 * 60_000;

let deadlineMs = GATE_DEADLINE_MS;

/** What arms the deadline; tests swap in a clock they fire themselves. */
type Schedule = (fire: () => void, ms: number) => ReturnType<typeof setTimeout>;
let schedule: Schedule = setTimeout;

/**
 * The most pulls one candidate carries when the line is not told (#3430):
 * eight keep a gate near one full tier. The rest of the line waits for the
 * next candidate, in order. A forge sets it as `queue.batch` (#6674).
 */
export const MAX_CANDIDATE = 8;

/** The largest batch a line takes, whatever it is told (`queue.batch`'s range). */
export const MAX_BATCH = 32;

/** Green gates in a row that double a shrunk batch (#6674). */
const GREENS_TO_GROW = 2;

/** Candidates gating at once by default: one on main, the next on top of it. */
export const DEFAULT_DEPTH = 2;

/** How the line may use the forge's check slots (#4053). */
export interface QueueOptions {
  /** How many candidates may gate at once, each on the one before. */
  readonly depth?: number;
  /**
   * The most pulls a candidate carries (`queue.batch`, #6674): the line
   * starts here, halves after a red batch and doubles back after two green
   * ones in a row, never past it. Read on every enqueue, so a sweep brings a
   * change to a line already draining.
   */
  readonly batch?: number;
  /**
   * Check slots free now for a gate beyond a line's first, the pull
   * checks' reserve already kept back; none when not said.
   */
  readonly room?: () => number;
  /**
   * A batch was judged: called once per candidate verdict the batch rate
   * counts (search prefixes, re-checks and cut-off gates not), so it can be
   * kept beyond this process (#6427).
   */
  readonly onBatch?: (repoId: string, red: boolean) => void;
  /** A red batch was named: a pull handed back, or a load red no pull is blamed for (#7639). */
  readonly onVerdict?: (repoId: string, verdict: QueueVerdict) => void;
  /**
   * A shorter prefix was red and a longer one holding it green: the red was
   * a flake, and its verdicts are handed here to be recorded.
   */
  readonly onFlake?: (repoId: string, reds: readonly Red[], tip: string) => void;
  /** Where the line's gates and red marks outlive this process (#6611). */
  readonly store?: QueueStore;
  /**
   * The verdict of a recorded gate still running on the check lane — in
   * this process or the one before it — or undefined when its run is gone
   * and the candidate must be gated again (#6611).
   */
  readonly adopt?: (record: GateRecord, signal: AbortSignal) => Promise<LandVerdict | undefined>;
}

/** A step as recorded: which pull at which head, and the commit it made. */
export interface RecordedStep {
  readonly pullId: string;
  readonly headOid: string;
  readonly baseOid: string;
  readonly treeOid: string;
  readonly commitOid: string;
}

/**
 * A gate as kept beyond this process (#6611): its candidate exactly as
 * built, the run the check lane gates it as, and its verdict once it has
 * one. A forge that carries on rebuilds the candidate from it, not the line.
 */
export interface GateRecord {
  readonly id: string;
  readonly repoId: string;
  /** The check lane's name for the gate: `gate-` and the tip's first 12. */
  readonly runId: string;
  readonly baseOid: string;
  readonly baseTreeOid: string;
  readonly tipOid: string;
  /** The tree the gate judges: on a speculative candidate, a tree main never had. */
  readonly treeOid: string;
  readonly steps: readonly RecordedStep[];
  readonly startedAt: string;
  /** Green or red, once the gate answered; never a cut-off. */
  readonly verdict?: Exclude<LandVerdict, { interrupted: true }>;
}

/** What the line keeps outside memory (`checks/queue_store.ts`). */
export interface QueueStore {
  /** A gate started. */
  began(record: GateRecord): void;
  /** A gate answered after its line stopped: kept for the line that carries on. */
  settled(id: string, verdict: Exclude<LandVerdict, { interrupted: true }>): void;
  /** A gate acted on, abandoned, or no longer anyone's to resume. */
  forget(id: string): void;
  /** The repository's recorded gates, oldest first. */
  gates(repoId: string): GateRecord[];
  /** Mark a pull red at a head and base, replacing its mark; undefined clears it. */
  red(repoId: string, pullId: string, mark: Remembered | undefined): void;
  /** The repository's red marks, by pull id. */
  reds(repoId: string): Map<string, Remembered>;
  /** A gate finished — green, red or cut off: what it found, kept a week (#6739). */
  judged?(id: string, result: GateResult): void;
}

/** The check lane's run id for a gate of `tipOid` (`checks/service.ts` names it so). */
export function gateRunId(tipOid: string): string {
  return `gate-${tipOid.slice(0, 12)}`;
}

/**
 * Tests shorten the deadline, or hand `arm` the timer to fire themselves (a
 * wall-clock deadline races the gate's setup on a loaded machine); the answer
 * puts both back.
 */
export function gateDeadlineForTest(ms: number, arm?: Schedule): () => void {
  deadlineMs = ms;
  if (arm !== undefined) schedule = arm;
  return () => {
    deadlineMs = GATE_DEADLINE_MS;
    schedule = setTimeout;
  };
}

/**
 * The gate as the line asks it: the deadline is the line's own. `resumed`
 * is the record of a gate an earlier line started on this candidate: its
 * verdict, or its run adopted, before a gate of its own.
 */
type Gated = (candidate: Candidate, signal?: AbortSignal, resumed?: GateRecord) => Promise<LandVerdict>;

/** Check slots free now for one more gate beyond a line's first. */
type Room = () => number;

interface Waiting {
  readonly entry: Queued;
  readonly settle: (landed: boolean) => void;
  /** Handed back red at this head before: gated alone, after the fresh pulls. */
  readonly recheck: boolean;
}

/** A pull the line handed back red, while its head is the same (#4235). */
export interface Remembered {
  readonly head: string;
  /** The base tip it went red on: a moved base is a new try (#6493). */
  readonly base: string;
  /** The pulls its red tree held besides it: a clash when there are any. */
  readonly together: readonly number[];
  /** When the line handed it back (epoch ms). */
  readonly at: number;
}

/** A pull in red batches at this head (#4999): gated alone once it is a suspect. */
interface Suspect {
  readonly head: string;
  /** Red batches it was in, less the ones a culprit found since explains. */
  readonly reds: number;
  /** Waits for a verdict of its own, gated alone beside the line. */
  readonly alone: boolean;
  /** Green alone at this head: never at the head of a batch again. */
  readonly cleared: boolean;
}

/** A first candidate's verdict, for the red-batch rate. */
interface BatchVerdict {
  readonly at: number;
  readonly red: boolean;
}

/** One gate in flight: the pulls its candidate carries, and since when. */
interface InFlight {
  readonly pulls: readonly string[];
  readonly since: number;
}

interface Line {
  readonly repoId: string;
  waiting: Waiting[];
  /** Pull ids in the queue or a candidate: a pull is in the line once. */
  readonly holds: Set<string>;
  /** The gates this line has in flight now. */
  readonly flights: Set<InFlight>;
  /** Candidates being built, taken from the line and not yet at the gate. */
  forming: number;
  /** The gate runs this line has made, for a test and the log. */
  gates: number;
  /** Pulls handed back red, by pull id: re-checked alone if they join again. */
  readonly reds: Map<string, Remembered>;
  /** Pulls in red batches, by pull id, while their head is the same (#4999). */
  readonly suspects: Map<string, Suspect>;
  /** The last hour's candidate verdicts, search prefixes and re-checks not counted. */
  batches: BatchVerdict[];
  /** The most pulls a batch may carry, as the last enqueue was told (#6674). */
  ceiling: number;
  /** The batch size after a red, below the ceiling; undefined when at it (#6674). */
  size: number | undefined;
  /** Green batch verdicts in a row since the last red or the last doubling. */
  greens: number;
  /**
   * Pulls back in the line from a batch that gated: they gate together
   * again up to the ceiling, past a size a red halved (#6674).
   */
  readonly back: Set<Waiting>;
  draining: boolean;
  /** Wakes a drain waiting on a gate when pulls join the line. */
  wake: (() => void) | undefined;
  /** Where its gates and red marks are kept, when anywhere (#6611). */
  store: QueueStore | undefined;
  /** Gates an earlier line recorded and this one may resume, oldest first. */
  kept: GateRecord[];
  /** Stopped (`stopQueue`): its gates run on, but it acts on no verdict. */
  stopped: boolean;
}

/** A candidate at the gate in the pipeline, and the pulls it took from the line. */
interface Flight {
  readonly steps: readonly Waiting[];
  readonly candidate: Candidate;
  /** Built on the flight before it, not on the base's tip. */
  readonly speculative: boolean;
  /** A remembered red gated alone: nothing stacks on it. */
  readonly recheck: boolean;
  readonly branch: string;
  readonly verdict: Promise<LandVerdict>;
  readonly abort: AbortController;
}

const log = createLog("queue");

const lines = new Map<string, Line>();

/** Gates in flight beyond each line's first, every line together. */
let extra = 0;

/**
 * Gates the queue has in flight beyond each line's first: each holds a
 * check slot a pull check does not take (`checks/service.ts`).
 */
export function extraGates(): number {
  return extra;
}

const watchers = new Set<() => void>();

/**
 * Calls `fn` whenever a gate's slot frees: a gate ends or a candidate stops
 * forming. The check service schedules then, not at its next tick, so a pull
 * check held back for the gate starts as soon as the gate is done.
 */
export function watchGates(fn: () => void): () => void {
  watchers.add(fn);
  return () => void watchers.delete(fn);
}

function gateFreed(): void {
  for (const fn of [...watchers]) fn();
}

/**
 * Every gate in flight, each line's first included: each holds a check slot
 * for as long as it runs, so a pull check never shares the machine with it
 * (`checks/service.ts`, #6376).
 */
export function gatesInFlight(): number {
  let n = extra;
  for (const line of lines.values()) if (line.flights.size > 0) n++;
  return n;
}

/**
 * Whether some line's first gate is about to start: its candidate is being
 * built and no gate of that line is in flight. Such a gate takes the next
 * free check slot before a pull check does (`checks/service.ts`); once it
 * runs, `gatesInFlight` holds the slot.
 */
export function gateQueued(): boolean {
  for (const line of lines.values()) if (line.forming > 0 && line.flights.size === 0) return true;
  return false;
}

const IDENTITY = {
  GIT_AUTHOR_NAME: "forge",
  GIT_AUTHOR_EMAIL: "forge@localhost",
  GIT_COMMITTER_NAME: "forge",
  GIT_COMMITTER_EMAIL: "forge@localhost",
};

const UNDECIDED: LandVerdict = { lands: false, interrupted: true };

/**
 * The repository's line. A new one starts from what the store kept (#6611):
 * the red marks, and the gates an earlier line left to resume.
 */
function lineOf(repoId: string, store: QueueStore | undefined): Line {
  let line = lines.get(repoId);
  if (line === undefined) {
    const reds = kept(() => store?.reds(repoId)) ?? new Map<string, Remembered>();
    line = {
      repoId,
      waiting: [],
      holds: new Set(),
      flights: new Set(),
      forming: 0,
      gates: 0,
      reds,
      suspects: new Map(),
      batches: [],
      ceiling: MAX_CANDIDATE,
      size: undefined,
      greens: 0,
      back: new Set(),
      draining: false,
      wake: undefined,
      store,
      kept: kept(() => store?.gates(repoId)) ?? [],
      stopped: false,
    };
    lines.set(repoId, line);
  }
  line.store ??= store;
  return line;
}

/** A store call: what it answers, or undefined, logged, when it fails. The line goes on in memory. */
function kept<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch (error) {
    log.warn("merge queue state not kept", { error: String(error) });
    return undefined;
  }
}

/** Mark a pull red at its head and base, here and in the store. */
function markRed(line: Line, pullId: string, mark: Remembered): void {
  line.reds.set(pullId, mark);
  kept(() => line.store?.red(line.repoId, pullId, mark));
}

/** Forget a pull's red mark, here and in the store. */
function clearRed(line: Line, pullId: string): void {
  if (!line.reds.delete(pullId)) return;
  kept(() => line.store?.red(line.repoId, pullId, undefined));
}

/**
 * Stop every line (#6611), as the forge stopping does first: what waits is
 * answered `false`, and no verdict from here on is acted on — the gates in
 * flight run on, and one that answers is kept in the store for the forge
 * that carries on. Lines asked for after this start afresh from the store.
 */
export function stopQueue(): void {
  for (const line of lines.values()) {
    line.stopped = true;
    const waiting = line.waiting;
    line.waiting = [];
    for (const w of waiting) w.settle(false);
    line.wake?.();
    line.wake = undefined;
  }
  lines.clear();
}

/**
 * Join the repository's line, in this order. Each answer is whether that
 * pull landed. A pull already in the line is answered `false` at once: the
 * entry already there carries it.
 */
export async function enqueue(
  repoId: string,
  entries: readonly Queued[],
  gate: GateCandidate,
  options: QueueOptions = {},
): Promise<boolean[]> {
  const line = lineOf(repoId, options.store);
  line.ceiling = batchCeiling(options.batch);
  // A red mark names the base it went red on; the tip is read only when a
  // mark is there to compare it with.
  const tips = new Map<string, string | undefined>();
  for (const { pull, dir } of entries) {
    if (!line.reds.has(pull.id) || tips.has(pull.baseBranch + "\0" + dir)) continue;
    tips.set(pull.baseBranch + "\0" + dir, await resolveOid(dir, `refs/heads/${pull.baseBranch}`));
  }
  const answers = entries.map((entry) => {
    if (line.holds.has(entry.pull.id)) return Promise.resolve(false);
    line.holds.add(entry.pull.id);
    const red = line.reds.get(entry.pull.id);
    const tip = tips.get(entry.pull.baseBranch + "\0" + entry.dir);
    const held = red !== undefined && red.head === entry.pull.headOid && (tip === undefined || red.base === tip);
    if (red !== undefined && !held) clearRed(line, entry.pull.id);
    const recheck = held;
    if (line.suspects.get(entry.pull.id)?.head !== entry.pull.headOid) line.suspects.delete(entry.pull.id);
    return new Promise<boolean>((resolve) => {
      const waiting: Waiting = {
        entry,
        recheck,
        settle: (landed) => {
          line.holds.delete(entry.pull.id);
          line.back.delete(waiting);
          if (landed) {
            clearRed(line, entry.pull.id);
            line.suspects.delete(entry.pull.id);
          }
          resolve(landed);
        },
      };
      line.waiting.push(waiting);
    });
  });
  if (!line.draining) void drain(line, gate, options);
  else {
    line.wake?.();
    line.wake = undefined;
  }
  return Promise.all(answers);
}

/** `queue.batch` as a line takes it: a whole number from 1 to `MAX_BATCH`, else the default. */
function batchCeiling(batch: number | undefined): number {
  if (batch === undefined || !Number.isFinite(batch)) return MAX_CANDIDATE;
  return Math.max(1, Math.min(MAX_BATCH, Math.floor(batch)));
}

/** How many pulls the line's next batch carries: its adapted size, never past the ceiling. */
function batchSize(line: Line): number {
  return Math.min(line.ceiling, line.size ?? line.ceiling);
}

/**
 * A batch verdict moves the size (#6674): a red halves it, never below one;
 * two greens in a row double a shrunk one, back to the ceiling at most. A
 * clean line drains in big batches, a flaky one stays small.
 */
function adapt(line: Line, red: boolean): void {
  const was = batchSize(line);
  if (red) {
    line.greens = 0;
    line.size = Math.max(1, Math.floor(was / 2));
  } else {
    line.greens++;
    if (line.greens < GREENS_TO_GROW) return;
    line.greens = 0;
    if (line.size === undefined) return;
    line.size = line.size * 2 >= line.ceiling ? undefined : line.size * 2;
  }
  const now = batchSize(line);
  if (now !== was) log.info(`batch ${now > was ? "grows" : "halves"} to ${now}`, { repo: line.repoId, from: was });
}

/**
 * The size of a repository's next batch, for the tick line (#6674): `8`, or
 * `4 of 16` while a red keeps it below `ceiling`, the setting in force.
 */
export function batchWords(repoId: string, ceiling: number): string {
  const line = lines.get(repoId);
  const top = batchCeiling(ceiling);
  const size = Math.min(top, line?.size ?? top);
  return size < top ? `${size} of ${top}` : String(top);
}

/** The pulls waiting in a repository's line, not yet in a candidate: as they joined. */
export function waitingPulls(repoId: string): Pull[] {
  return (lines.get(repoId)?.waiting ?? []).map((w) => w.entry.pull);
}

/**
 * Take pulls out of the line before they reach a gate (#6611): held,
 * closed, pushed to or no longer approved, a pull that waits on would be
 * gated in the next batch all the same. Each is answered `false`; a pull
 * already in a candidate is left to its gate. How many were taken out.
 */
export function dropFromLine(repoId: string, pullIds: ReadonlySet<string>): number {
  const line = lines.get(repoId);
  if (line === undefined) return 0;
  const gone = line.waiting.filter((w) => pullIds.has(w.entry.pull.id));
  if (gone.length === 0) return 0;
  line.waiting = line.waiting.filter((w) => !pullIds.has(w.entry.pull.id));
  for (const w of gone) w.settle(false);
  log.info("taken out of the line", {
    repo: repoId,
    pulls: gone.map((w) => `#${w.entry.pull.number}`).join(","),
    waiting: line.waiting.length,
  });
  return gone.length;
}

/** What the flow panel shows of each repository's line. */
export interface QueueStatus {
  readonly repoId: string;
  readonly queued: number;
  /** Pulls in a candidate at the gate, each counted once. */
  readonly gating: number;
  /** Gates in flight. */
  readonly gates: number;
  /** When the oldest gate in flight started, epoch ms; 0 when none is. */
  readonly since: number;
}

function statusOf(repoId: string, line: Line): QueueStatus {
  const pulls = new Set<string>();
  let since = 0;
  for (const f of line.flights) {
    for (const id of f.pulls) pulls.add(id);
    if (since === 0 || f.since < since) since = f.since;
  }
  return { repoId, queued: line.waiting.length, gating: pulls.size, gates: line.flights.size, since };
}

export function queueStatus(): QueueStatus[] {
  return [...lines.entries()]
    .map(([repoId, line]) => statusOf(repoId, line))
    .filter((s) => s.queued > 0 || s.gating > 0);
}

/**
 * The repository's line in a few words, for the tick line (#3430):
 * `gating 4 pulls since 18:54` (UTC), `in 2 gates` when more than one is
 * in flight, `2 waiting`, or `idle`.
 */
export function queueWords(repoId: string): string {
  const line = lines.get(repoId);
  if (line === undefined) return "idle";
  const s = statusOf(repoId, line);
  const waiting = s.queued === 0 ? "" : `${s.queued} waiting`;
  if (s.gating === 0) return waiting === "" ? "idle" : waiting;
  const gates = s.gates > 1 ? ` in ${s.gates} gates` : "";
  return `gating ${pullsWord(s.gating)} since ${hhmm(s.since)}${gates}${waiting === "" ? "" : `, ${waiting}`}`;
}

/**
 * Clashes the line remembers, for the tick line (#4235): pulls handed back
 * red on top of others of their candidate, at the head they were red on.
 */
export function queueClashes(repoId: string): number {
  let n = 0;
  for (const red of lines.get(repoId)?.reds.values() ?? []) if (red.together.length > 0) n++;
  return n;
}

/** A pull's red mark, as the page says it: when, at which head, on which base. */
export interface RedMark {
  readonly at: string;
  readonly head: string;
  readonly base: string;
}

/**
 * The mark the line holds on a pull that was red alone — on its own merge,
 * not on top of others — at this `head`; undefined when it holds none.
 */
export function redMark(repoId: string, pullId: string, head: string): RedMark | undefined {
  const red = lines.get(repoId)?.reds.get(pullId);
  if (red === undefined || red.head !== head || red.together.length > 0) return undefined;
  return { at: new Date(red.at).toISOString(), head: red.head, base: red.base };
}

/** What the line waits for on a pull it holds as red alone. */
export const RED_ALONE_WAIT = "waiting for a new head or a new main";

/** A mark's time as both doors say it: `2026-10-26 20:41 UTC`; empty when it does not parse. */
export function redAloneAt(mark: RedMark): string {
  const at = new Date(mark.at);
  return Number.isNaN(at.getTime()) ? "" : `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

const HOUR_MS = 60 * 60_000;

/** The last hour's first candidates of a line, and how many of them were red (#4235). */
export interface BatchRate {
  readonly batches: number;
  readonly red: number;
}

export function redBatchRate(repoId: string, now = Date.now()): BatchRate {
  const line = lines.get(repoId);
  if (line === undefined) return { batches: 0, red: 0 };
  line.batches = line.batches.filter((b) => now - b.at < HOUR_MS);
  return { batches: line.batches.length, red: line.batches.filter((b) => b.red).length };
}

/** `1 pull`, `8 pulls`. */
function pullsWord(n: number): string {
  return n === 1 ? "1 pull" : `${n} pulls`;
}

/** An epoch-ms instant as `HH:MM`, UTC as the log is. */
function hhmm(ms: number): string {
  return new Date(ms).toISOString().slice(11, 16);
}

/**
 * A gate's verdict in a few words, for the log: a red says why (#5276),
 * naming its failing tests when it read any (#6739).
 */
function outcome(verdict: LandVerdict): string {
  if (verdict.lands) return "green";
  return "interrupted" in verdict ? "cut off" : `red (${redWords(verdict.reason, verdict.tests)})`;
}

/** What a finished gate found, as `gate_result` keeps it (#6739). */
function resultOf(repoId: string, record: GateRecord, candidate: Candidate, verdict: LandVerdict, since: number): GateResult {
  const red = !verdict.lands && !("interrupted" in verdict) ? verdict : undefined;
  return {
    repoId,
    runId: record.runId,
    tipOid: candidate.tipOid,
    pulls: candidate.steps.map((s) => s.entry.pull.number),
    state: verdict.lands ? "green" : red === undefined ? "cut_off" : "red",
    ...(red?.reason === undefined ? {} : { reason: red.reason.kind }),
    passed: red?.tests?.passed ?? 0,
    failed: red?.tests?.failed ?? (red?.reason?.kind === "tests" ? red.reason.failed : 0),
    failing: red?.tests?.failing ?? [],
    startedAt: new Date(since).toISOString(),
    finishedAt: new Date().toISOString(),
  };
}

/** A red that names no pull's code — install, setup, timeout: gated once more, never searched. */
function machines(verdict: LandVerdict): verdict is Red {
  return !verdict.lands && !("interrupted" in verdict) && !searched(verdict.reason);
}

/**
 * A red that names neither a test nor a type error (#6722): the check
 * exited red and said nothing a pull could be searched for — a check cut
 * short by a reason it did not print. Gated once more before it is searched.
 */
function unproven(verdict: LandVerdict): verdict is Red {
  return !verdict.lands && !("interrupted" in verdict) && verdict.reason?.kind === "check";
}

/** Gate runs a repository's line has made since boot. */
export function gateRuns(repoId: string): number {
  return lines.get(repoId)?.gates ?? 0;
}

/**
 * The line's gate (`attempt`), and once more when it was red for a reason
 * that names no pull's code (#5276, #5093): an install, the gate's own
 * setup, a timeout. Red that way twice is infrastructure — no verdict, as a
 * gate cut off is not: no pull is handed back and nothing is searched. A
 * line's own `red (check)` — no test named, no type error — is gated once
 * more too (#6722), and red again it is searched; a `search` gate is not.
 */
function counted(
  line: Line,
  gate: GateCandidate,
  adopt: QueueOptions["adopt"],
  search: boolean,
  onVerdict?: QueueOptions["onVerdict"],
): Gated {
  const once = attempt(line, gate, adopt);
  return async (candidate, signal, resumed) => {
    const first = await once(candidate, signal, resumed);
    // A stopped line gates nothing more: its verdict is kept for the next.
    if (signal?.aborted === true || line.stopped) return first;
    // The line's own red (check) is gated once more before the search
    // spends a gate on it (#6722); a search's prefix is not.
    if (!search && unproven(first)) {
      log.info(`gated ${pullsWord(candidate.steps.length)}: red (check) named no test, gating once more`, {
        repo: line.repoId,
        pulls: candidate.steps.map((s) => `#${s.entry.pull.number}`).join(","),
      });
      return once(candidate, signal);
    }
    if (!machines(first)) return first;
    const again = await once(candidate, signal);
    if (!machines(again)) return again;
    log.warn(`gated ${pullsWord(candidate.steps.length)}: infrastructure (${reasonWords(again.reason)}, twice)`, {
      repo: line.repoId,
      pulls: candidate.steps.map((s) => `#${s.entry.pull.number}`).join(","),
    });
    told(onVerdict, line.repoId, { kind: "load", why: again.reason?.kind ?? "check", tests: [] });
    return UNDECIDED;
  };
}

/** Hand a verdict to its keeper; a keeper that fails never stops the queue. */
function told(keep: QueueOptions["onVerdict"], repoId: string, verdict: QueueVerdict): void {
  try {
    keep?.(repoId, verdict);
  } catch (error) {
    log.warn("verdict not kept", { repo: repoId, error: String(error) });
  }
}

/**
 * One gate run: counted, logged as it starts and ends (a gate takes
 * minutes, #3430), and abandoned at the deadline or when `signal` aborts —
 * a speculative candidate discarded. Abandoned is no verdict.
 */
function attempt(line: Line, gate: GateCandidate, adopt: QueueOptions["adopt"]): Gated {
  return async (candidate, signal, resumed) => {
    // Answered before this line was: acted on now, nothing gated (#6611).
    if (resumed?.verdict !== undefined) {
      log.info(`resumed a gate's ${outcome(resumed.verdict)} verdict`, {
        repo: line.repoId,
        pulls: candidate.steps.map((s) => `#${s.entry.pull.number}`).join(","),
      });
      kept(() => line.store?.forget(resumed.id));
      return resumed.verdict;
    }
    const beyond = line.flights.size > 0;
    const since = resumed === undefined ? Date.now() : Date.parse(resumed.startedAt) || Date.now();
    const flight: InFlight = { pulls: candidate.steps.map((s) => s.entry.pull.id), since };
    line.flights.add(flight);
    if (beyond) extra++;
    const n = candidate.steps.length;
    const pulls = candidate.steps.map((s) => `#${s.entry.pull.number}`).join(",");
    log.info(`${resumed === undefined ? "gating" : "resuming"} ${pullsWord(n)} since ${hhmm(flight.since)}`, {
      repo: line.repoId,
      pulls,
      waiting: line.waiting.length,
    });
    const record = resumed ?? recordOf(line.repoId, candidate, flight.since);
    if (resumed === undefined) kept(() => line.store?.began(record));
    const abandon = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let dropped: (() => void) | undefined;
    // A gate that never answers is abandoned at the deadline: no verdict,
    // and the next sweep forms the line again (#3430).
    const cut = new Promise<LandVerdict>((resolve) => {
      timer = schedule(() => {
        log.warn("candidate abandoned", {
          repo: line.repoId,
          pulls,
          since: new Date(flight.since).toISOString(),
          deadline: `${Math.round(deadlineMs / 1000)}s`,
        });
        abandon.abort();
        resolve(UNDECIDED);
      }, deadlineMs);
      dropped = () => {
        abandon.abort();
        resolve(UNDECIDED);
      };
      if (signal?.aborted === true) dropped();
      else signal?.addEventListener("abort", dropped, { once: true });
    });
    try {
      // A recorded gate still running on the check lane is adopted, not
      // started again; one whose run is gone is gated again as it was (#6611).
      const adopted =
        resumed === undefined || adopt === undefined
          ? undefined
          : await Promise.race([adopt(resumed, abandon.signal), cut]);
      if (adopted === undefined) line.gates++;
      const verdict = adopted ?? (await Promise.race([gate(candidate, abandon.signal), cut]));
      log.info(`gated ${pullsWord(n)}: ${outcome(verdict)}`, {
        repo: line.repoId,
        pulls,
        took: `${Math.round((Date.now() - flight.since) / 1000)}s`,
        ...(adopted === undefined ? {} : { adopted: record.runId }),
      });
      kept(() => line.store?.judged?.(id(), resultOf(line.repoId, record, candidate, verdict, flight.since)));
      // A stopped line acts on nothing: a verdict is kept for the line that
      // carries on, and so is a gate its forge stopping cut off. Anything
      // else is acted on now, or was abandoned: not to resume.
      if (line.stopped && !("interrupted" in verdict)) kept(() => line.store?.settled(record.id, verdict));
      else if (!line.stopped || abandon.signal.aborted) kept(() => line.store?.forget(record.id));
      return verdict;
    } finally {
      clearTimeout(timer);
      if (dropped !== undefined) signal?.removeEventListener("abort", dropped);
      line.flights.delete(flight);
      if (beyond) extra--;
      gateFreed();
    }
  };
}

/** The record of a gate starting now on `candidate`. */
function recordOf(repoId: string, candidate: Candidate, since: number): GateRecord {
  return {
    id: id(),
    repoId,
    runId: gateRunId(candidate.tipOid),
    baseOid: candidate.baseOid,
    baseTreeOid: candidate.baseTreeOid,
    tipOid: candidate.tipOid,
    treeOid: candidate.treeOid,
    steps: candidate.steps.map((s) => ({
      pullId: s.entry.pull.id,
      headOid: s.entry.pull.headOid,
      baseOid: s.baseOid,
      treeOid: s.treeOid,
      commitOid: s.commitOid,
    })),
    startedAt: new Date(since).toISOString(),
  };
}

/** A drain waiting on its gate, woken by pulls joining the line. */
const ARRIVED = Symbol("arrived");

/**
 * Until the line is empty: keep up to `depth` candidates at the gate, the
 * first on the base's tip and each next on the one before, and settle the
 * first as its verdict comes. A batch is the front of the line that shares
 * one place and one base branch; a sealed pull whose objects live
 * elsewhere is a batch of its own, and is not stacked on another. A batch
 * carries at most the line's batch size (`batchSize`). A gate beyond the line's first
 * starts only on a free check slot (`room`). A suspect is gated alone,
 * beside the line and first (#4999); the line's first gate waits for a
 * free slot while one is.
 */
async function drain(line: Line, gate: GateCandidate, options: QueueOptions): Promise<void> {
  line.draining = true;
  const gated = counted(line, gate, options.adopt, false, options.onVerdict);
  const searching = counted(line, gate, options.adopt, true, options.onVerdict);
  const depth = Math.max(1, Math.floor(options.depth ?? DEFAULT_DEPTH));
  const room: Room = options.room ?? (() => 0);
  const ahead: Flight[] = [];
  const solos = new Set<Promise<void>>();
  try {
    while (line.waiting.length > 0 || ahead.length > 0 || solos.size > 0) {
      // Stopped: what is at the gate is answered `false` and left running,
      // for the forge that carries on to adopt (#6611).
      if (line.stopped) {
        for (const f of ahead.splice(0)) for (const w of f.steps) w.settle(false);
        return;
      }
      for (const w of line.waiting.filter((w) => suspectOf(line, w)?.alone === true)) {
        if (line.flights.size > 0 && room() <= 0) break;
        line.waiting = line.waiting.filter((x) => x !== w);
        const started = await solo(line, gated, w);
        if (started === undefined) continue;
        const done: Promise<void> = started.done.finally(() => {
          solos.delete(done);
          line.wake?.();
          line.wake = undefined;
        });
        solos.add(done);
      }
      while (
        ahead.length < depth &&
        line.waiting.some((w) => suspectOf(line, w)?.alone !== true) &&
        ((ahead.length === 0 && solos.size === 0) || room() > 0)
      ) {
        const flight = await launch(line, gated, ahead.at(-1));
        if (flight === "apart") break;
        if (flight !== undefined) ahead.push(flight);
      }
      const head = ahead[0];
      // Pulls joining, a suspect coming back or the line stopping wake it.
      const arrived = new Promise<typeof ARRIVED>((resolve) => (line.wake = () => resolve(ARRIVED)));
      if (head === undefined) {
        // Only suspects at the gate, or waiting on a slot: wait for one to come back.
        if (solos.size > 0) await arrived;
        line.wake = undefined;
        continue;
      }
      const verdict = await Promise.race([head.verdict, arrived]);
      line.wake = undefined;
      if (verdict === ARRIVED || line.stopped) continue;
      ahead.shift();
      let left: Waiting[];
      try {
        left = await settleHead(
          { line, gated: searching, room, onBatch: options.onBatch, onFlake: options.onFlake, onVerdict: options.onVerdict },
          head,
          verdict,
          ahead,
        );
      } catch (error) {
        log.warn("merge queue round failed", { error: String(error) });
        for (const w of head.steps) w.settle(false);
        left = await discard(ahead);
      }
      // What waits for the next candidate goes back to the front.
      for (const w of left) line.back.add(w);
      line.waiting = [...left, ...line.waiting];
    }
  } finally {
    line.draining = false;
  }
}

/** What the line knows of a waiting pull's red batches, at its head. */
function suspectOf(line: Line, w: Waiting): Suspect | undefined {
  const s = line.suspects.get(w.entry.pull.id);
  return s?.head === w.entry.pull.headOid ? s : undefined;
}

/**
 * Start a suspect's gate alone on the base's tip, beside the line (#4999):
 * its answer is when the verdict is acted on. Red alone, it is handed back
 * and the pulls of its batch are cleared of that red; green alone, it goes
 * back to the line to ride at a batch's tail. Undefined when there is
 * nothing to gate — it conflicts, or is already in — and the next sweep
 * brings it up to date or closes it.
 */
async function solo(line: Line, gated: Gated, w: Waiting): Promise<{ readonly done: Promise<void> } | undefined> {
  const settled = (error: unknown): void => {
    log.warn("merge queue round failed", { error: String(error) });
    w.settle(false);
  };
  let candidate: Candidate | undefined;
  try {
    candidate = await build([w]);
  } catch (error) {
    settled(error);
    return undefined;
  }
  if (candidate === undefined || candidate.steps.length === 0) {
    w.settle(false);
    return undefined;
  }
  const on = candidate;
  const done = gated(on)
    .then((verdict) => {
      const pull = w.entry.pull;
      if (line.stopped) return w.settle(false);
      if (verdict.lands) {
        line.suspects.set(pull.id, { head: pull.headOid, reds: 0, alone: false, cleared: true });
        line.back.add(w);
        line.waiting.unshift(w);
        return;
      }
      if ("interrupted" in verdict) {
        w.settle(false);
        return;
      }
      line.suspects.delete(pull.id);
      markRed(line, pull.id, { head: pull.headOid, base: on.baseOid, together: [], at: Date.now() });
      log.info("red alone", { repo: line.repoId, pull: pull.number });
      w.entry.handBack(verdict, on.baseOid, []);
      w.settle(false);
    })
    .catch(settled);
  return { done };
}

/**
 * Every pull of a red batch was in one more red batch (#4999). Its head is
 * the suspect when `split`; a pull in two red batches is one too, unless it
 * was green alone at this head.
 */
function suspected(line: Line, steps: readonly Waiting[], split: boolean): void {
  for (const [i, w] of steps.entries()) {
    const was = suspectOf(line, w);
    const reds = (was?.reds ?? 0) + 1;
    const cleared = was?.cleared ?? false;
    const alone = !cleared && (reds >= 2 || (split && i === 0));
    line.suspects.set(w.entry.pull.id, { head: w.entry.pull.headOid, reds, alone, cleared });
  }
}

/** A culprit found among `steps` explains the red batch they were in: one red each is forgiven. */
function explained(line: Line, steps: readonly Waiting[]): void {
  for (const w of steps) {
    const was = suspectOf(line, w);
    if (was === undefined) continue;
    const reds = Math.max(0, was.reds - 1);
    line.suspects.set(w.entry.pull.id, { ...was, reds, alone: !was.cleared && reds >= 2 });
  }
}

/**
 * Take the next batch from the front of the line, build it — on `on`'s tip
 * when there is a flight to stack on — and start its gate. Fresh pulls go
 * first, a pull green alone after a red batch at their tail; a re-check is
 * a batch of one, once no fresh pull waits. A suspect is never in a batch:
 * it is gated alone (`solo`). `apart`
 * when the front of the line cannot stack on `on`, or `on` is a re-check;
 * undefined when nothing of the batch could be built.
 */
async function launch(line: Line, gated: Gated, on: Flight | undefined): Promise<Flight | undefined | "apart"> {
  if (on === undefined && line.kept.length > 0) {
    line.forming++;
    try {
      const resumed = await resumable(line);
      if (resumed !== undefined) {
        const { record, batch, candidate } = resumed;
        line.waiting = line.waiting.filter((w) => !batch.includes(w));
        const abort = new AbortController();
        const verdict = gated(candidate, abort.signal, record).catch((error: unknown) => {
          log.warn("merge queue round failed", { error: String(error) });
          return UNDECIDED;
        });
        const recheck = batch.length === 1 && batch[0]!.recheck;
        return { steps: batch, candidate, speculative: false, recheck, branch: batch[0]!.entry.pull.baseBranch, verdict, abort };
      }
    } finally {
      line.forming--;
      gateFreed();
    }
  }
  const cleared = (w: Waiting): boolean => suspectOf(line, w)?.cleared === true;
  const open = line.waiting.filter((w) => suspectOf(line, w)?.alone !== true);
  const front = open.find((w) => !w.recheck && !cleared(w)) ?? open.find((w) => !w.recheck) ?? open[0]!;
  const first = front.entry;
  const branch = first.pull.baseBranch;
  if (on !== undefined && (on.recheck || first.dir !== on.candidate.dir || branch !== on.branch)) return "apart";
  const same = open.filter((w) => !w.recheck && w.entry.dir === first.dir && w.entry.pull.baseBranch === branch);
  // A halved size holds fresh pulls back; what came back from a batch gates together.
  const size = Math.min(line.ceiling, Math.max(batchSize(line), same.filter((w) => line.back.has(w)).length));
  const batch = front.recheck
    ? [front]
    : [...same.filter((w) => !cleared(w)), ...same.filter(cleared)].slice(0, size);
  for (const w of batch) line.back.delete(w);
  line.waiting = line.waiting.filter((w) => !batch.includes(w));
  let candidate: Candidate | undefined;
  line.forming++;
  let verdict: Promise<LandVerdict>;
  let steps: Waiting[];
  const abort = new AbortController();
  try {
    try {
      candidate = await build(batch, on?.candidate);
    } catch (error) {
      log.warn("merge queue round failed", { error: String(error) });
    }
    if (candidate === undefined || candidate.steps.length === 0) {
      for (const w of batch) w.settle(false);
      return undefined;
    }
    steps = inCandidate(batch, candidate);
    verdict = gated(candidate, abort.signal).catch((error: unknown) => {
      log.warn("merge queue round failed", { error: String(error) });
      return UNDECIDED;
    });
  } finally {
    line.forming--;
    gateFreed();
  }
  return { steps, candidate, speculative: on !== undefined, recheck: front.recheck, branch, verdict, abort };
}

/**
 * The first gate an earlier line recorded that this one can resume (#6611):
 * every pull of it waiting at the head it was gated at, none a suspect to
 * gate alone, and the base still at the tip it was built on. Its candidate
 * is rebuilt from the record — the very commits that were gated — so it is
 * not planned again. A record that cannot be resumed is forgotten.
 */
async function resumable(
  line: Line,
): Promise<{ record: GateRecord; batch: Waiting[]; candidate: Candidate } | undefined> {
  while (line.kept.length > 0) {
    const record = line.kept.shift()!;
    const batch: Waiting[] = [];
    for (const s of record.steps) {
      const w = line.waiting.find((w) => w.entry.pull.id === s.pullId && w.entry.pull.headOid === s.headOid);
      if (w === undefined || suspectOf(line, w)?.alone === true) break;
      batch.push(w);
    }
    const first = batch[0]?.entry;
    const whole =
      first !== undefined &&
      batch.length === record.steps.length &&
      batch.every((w) => w.entry.dir === first.dir && w.entry.pull.baseBranch === first.pull.baseBranch) &&
      (await resolveOid(first.dir, `refs/heads/${first.pull.baseBranch}`)) === record.baseOid &&
      (await resolveOid(first.dir, record.tipOid)) === record.tipOid;
    if (!whole) {
      kept(() => line.store?.forget(record.id));
      continue;
    }
    const steps = record.steps.map((s, i) => ({
      entry: batch[i]!.entry,
      baseOid: s.baseOid,
      treeOid: s.treeOid,
      commitOid: s.commitOid,
    }));
    const candidate: Candidate = {
      dir: first.dir,
      baseOid: record.baseOid,
      baseTreeOid: record.baseTreeOid,
      steps,
      tipOid: record.tipOid,
      treeOid: record.treeOid,
    };
    return { record, batch, candidate };
  }
  return undefined;
}

/**
 * The pulls of `batch` the candidate carries. The rest — a conflict with
 * the base or an earlier step, or nothing left to land once the steps
 * before it did — are not this candidate's; the next sweep brings them up
 * to date or closes them as carried.
 */
function inCandidate(batch: readonly Waiting[], candidate: Candidate): Waiting[] {
  const inIt = new Set(candidate.steps.map((s) => s.entry));
  for (const w of batch) if (!inIt.has(w.entry)) w.settle(false);
  return batch.filter((w) => inIt.has(w.entry));
}

/**
 * The first flight's verdict, acted on: green lands it and keeps the
 * flights behind it, anything else discards them back to the line. A
 * speculative flight is settled on the base's tip only when that tip is
 * the tree it was built on — the flight before it landed whole. Returns
 * what waits for the next candidate.
 */
async function settleHead(search: Search, head: Flight, verdict: LandVerdict, ahead: Flight[]): Promise<Waiting[]> {
  let candidate = head.candidate;
  if (head.speculative) {
    const tip = await onTip(candidate, head.branch);
    if (tip === undefined) {
      // What it was stacked on did not land as gated: formed again on main.
      return [...head.steps, ...(await discard(ahead))];
    }
    candidate = { ...candidate, baseOid: tip };
  }
  if (!head.recheck && !("interrupted" in verdict)) {
    search.line.batches.push({ at: Date.now(), red: !verdict.lands });
    try {
      search.onBatch?.(search.line.repoId, !verdict.lands);
    } catch (error) {
      log.warn("batch verdict not kept", { repo: search.line.repoId, error: String(error) });
    }
  }
  if (verdict.lands) {
    if (!head.recheck) adapt(search.line, false);
    if (await land(candidate, head.steps)) return [];
    return discard(ahead);
  }
  const behind = await discard(ahead);
  // The gate was cut off (the forge stopping, the Job lost): nothing is
  // decided and no one is handed back; the next sweep admits them again (#3155).
  if ("interrupted" in verdict) {
    for (const w of head.steps) w.settle(false);
    return behind;
  }
  // A red batch is not formed again around its head (#4999): with a slot
  // free, the head is gated alone beside the line while the rest gate
  // without it. Two steps are the search's own split: the head alone.
  const { line } = search;
  const split =
    !head.recheck && head.steps.length > 2 && suspectOf(line, head.steps[0]!) === undefined && search.room() > 0;
  suspected(line, head.steps, split);
  // A red halves the batch (#6674) — but not a split: its rest gates again
  // as the one batch it was, and halves the size if it is red too.
  if (!head.recheck && !split) adapt(line, true);
  if (split) {
    log.info("red batch: its head is gated alone", {
      repo: line.repoId,
      pull: head.steps[0]!.entry.pull.number,
      rest: head.steps.length - 1,
    });
    return [...head.steps, ...behind];
  }
  const left = await judged(search, candidate, head.steps, verdict, []);
  if (head.steps.some((w) => line.reds.get(w.entry.pull.id)?.head === w.entry.pull.headOid)) explained(line, head.steps);
  return [...left, ...behind];
}

/**
 * The base's tip, when its tree is the one `candidate` was built on:
 * undefined when the base moved elsewhere.
 */
async function onTip(candidate: Candidate, branch: string): Promise<string | undefined> {
  const tip = await resolveOid(candidate.dir, `refs/heads/${branch}`);
  if (tip === undefined) return undefined;
  if (tip === candidate.baseOid) return tip;
  return (await treeOf(candidate.dir, tip)) === candidate.baseTreeOid ? tip : undefined;
}

/**
 * Stop the flights in `ahead` — what they were stacked on did not land —
 * and hand their pulls back for the next candidate, in order.
 */
async function discard(ahead: Flight[]): Promise<Waiting[]> {
  const gone = ahead.splice(0);
  if (gone.length === 0) return [];
  for (const f of gone) f.abort.abort();
  await Promise.all(gone.map((f) => f.verdict));
  log.info("speculative candidates re-formed", {
    pulls: gone.flatMap((f) => f.steps.map((w) => `#${w.entry.pull.number}`)).join(","),
  });
  return gone.flatMap((f) => [...f.steps]);
}

/** What a red candidate's search works with: its line, the gate, the free slots. */
interface Search {
  readonly line: Line;
  readonly gated: Gated;
  readonly room: Room;
  readonly onBatch: ((repoId: string, red: boolean) => void) | undefined;
  readonly onFlake: ((repoId: string, reds: readonly Red[], tip: string) => void) | undefined;
  readonly onVerdict: QueueOptions["onVerdict"];
}

/**
 * Build, gate and land one candidate of `batch` on the base's tip. `known`
 * is a red verdict already read for a tree: a candidate that builds to
 * that same tree is not gated again. `landed` are the pulls of this search
 * that landed onto the base before it. Returns what waits for the next
 * candidate.
 */
async function round(
  search: Search,
  batch: readonly Waiting[],
  known: { treeOid: string; red: Red },
  landed: readonly Queued[],
): Promise<Waiting[]> {
  const { gated } = search;
  const candidate = await build(batch);
  if (candidate === undefined || candidate.steps.length === 0) {
    for (const w of batch) w.settle(false);
    return [];
  }
  const steps = inCandidate(batch, candidate);
  const verdict: LandVerdict =
    known.treeOid === candidate.treeOid ? known.red : await gated(candidate);
  if (search.line.stopped) {
    for (const w of steps) w.settle(false);
    return [];
  }
  if (verdict.lands) {
    await land(candidate, steps);
    return [];
  }
  if ("interrupted" in verdict) {
    for (const w of steps) w.settle(false);
    return [];
  }
  return judged(search, candidate, steps, verdict, landed);
}

/**
 * A red candidate: one step is the culprit, handed back on the base it was
 * red on. More are searched by stacked prefixes (#5994): its steps are cut
 * into runs, one gate per free check slot (at least the front half), and
 * the gates are the candidate's own chain cut short — the first run, the
 * first two, and so on — each on the one before, as the line stacks its
 * candidates. The whole is known red, so it is not gated again. The first
 * red prefix holds a culprit in its last run: every green prefix before it
 * is one piece that lands as it was gated, and that run is searched again on
 * top of it. All green, the culprit is in the last run. The runs after the
 * red one wait, in line order, for the next candidate. No green verdict is
 * thrown away: a disjoint segment gated on the base alone was void once
 * another landed (#6353). A longer prefix green lands whole, even when a
 * shorter one was red: that red was a flake, reported to `onFlake`, and
 * every pull in the green prefix is cleared as a suspect.
 *
 * However few slots are free, a search gates at least √n − 1 prefixes, so
 * the red run holds at most √n steps (#6674): a red batch blocks its line
 * and the flights stacked on it were stopped, so their slots are the
 * search's. That run is then searched by leaving one out (`leftOut`): one
 * gate per step of it, each carrying everything the search has not landed
 * but that step. With one bad pull, 16 red ones land their 15 good in two
 * rounds: 3 prefixes, then 4 gates.
 */
async function judged(
  search: Search,
  candidate: Candidate,
  steps: readonly Waiting[],
  red: Red,
  landed: readonly Queued[],
): Promise<Waiting[]> {
  const { gated, room } = search;
  if (steps.length === 1) {
    const culprit = steps[0]!.entry;
    // Red on top of pulls of its own candidate that landed first: a clash
    // with them, or red on its own — not gated alone on the base before
    // them to tell which. Remembered with them either way (#4235).
    const together = landed.map((q) => q.pull.number);
    markRed(search.line, culprit.pull.id, { head: culprit.pull.headOid, base: candidate.baseOid, together, at: Date.now() });
    search.line.suspects.delete(culprit.pull.id);
    log.info(together.length === 0 ? "red on its own merge" : "red on top of its candidate", {
      repo: search.line.repoId,
      pull: culprit.pull.number,
      ...(together.length === 0 ? {} : { with: together.map((n) => `#${n}`).join(",") }),
    });
    culprit.handBack(red, candidate.baseOid, together);
    told(search.onVerdict, search.line.repoId, {
      kind: "real",
      why: red.reason?.kind ?? "check",
      pull: culprit.pull.number,
      tests: (red.tests?.failing ?? []).map((t) => t.name),
    });
    steps[0]!.settle(false);
    return [];
  }
  const n = steps.length;
  // One gate per free slot and one more, at least the front half and √n − 1
  // prefixes, never the whole: it is known red.
  const free = Math.max(0, room());
  const width = Math.min(n - 1, Math.max(1 + free, Math.ceil(Math.sqrt(n)) - 1));
  const runs = split(steps, width);
  const ends: number[] = [];
  for (const run of runs) ends.push((ends.at(-1) ?? 0) + run.length);
  const prefixes = ends.slice(0, -1).map((end) => prefixOf(candidate, end));
  const verdicts = await Promise.all(prefixes.map((c) => gated(c)));
  if (search.line.stopped || verdicts.some((v) => !v.lands && "interrupted" in v)) {
    for (const w of steps) w.settle(false);
    return [];
  }
  // The prefix after the longest green one, the whole when every gated one
  // was green. A red before that green is a flake: the green holds it.
  const bad = verdicts.findLastIndex((v) => v.lands) + 1;
  const flaked = verdicts.slice(0, bad).filter((v): v is Red => !v.lands && "reopen" in v);
  if (flaked.length > 0) {
    for (const w of steps.slice(0, ends[bad - 1]!)) search.line.suspects.delete(w.entry.pull.id);
    try {
      search.onFlake?.(search.line.repoId, flaked, prefixes[bad - 1]!.tipOid);
    } catch (error) {
      log.warn("flake not kept", { repo: search.line.repoId, error: String(error) });
    }
    told(search.onVerdict, search.line.repoId, {
      kind: "load",
      why: "flake",
      tests: flaked.flatMap((f) => (f.tests?.failing ?? []).map((t) => t.name)),
    });
  }
  const known =
    bad < prefixes.length
      ? { treeOid: prefixes[bad]!.treeOid, red: verdicts[bad] as Red }
      : { treeOid: candidate.treeOid, red };
  const green = bad > 0 ? ends[bad - 1]! : 0;
  if (green > 0) await land(prefixes[bad - 1]!, steps.slice(0, green));
  const now = [...landed, ...steps.slice(0, green).map((w) => w.entry)];
  const after = runs.slice(bad + 1).flat();
  const suspects = runs[bad]!;
  // Leaving one out pays when the run is longer than two: of two, the front
  // one gated alone settles both, in line order.
  if (suspects.length > 2 && suspects.length <= width + 1) {
    const left = await leftOut(search, suspects, after);
    if (left !== undefined) return left;
  }
  const left = await round(search, suspects, known, now);
  return [...left, ...after];
}

/**
 * The red run `suspects` searched by leaving one out (#6674): for each of
 * its steps, everything left of the search but that step — the rest of the
 * run, then `after` — built on the base's tip, all gated at once. The first
 * green one lands, and the step it left out is a suspect gated alone beside
 * the line (#4999), handed back on its own red. Undefined when none is
 * green (more than one bad pull): the run is searched by prefixes as
 * before. Each answer is what waits for the next candidate.
 */
async function leftOut(search: Search, suspects: readonly Waiting[], after: readonly Waiting[]): Promise<Waiting[] | undefined> {
  const { line, gated } = search;
  const tries: { out: Waiting; batch: Waiting[]; candidate: Candidate }[] = [];
  for (const out of suspects) {
    const batch = [...suspects.filter((w) => w !== out), ...after];
    const candidate = await build(batch);
    if (candidate !== undefined && candidate.steps.length > 0) tries.push({ out, batch, candidate });
  }
  const verdicts = await Promise.all(tries.map((t) => gated(t.candidate)));
  if (line.stopped || verdicts.some((v) => !v.lands && "interrupted" in v)) {
    for (const w of [...suspects, ...after]) w.settle(false);
    return [];
  }
  const found = verdicts.findIndex((v) => v.lands);
  if (found < 0) return undefined;
  const { out, batch, candidate } = tries[found]!;
  log.info("red run: every pull but one lands, the one left out is gated alone", {
    repo: line.repoId,
    pull: out.entry.pull.number,
    landing: candidate.steps.length,
  });
  const was = suspectOf(line, out);
  line.suspects.set(out.entry.pull.id, {
    head: out.entry.pull.headOid,
    reds: was?.reds ?? 1,
    alone: true,
    cleared: false,
  });
  const steps = inCandidate(batch, candidate);
  // A step that did not land was settled by `land`; the one left out waits.
  await land(candidate, steps);
  return [out];
}

/** The candidate's chain cut after its first `end` steps: the tree a prefix gates. */
function prefixOf(candidate: Candidate, end: number): Candidate {
  const last = candidate.steps[end - 1]!;
  return { ...candidate, steps: candidate.steps.slice(0, end), tipOid: last.commitOid, treeOid: last.treeOid };
}


/** The steps cut into `k` + 1 runs, evenly, none shared. */
function split<T>(steps: readonly T[], k: number): T[][] {
  const n = steps.length;
  const cuts = [0, ...Array.from({ length: k }, (_, j) => Math.ceil(((j + 1) * n) / (k + 1))), n];
  const runs: T[][] = [];
  for (let i = 0; i + 1 < cuts.length; i++) if (cuts[i + 1]! > cuts[i]!) runs.push(steps.slice(cuts[i], cuts[i + 1]));
  return runs;
}

/**
 * Land each step in order, from the candidate's base; a step that does not
 * land leaves the rest for the line. The last step that did land is
 * released, so a prefix that reached the base is never left without one.
 * Whether every step landed.
 */
async function land(candidate: Candidate, steps: readonly Waiting[]): Promise<boolean> {
  const moved = await movedDisjoint(candidate);
  let at = moved ?? candidate.baseOid;
  let landed: Queued | undefined;
  try {
    for (const [i, step] of candidate.steps.entries()) {
      const w = steps[i]!;
      // On a moved base the tree is the step's merge on the tip it lands on:
      // a clean merge there is the re-verification the move needs.
      const rebased = moved === undefined ? undefined : await mergeable(candidate.dir, at, step.entry.pull.headOid);
      const tip =
        rebased !== undefined && !rebased.ok
          ? undefined
          : await step.entry.land({ baseOid: at, treeOid: rebased?.value.treeOid ?? step.treeOid });
      if (tip === undefined) {
        log.warn("merge queue: a gated step did not land", {
          pull: step.entry.pull.number,
          landed: i,
          of: candidate.steps.length,
        });
        for (const rest of steps.slice(i)) rest.settle(false);
        return false;
      }
      w.settle(true);
      at = tip;
      landed = step.entry;
    }
    return true;
  } finally {
    landed?.release(at);
  }
}

/**
 * The base's tip, when it moved since the candidate was gated and the move
 * touched only the release record, which the candidate does not change: the
 * green gate still speaks for the candidate, so it lands on that tip
 * instead of being voided. Undefined when the base is where it was, or the
 * move overlaps the candidate, or anything cannot be read.
 */
async function movedDisjoint(candidate: Candidate): Promise<string | undefined> {
  const first = candidate.steps[0];
  if (first === undefined) return undefined;
  const { dir } = candidate;
  const tip = await resolveOid(dir, `refs/heads/${first.entry.pull.baseBranch}`);
  if (tip === undefined || tip === candidate.baseOid) return undefined;
  // Only a move forward of the gated base: a rewind is not a move to land on.
  const ahead = await runGit(["merge-base", "--is-ancestor", candidate.baseOid, tip], { cwd: dir });
  if (!ahead.ok) return undefined;
  const theirs = await changedFiles(dir, candidate.baseOid, tip);
  const ours = await changedFiles(dir, candidate.baseOid, candidate.tipOid);
  if (theirs === undefined || ours === undefined) return undefined;
  // Clear of the candidate is not enough: files that share no path can
  // still break each other. Only a move of inert paths keeps the gate.
  if (!theirs.every(inert)) return undefined;
  if (theirs.some((f) => ours.includes(f))) return undefined;
  log.info("merge queue: the base moved clear of the candidate; it lands on the new tip", {
    from: candidate.baseOid.slice(0, 8),
    to: tip.slice(0, 8),
    files: theirs.length,
  });
  return tip;
}

/** The release record: the one file a release cut moves that no gated test depends on. */
function inert(path: string): boolean {
  return path === "src/core/releases.json";
}

/** The paths that differ between two commits, or undefined when git cannot say. */
async function changedFiles(dir: string, from: string, to: string): Promise<string[] | undefined> {
  const out = await runGit(["diff", "--name-only", "-z", "--no-renames", from, to], { cwd: dir });
  if (!out.ok) return undefined;
  return out.value.split("\0").filter((f) => f !== "");
}

/**
 * The candidate of `batch` on its base's tip now — or on `on`'s tip, to
 * gate it ahead of `on` landing: each pull's squash on the step before it.
 * A pull that conflicts, or whose squash changes nothing, is left out.
 * Undefined when the base cannot be read.
 */
async function build(batch: readonly Waiting[], on?: Candidate): Promise<Candidate | undefined> {
  const first = batch[0]?.entry;
  if (first === undefined) return undefined;
  const dir = first.dir;
  const baseOid = on?.tipOid ?? (await resolveOid(dir, `refs/heads/${first.pull.baseBranch}`));
  if (baseOid === undefined) return undefined;
  let tipOid = baseOid;
  const baseTreeOid = on?.treeOid ?? (await treeOf(dir, baseOid));
  if (baseTreeOid === undefined) return undefined;
  let treeOid = baseTreeOid;
  const steps: Step[] = [];
  for (const { entry } of batch) {
    const merged = await mergeable(dir, tipOid, entry.pull.headOid);
    if (!merged.ok) {
      // Left out, never red (#5276): the rest gate without it, and once the
      // pull it clashes with lands, the conflict lane brings it up to date.
      if (merged.error.kind === "conflict")
        log.info(`left out of the batch: ${conflictWords(await clashesWith(dir, baseOid, steps, entry), entry.pull.number)}`, {
          files: merged.error.files.join(","),
        });
      continue;
    }
    if (merged.value.treeOid === treeOid) continue;
    const commit = await runGit(
      ["commit-tree", merged.value.treeOid, "-p", tipOid, "-m", `merge queue: #${entry.pull.number}`],
      { cwd: dir, env: IDENTITY },
    );
    if (!commit.ok) continue;
    const commitOid = commit.value.trim();
    steps.push({ entry, baseOid: tipOid, treeOid: merged.value.treeOid, commitOid });
    tipOid = commitOid;
    treeOid = merged.value.treeOid;
  }
  return { dir, baseOid, baseTreeOid, steps, tipOid, treeOid };
}

/**
 * The earlier step a pull that does not merge onto the chain clashes with:
 * the first whose prefix it does not merge onto. Undefined when it does not
 * merge onto the base itself. Read only on a conflict, so the extra merges
 * cost nothing on a clean batch.
 */
async function clashesWith(dir: string, baseOid: string, steps: readonly Step[], entry: Queued): Promise<number | undefined> {
  if (!(await mergeable(dir, baseOid, entry.pull.headOid)).ok) return undefined;
  for (const step of steps)
    if (!(await mergeable(dir, step.commitOid, entry.pull.headOid)).ok) return step.entry.pull.number;
  return steps.at(-1)?.entry.pull.number;
}
